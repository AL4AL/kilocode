// kilocode_change - new file
import { Effect } from "effect"
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import type { ProviderMetadata } from "ai"
import { KiloSession } from "@/kilocode/session"
import { getUsage, Session } from "@/session/session"
import { PartID } from "@/session/schema"
import type { SessionID } from "@/session/schema"
import type { MessageID } from "@/session/schema"
import type { Provider } from "@/provider/provider"
import { OpenRouterBatchStore } from "./batch-store"

type StepFinish = Extract<LLMEvent, { type: "step-finish" }>

function stepFinish(events: LLMEvent[]) {
  const step = [...events].reverse().find((e) => e.type === "step-finish")
  return step?.type === "step-finish" ? step : undefined
}

/** OpenRouter batch completions bill below catalog; never guess with models.dev pricing on backfill. */
function usageForBackfill(model: Provider.Model, step: StepFinish) {
  const meta = step.providerMetadata as ProviderMetadata | undefined
  const raw = step.usage ?? Usage.from({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  const reported = KiloSession.providerCost({
    metadata: meta,
    usage: raw,
    providerID: model.providerID,
  })
  const calc = getUsage({ model, usage: raw, metadata: meta })
  const batch = model.openrouterBatch === true
  return {
    cost: reported ?? (batch ? 0 : calc.cost),
    tokens: calc.tokens,
    reported: reported !== undefined,
  }
}

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
  const assistant = [...rows]
    .reverse()
    .find(
      (m) =>
        m.info.role === "assistant" &&
        m.info.parentID === input.userMessageID &&
        !m.parts.some((p) => p.type === "text" || p.type === "reasoning"),
    )
  if (!assistant || assistant.info.role !== "assistant") return false

  const step = stepFinish(input.events)
  const tokensIn = assistant.info.tokens?.input ?? 0
  if (assistant.info.finish != null && tokensIn > 0) {
    if (step) {
      const usage = usageForBackfill(input.model, step)
      if (usage.reported && assistant.info.cost > usage.cost + 1e-6) {
        const msg = assistant.info
        msg.cost = usage.cost
        yield* sessions.updateMessage(msg)
        return true
      }
    }
    return false
  }

  const callIds = new Set(
    assistant.parts
      .filter((p) => p.type === "tool")
      .map((p) => p.callID)
      .filter((id): id is string => id != null && id !== ""),
  )

  let text = ""
  for (const event of input.events) {
    if (event.type === "text-delta") text += event.text
    if (event.type === "tool-call") {
      if (event.id && callIds.has(event.id)) continue
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
      if (event.id) callIds.add(event.id)
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

  if (step) {
    const usage = usageForBackfill(input.model, step)
    const msg = assistant.info
    msg.error = undefined
    msg.finish = step.reason
    msg.cost = usage.cost
    msg.tokens = usage.tokens
    msg.time = { ...msg.time, completed: Date.now() }
    yield* sessions.updateMessage(msg)
  }

  for (const row of rows) {
    if (row.info.role !== "assistant" || row.info.parentID !== input.userMessageID) continue
    if (row.info.id === assistant.info.id) continue
    if (!row.info.error) continue
    if (row.parts.some((p) => p.type === "text" || p.type === "reasoning")) continue
    const stale = row.info
    stale.error = undefined
    yield* sessions.updateMessage(stale)
  }

  OpenRouterBatchStore.clear(`kilo-${input.userMessageID}`)
  return true
})
}
