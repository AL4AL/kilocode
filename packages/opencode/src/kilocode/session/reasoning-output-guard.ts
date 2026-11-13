// kilocode_change - new file
import type { ModelMessage } from "ai"
import { NamedError } from "@opencode-ai/core/util/error"
import { Schema } from "effect"
import type { Provider } from "@/provider/provider"
import { KiloLLM } from "./llm"
import { KiloSessionOverflow } from "./overflow"

const MIN_ANSWER = 1024

const EFFORT_RESERVE: Record<string, number> = {
  none: 0,
  low: 512,
  medium: 2048,
  high: 4096,
  xhigh: 8192,
  max: 12_000,
}

export const ReasoningOutputBudgetError = NamedError.create(
  "ReasoningOutputBudgetError",
  Schema.Struct({
    message: Schema.String,
    maxOut: Schema.Number,
    thinkingReserve: Schema.Number,
    answerHeadroom: Schema.Number,
  }),
)

function effortReserve(options: Record<string, unknown>) {
  const openrouter = options.openrouter as { reasoning?: { effort?: string } } | undefined
  const effort =
    (openrouter?.reasoning && "effort" in openrouter.reasoning ? openrouter.reasoning.effort : undefined) ??
    (typeof options.reasoningEffort === "string" ? options.reasoningEffort : undefined) ??
    (typeof options.effort === "string" ? options.effort : undefined) ??
    "medium"
  return EFFORT_RESERVE[effort] ?? EFFORT_RESERVE.medium
}

export function assertSendAllowed(input: {
  model: Provider.Model
  messages: ModelMessage[]
  tools: Record<string, { description?: string; inputSchema?: unknown }>
  configured: number | undefined
  options: Record<string, unknown>
  reported?: number
}) {
  const context = input.model.limit.context
  if (!context || input.configured == null || input.configured <= 0) return

  const usage = KiloSessionOverflow.measure({ messages: input.messages, tools: input.tools })
  const maxOut = KiloLLM.capOutputTokens({
    model: input.model,
    messages: input.messages,
    tools: input.tools,
    configured: input.configured,
    usage,
    reported: input.reported,
  })
  if (maxOut == null) return

  const thinkingReserve = effortReserve(input.options)
  const answerHeadroom = maxOut - thinkingReserve
  if (answerHeadroom >= MIN_ANSWER) return

  throw new ReasoningOutputBudgetError({
    message: `Not enough output headroom for this reasoning level (maxOut=${maxOut}, thinkingReserve=${thinkingReserve}, answerHeadroom=${answerHeadroom}). Lower reasoning effort, compact the session, or shorten the prompt.`,
    maxOut,
    thinkingReserve,
    answerHeadroom,
  })
}
