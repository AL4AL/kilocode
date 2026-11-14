// kilocode_change - new file
import { Effect } from "effect"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import { getUsage, Session } from "@/session/session"
import { PartID } from "@/session/schema"
import type { SessionID } from "@/session/schema"
import type { MessageID } from "@/session/schema"
import type { Provider } from "@/provider/provider"
import { OpenRouterBatchStore } from "./batch-store"

export namespace OpenRouterBatchBackfill {
/** Apply batch completion events when the live processor is not attached (serve restart). */
export const apply = Effect.fn("OpenRouterBatchBackfill.apply")(function* (input: {
  sessionID: SessionID
  userMessageID: MessageID
  model: Provider.Model
  events: LLMEvent[]
}) {
  const sessions = yield* Session.Service
  const rows = yield* sessions.messages({ sessionID: input.sessionID })
  const user = rows.find((m) => m.info.id === input.userMessageID)
  if (!user || user.info.role !== "user") return false
  const assistant = rows.find((m) => m.info.role === "assistant" && m.info.parentID === input.userMessageID)
  if (!assistant || assistant.info.role !== "assistant") return false
  if (assistant.info.time.completed != null) return false
  if (assistant.parts.some((p) => p.type === "text" || p.type === "reasoning")) return false

  let text = ""
  for (const event of input.events) {
    if (event.type === "text-delta") text += event.text
    if (event.type === "tool-call") {
      const now = Date.now()
      const raw =
        typeof event.input === "string" ? event.input : JSON.stringify(event.input ?? {})
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: assistant.info.id,
        sessionID: input.sessionID,
        type: "tool",
        tool: event.name,
        callID: event.id,
        state: { status: "pending", input: event.input ?? {}, raw },
      })
    }
  }
  if (text.trim()) {
    const now = Date.now()
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: assistant.info.id,
      sessionID: input.sessionID,
      type: "text",
      text,
      time: { start: now, end: now },
    })
  }

  const step = [...input.events].reverse().find((e) => e.type === "step-finish")
  if (step?.type === "step-finish") {
    const usage = getUsage({
      model: input.model,
      usage: step.usage ?? Usage.from({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      metadata: step.providerMetadata,
    })
    const msg = assistant.info
    msg.finish = step.reason
    msg.cost += usage.cost
    msg.tokens = usage.tokens
    msg.time = { ...msg.time, completed: Date.now() }
    yield* sessions.updateMessage(msg)
  }

  OpenRouterBatchStore.clear(`kilo-${input.userMessageID}`)
  return true
})
}
