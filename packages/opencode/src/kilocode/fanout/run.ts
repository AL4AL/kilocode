import { Cause, Effect } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { MessageID, SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { KiloSession } from "@/kilocode/session"
import { KiloSessionContinuation } from "@/kilocode/session/continuation"
import { SessionDrain } from "@/kilocode/session/drain"
import { KiloTask } from "@/kilocode/tool/task"
import * as SandboxPolicy from "@/kilocode/sandbox/policy"
import { OpenRouterBatchStore } from "@/kilocode/openrouter/batch-store"
import { Worktree } from "@/worktree"
import { errorMessage } from "@/util/error"
import * as Log from "@opencode-ai/core/util/log"
import { FanoutStore, MAX_JOB_ATTEMPTS, type Job, type Script } from "./store"

const log = Log.create({ service: "fanout" })
const CHILD = "general"
const REPORT_CHARS = 8_000

function body(job: Job) {
  const lines = [job.prompt]
  if (job.paths.length > 0) lines.push("", "Only change these paths:", ...job.paths.map((item) => `- ${item}`))
  if (job.directory) lines.push("", `Work only inside ${job.directory}.`)
  return lines.join("\n")
}

function reply(messages: SessionV1.WithParts[]) {
  const last = messages.findLast((msg) => msg.info.role === "assistant")
  if (!last || last.info.role !== "assistant") return ""
  const part = last.parts.findLast(
    (item) => item.type === "text" && !item.synthetic && !item.ignored && item.text.trim().length > 0,
  )
  return part?.type === "text" ? part.text : ""
}

function unfinished(messages: SessionV1.WithParts[]) {
  const last = messages.findLast((msg) => msg.info.role === "assistant")
  if (!last) return false
  return last.parts.some(
    (part) => part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error",
  )
}

function failedText(messages: SessionV1.WithParts[]) {
  const last = messages.findLast((msg) => msg.info.role === "assistant")
  if (!last || last.info.role !== "assistant" || !last.info.error) return
  if (MessageV2.AbortedError.isInstance(last.info.error)) return
  return errorMessage(last.info.error)
}

const climb = (sessions: Session.Interface, id: SessionID, n: number): Effect.Effect<number> =>
  Effect.gen(function* () {
    const session = yield* sessions.get(id).pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
    if (!session?.parentID) return n
    return yield* climb(sessions, session.parentID, n + 1)
  })

function report(script: Script, job: Job, status: "done" | "failed", text: string) {
  const id = crypto.randomUUID()
  const clipped = text.slice(0, REPORT_CHARS)
  return FanoutStore.pushReport(script.id, {
    id,
    jobID: job.id,
    sessionId: job.sessionId,
    status,
    text: `${clipped}\n\nfanout-report:${id}`,
    at: Date.now(),
  })
}

export const launch = Effect.fn("Fanout.launch")(function* (input: { scriptID: string; jobID: string }) {
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const agents = yield* Agent.Service
  const config = yield* Config.Service
  const provider = yield* Provider.Service
  const drain = yield* SessionDrain.Service
  const worktrees = yield* Worktree.Service
  const script = FanoutStore.get(input.scriptID)
  const job = script?.jobs.find((item) => item.id === input.jobID)
  if (!script || !job) return
  if (job.sessionId && OpenRouterBatchStore.bySession(SessionID.make(job.sessionId)).length > 0) return

  const parent = yield* sessions.get(SessionID.make(script.parentID))
  if (!parent.model) return yield* Effect.fail(new Error("Parent session has no model"))
  const cfg = yield* config.get()
  const depth = yield* climb(sessions, parent.id, 0)
  if (depth >= (cfg.subagent_depth ?? 1)) return yield* Effect.fail(new Error("Subagent depth limit reached"))
  const agent = yield* agents.get(CHILD)
  if (!agent) return yield* Effect.fail(new Error(`Unknown agent type: ${CHILD}`))
  KiloTask.validate(agent, CHILD)

  const caller = yield* agents.get(script.agent)
  if (!caller) return yield* Effect.fail(new Error(`Unknown agent type: ${script.agent}`))
  const selected = yield* KiloTask.resolveModel({
    name: agent.name,
    agent,
    config: cfg,
    parent: { providerID: parent.model.providerID, modelID: parent.model.id },
    variant: parent.model.variant,
    provider,
  })
  const canTask = depth + 1 < (cfg.subagent_depth ?? 1)
  const rules = KiloTask.inherited({ caller, session: parent, mcp: cfg.mcp })
  const permission = KiloTask.merge(
    deriveSubagentSessionPermission({
      parentSessionPermission: parent.permission ?? [],
      subagent: agent,
    }),
    cfg.experimental?.primary_tools?.map((item) => ({
      permission: item,
      pattern: "*",
      action: "deny" as const,
    })) ?? [],
    KiloTask.permissions(rules, canTask),
    canTask ? [] : [{ permission: "spawn_script", pattern: "*", action: "deny" as const }],
  )

  const isolated = job.isolate
  const directory = job.directory
  if (isolated && !directory) {
    const info = yield* worktrees.create({ name: `fanout-${job.id.slice(0, 12)}` })
    yield* Effect.promise(() => FanoutStore.patch(script.id, job.id, { directory: info.directory }))
    return { directory: info.directory }
  }

  const session =
    job.sessionId !== undefined
      ? yield* sessions.get(SessionID.make(job.sessionId))
      : yield* sessions.create({
          parentID: parent.id,
          title: `${job.title ?? job.label} (@${agent.name} subagent)`,
          agent: agent.name,
          platform: KiloSession.resolvePlatform(parent.id),
          permission,
        })
  if (!job.sessionId) {
    KiloSession.register({ id: session.id, parentID: parent.id, platform: KiloSession.resolvePlatform(parent.id) })
    yield* drain.link(session.id, parent.id)
    yield* SandboxPolicy.inherit(parent.id, session.id, SandboxPolicy.fallback(cfg), script.directory).pipe(
      Effect.provideService(Config.Service, config),
    )
    yield* Effect.promise(() =>
      FanoutStore.patch(script.id, job.id, { sessionId: session.id, status: "running", attempt: job.attempt + 1 }),
    )
  }

  const promptChild = Effect.fn("Fanout.promptChild")(function* () {
    const parts = yield* prompts.resolvePromptParts(body({ ...job, sessionId: session.id, directory: directory ?? job.directory }))
    yield* prompts.prompt({
      messageID: MessageID.ascending(),
      sessionID: session.id,
      model: {
        providerID: ProviderV2.ID.make(selected.model.providerID),
        modelID: ModelV2.ID.make(selected.model.modelID),
      },
      variant: selected.variant,
      agent: agent.name,
      tools: {
        question: false,
        todowrite: false,
        ...(canTask ? {} : { task: false, spawn_script: false }),
      },
      parts,
    })
  })

  const step = Effect.fn("Fanout.step")(function* () {
    const messages = yield* sessions.messages({ sessionID: session.id })
    if (OpenRouterBatchStore.bySession(session.id).length > 0) return true
    const error = failedText(messages)
    if (error) {
      yield* settleFailure(script, { ...job, sessionId: session.id }, session.id, error)
      return true
    }
    const resumeID = KiloSessionContinuation.target(messages)
    if (resumeID) {
      yield* prompts.loop({ sessionID: session.id, resume: resumeID })
      yield* drain.wait(session.id)
      return false
    }
    if (unfinished(messages)) {
      yield* prompts.loop({ sessionID: session.id })
      yield* drain.wait(session.id)
      return false
    }
    const users = messages.filter((msg) => msg.info.role === "user")
    if (users.length === 0) {
      yield* promptChild().pipe(Effect.catchCause(Effect.failCause))
      yield* drain.wait(session.id)
      return false
    }
    const text = reply(messages)
    yield* Effect.promise(() =>
      FanoutStore.patch(script.id, job.id, { status: "done", output: text, sessionId: session.id }),
    )
    yield* Effect.promise(() => report(script, { ...job, sessionId: session.id }, "done", text))
    return true
  })

  yield* Effect.gen(function* () {
    for (const _ of [0, 1, 2, 3]) {
      if (yield* step()) return
    }
  }).pipe(
    Effect.catchCause((cause) => {
      if (OpenRouterBatchStore.bySession(session.id).length > 0) return Effect.void
      log.error("fan-out child failed", { err: Cause.pretty(cause), job: job.id })
      return settleFailure(script, { ...job, sessionId: session.id }, session.id, Cause.pretty(cause))
    }),
  )
})

function settleFailure(script: Script, job: Job, sessionId: SessionID, text: string) {
  const attempt = job.attempt + 1
  if (attempt < MAX_JOB_ATTEMPTS) {
    return Effect.promise(() =>
      FanoutStore.patch(script.id, job.id, { status: "pending", attempt, error: text, sessionId }),
    )
  }
  return Effect.promise(() =>
    FanoutStore.patch(script.id, job.id, { status: "failed", attempt, error: text, sessionId }).then(() =>
      report(script, { ...job, sessionId }, "failed", text),
    ),
  )
}

export const deliver = Effect.fn("Fanout.deliver")(function* (scriptID: string) {
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const status = yield* SessionStatus.Service
  const script = FanoutStore.get(scriptID)
  if (!script || script.stopped) return
  const report = script.inbox.at(script.cursor)
  if (!report) return
  const parent = SessionID.make(script.parentID)
  const current = yield* status.get(parent)
  if (current.type !== "idle") return
  if (OpenRouterBatchStore.bySession(parent).length > 0) return
  const messages = yield* sessions.messages({ sessionID: parent })
  const seen = messages.some((msg) => msg.parts.some((part) => part.type === "text" && part.text.includes(report.id)))
  if (seen) {
    yield* Effect.promise(() => FanoutStore.ack(script.id))
    return
  }
  const session = yield* sessions.get(parent)
  yield* prompts.prompt({
    sessionID: parent,
    agent: session.agent ?? script.agent,
    model: session.model
      ? { providerID: session.model.providerID, modelID: session.model.id }
      : undefined,
    variant: session.model?.variant,
    parts: [
      {
        type: "text",
        synthetic: true,
        text: report.text,
      },
    ],
  })
  yield* Effect.promise(() => FanoutStore.ack(script.id))
})

export const wake = Effect.fn("Fanout.wake")(function* (input: { scriptID: string; jobID: string }) {
  const sessions = yield* Session.Service
  const prompts = yield* SessionPrompt.Service
  const status = yield* SessionStatus.Service
  const script = FanoutStore.get(input.scriptID)
  const job = script?.jobs.find((item) => item.id === input.jobID)
  const pending = job?.box?.filter((item) => item.state === "open" && !item.woke) ?? []
  if (!script || !job?.sessionId || (pending.length === 0 && !job.notice)) return
  const current = yield* status.get(SessionID.make(job.sessionId))
  if (current.type !== "idle") return
  const session = yield* sessions.get(SessionID.make(job.sessionId))
  const text = [
    ...pending.map((item) => `Scope request ${item.id}: ${item.ask}\nAnswer with scope_reply id=${item.id}.`),
    ...(job.notice ? [job.notice] : []),
  ].join("\n\n")
  yield* prompts.prompt({
    sessionID: session.id,
    agent: session.agent,
    model: session.model ? { providerID: session.model.providerID, modelID: session.model.id } : undefined,
    parts: [{ type: "text", synthetic: true, text }],
  })
  for (const item of pending) yield* Effect.promise(() => FanoutStore.markMail(script.id, job.id, item.id))
  if (job.notice) yield* Effect.promise(() => FanoutStore.clearNotice(script.id, job.id))
})

export const publish = Effect.fn("Fanout.publish")(function* (scriptID: string) {
  const sessions = yield* Session.Service
  const script = FanoutStore.get(scriptID)
  if (!script?.messageID || !script.callID) return
  const counts = FanoutStore.counts(scriptID)
  const key = `${counts.pending}:${counts.running}:${counts.done}:${counts.failed}`
  if (script.published === key) return
  const messages = yield* sessions.messages({ sessionID: SessionID.make(script.parentID) })
  const message = messages.find((item) => item.info.id === script.messageID)
  const part = message?.parts.find((item) => item.type === "tool" && item.callID === script.callID)
  if (!part || part.type !== "tool" || part.state.status !== "completed") return
  yield* sessions.updatePart({
    ...part,
    state: {
      ...part.state,
      metadata: {
        ...part.state.metadata,
        scriptId: script.id,
        pending: counts.pending,
        running: counts.running,
        done: counts.done,
        failed: counts.failed,
      },
    },
  })
  yield* Effect.promise(() => FanoutStore.patchScript(script.id, { partID: part.id, published: key }))
})

export function toolTitle(messages: SessionV1.WithParts[]) {
  const last = messages.findLast((msg) => msg.info.role === "assistant")
  if (!last) return
  const part = last.parts.findLast((item) => item.type === "tool")
  if (!part || part.type !== "tool") return
  if (part.state.status !== "running" && part.state.status !== "completed") return
  if (!part.state.title) return
  return { tool: part.tool, title: part.state.title }
}
