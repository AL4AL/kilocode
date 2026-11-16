import { Effect, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Provider, parseModel } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { LLM } from "@/session/llm"
import { FanoutStore } from "./store"
import { toolTitle } from "./run"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "fanout-title" })
const inflight = new Set<string>()
const CAP = 2

export function titleBusy() {
  return inflight.size >= CAP
}

/** Hold a title slot before the model call so the cap survives overlapping sweeps. */
export function reserve(jobID: string) {
  if (inflight.has(jobID) || inflight.size >= CAP) return false
  inflight.add(jobID)
  return true
}

export function release(jobID: string) {
  inflight.delete(jobID)
}

function line(text: string) {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.length > 0)
}

export const refresh = Effect.fn("Fanout.refreshTitle")(function* (input: { scriptID: string; jobID: string }) {
  const held = inflight.has(input.jobID)
  if (!held && !reserve(input.jobID)) return
  const script = FanoutStore.get(input.scriptID)
  const job = script?.jobs.find((item) => item.id === input.jobID)
  if (!script || !job || job.status === "done" || job.status === "failed") {
    release(input.jobID)
    return
  }
  const cfg = yield* (yield* Config.Service).get()
  if (!cfg.small_model) return
  const agents = yield* Agent.Service
  const agent = yield* agents.get("title")
  if (!agent) return
  const provider = yield* Provider.Service
  const parsed = parseModel(cfg.small_model)
  const model = yield* provider.getModel(parsed.providerID, parsed.modelID).pipe(
    Effect.catchTag("ProviderModelNotFoundError", (err) =>
      Effect.sync(() => {
        log.warn("small model is not available", { err, model: cfg.small_model })
        return undefined
      }),
    ),
  )
  if (!model) return

  const sessions = yield* Session.Service
  const child = job.sessionId ? yield* sessions.messages({ sessionID: SessionID.make(job.sessionId) }) : []
  const step = toolTitle(child)
  const mark = step ? `${step.tool}:${step.title}` : "prompt"
  if (job.title && job.mark === mark) {
    release(input.jobID)
    return
  }
  const history = yield* sessions.messages({ sessionID: SessionID.make(script.parentID) })
  const user = history.findLast((msg): msg is SessionV1.WithParts & { info: SessionV1.User } => msg.info.role === "user")
  if (!user) {
    release(input.jobID)
    return
  }

  yield* Effect.gen(function* () {
    const llm = yield* LLM.Service
    const excerpt = step?.title ?? ""
    const text = yield* llm
      .stream({
        agent,
        user: user.info,
        system: [],
        small: true,
        tools: {},
        model,
        sessionID: `fanout-title-${input.jobID}`,
        retries: 2,
        messages: [
          {
            role: "user",
            content: [
              "Name the work this agent is doing right now.",
              "One short line, under 12 words. No quotes.",
              "",
              "Assigned work:",
              job.prompt.slice(0, 1_000),
              "",
              excerpt ? `Latest step: ${step?.tool ?? ""} ${excerpt}` : "Latest step: not started",
            ].join("\n"),
          },
        ],
      })
      .pipe(
        Stream.filter(LLMEvent.is.textDelta),
        Stream.map((event) => event.text),
        Stream.mkString,
        Effect.orDie,
      )
    const title = line(text)
    if (!title) return
    yield* Effect.promise(() => FanoutStore.patch(script.id, job.id, { title, mark }))
    if (job.sessionId) yield* sessions.setTitle({ sessionID: SessionID.make(job.sessionId), title })
  }).pipe(
    Effect.ensuring(Effect.sync(() => inflight.delete(input.jobID))),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        log.warn("fan-out title failed", { err: cause, job: job.id })
      }),
    ),
  )
})
