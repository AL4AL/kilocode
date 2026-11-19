// kilocode_change - new file
import { Effect } from "effect"
import type { LLMEvent } from "@opencode-ai/llm"
import { isRecord } from "@/util/record"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { SessionProcessor } from "@/session/processor"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { nativeTools } from "@/session/llm/native-runtime"
import type { SessionID } from "@/session/schema"
import type { MessageID } from "@/session/schema"
import type { TaskPromptOps } from "@/tool/task"
import type { MemoryMarker } from "@/kilocode/memory/marker"
import { dispatchToolCalls, toolCallsFrom } from "./batch-tool-dispatch"
import { Database } from "@opencode-ai/core/database/database"

const stubOps = {
  cancel: () => Effect.void,
  resolvePromptParts: () => Effect.succeed([]),
  prompt: () => Effect.die(new Error("batch tool replay")),
} as TaskPromptOps

function toolOutput(event: Extract<LLMEvent, { type: "tool-result" }>) {
  if (isRecord(event.result.value) && typeof event.result.value.output === "string") {
    return {
      title: typeof event.result.value.title === "string" ? event.result.value.title : event.name,
      metadata: isRecord(event.result.value.metadata) ? event.result.value.metadata : {},
      output: event.result.value.output,
    }
  }
  return {
    title: event.name,
    metadata: event.result.type === "json" && isRecord(event.result.value) ? event.result.value : {},
    output:
      typeof event.result.value === "string" ? event.result.value : (JSON.stringify(event.result.value) ?? ""),
  }
}

function toolStart(part: MessageV2.ToolPart) {
  if (part.state.status === "running") return part.state.time.start
  return Date.now()
}

export namespace OpenRouterBatchToolReplay {
  export const run = Effect.fn("OpenRouterBatchToolReplay.run")(function* (input: {
    sessionID: SessionID
    assistantMessageID: MessageID
    events: LLMEvent[]
    abort?: AbortSignal
  }) {
    const sessions = yield* Session.Service
    const rows = yield* sessions.messages({ sessionID: input.sessionID })
    const assistant = rows.find((m) => m.info.id === input.assistantMessageID)
    if (!assistant || assistant.info.role !== "assistant") return false

    const calls = toolCallsFrom(input.events)
    if (calls.length === 0) return false

    const hasPending = assistant.parts.some(
      (p) => p.type === "tool" && (p.state.status === "pending" || p.state.status === "running"),
    )
    if (!hasPending) return false

    const assistantInfo = assistant.info
    if (assistantInfo.role !== "assistant") return false
    const parent = assistantInfo.parentID
    if (!parent) return false
    const userRow = rows.find((m) => m.info.id === parent)
    if (!userRow) return false
    const userInfo = userRow.info
    if (userInfo.role !== "user") return false

    const session = yield* sessions.get(input.sessionID)
    const agent = yield* Agent.Service.pipe(Effect.flatMap((a) => a.get(assistantInfo.agent)))
    const model = yield* Provider.Service.pipe(
      Effect.flatMap((p) => p.getModel(userInfo.model.providerID, userInfo.model.modelID)),
    )

    const handle = yield* SessionProcessor.Service.pipe(
      Effect.flatMap((proc) =>
        proc.create({
          assistantMessage: assistantInfo,
          sessionID: input.sessionID,
          model,
        }),
      ),
    )

    const cache = {} as MemoryMarker.Cache
    const toolsMod = yield* Effect.promise(() => import("@/session/tools"))
    const tools = yield* toolsMod.SessionTools.resolve({
      agent,
      session,
      model,
      processor: handle,
      bypassAgentCheck: false,
      messages: rows,
      promptOps: stubOps,
      memoryCache: cache,
    })

    const abort = input.abort ?? new AbortController().signal
    const database = yield* Database.Service
    const modelMsgs = yield* MessageV2.toModelMessagesEffect(rows, model).pipe(
      Effect.provideService(Database.Service, database),
    )
    const runtime = nativeTools(tools, { messages: modelMsgs, abort })

    for (const call of calls) {
      if (!call.id) continue
      yield* handle.updateToolCall(call.id, (part) => {
        if (part.state.status !== "pending") return part
        const raw =
          typeof call.input === "string" ? call.input : JSON.stringify(call.input ?? {})
        return {
          ...part,
          tool: call.name,
          state: {
            status: "running",
            input: isRecord(call.input) ? call.input : { value: call.input },
            raw,
            time: { start: Date.now() },
          },
        }
      })
    }

    const injected = yield* dispatchToolCalls(runtime, calls)

    for (const event of injected) {
      if (event.type === "tool-result") {
        if (event.result.type === "error") {
          yield* handle.updateToolCall(event.id, (part) => ({
            ...part,
            state: {
              status: "error",
              input:
                part.state.status === "running" || part.state.status === "pending"
                  ? part.state.input
                  : {},
              error: String(event.result.value),
              time: { start: toolStart(part), end: Date.now() },
            },
          }))
          continue
        }
        yield* handle.completeToolCall(event.id, toolOutput(event))
      }
      if (event.type === "tool-error") {
        yield* handle.updateToolCall(event.id, (part) => ({
          ...part,
          state: {
            status: "error",
            input:
              part.state.status === "running" || part.state.status === "pending" ? part.state.input : {},
            error: event.message,
            time: { start: toolStart(part), end: Date.now() },
          },
        }))
      }
    }

    return true
  })
}