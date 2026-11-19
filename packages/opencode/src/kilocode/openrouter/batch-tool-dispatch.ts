// kilocode_change - new file
import type { Tool, ModelMessage } from "ai"
import * as Stream from "effect/Stream"
import { Effect } from "effect"
import type { LLMEvent } from "@opencode-ai/llm"
import { ToolRuntime } from "@opencode-ai/llm"
import type { Tools } from "@opencode-ai/llm"
import { nativeTools } from "@/session/llm/native-runtime"

export function eventsBeforeStepFinish(events: readonly LLMEvent[]) {
  const tailAt = events.findIndex((event) => event.type === "step-finish")
  if (tailAt === -1) return [...events]
  return events.slice(0, tailAt)
}

export function toolCallsFrom(events: readonly LLMEvent[]) {
  return eventsBeforeStepFinish(events).filter(
    (event): event is Extract<LLMEvent, { type: "tool-call" }> =>
      event.type === "tool-call" && !event.providerExecuted,
  )
}

export const dispatchToolCalls = Effect.fn("OpenRouterBatch.dispatchToolCalls")(function* (
  runtime: Tools,
  calls: readonly Extract<LLMEvent, { type: "tool-call" }>[],
) {
  const injected: LLMEvent[] = []
  for (const event of calls) {
    const dispatched = yield* ToolRuntime.dispatch(runtime, {
      type: "tool-call",
      id: event.id,
      name: event.name,
      input: event.input,
    })
    injected.push(...dispatched.events)
  }
  return injected
})

/** OpenRouter batch completions emit tool-call events without executing them; mirror the native LLM runtime. */
export function withToolDispatch(
  source: Stream.Stream<LLMEvent, unknown>,
  tools: Record<string, Tool>,
  input: { messages: ModelMessage[]; abort: AbortSignal },
) {
  const runtime = nativeTools(tools, input)
  return Stream.unwrap(
    Effect.gen(function* () {
      const events = yield* Stream.runCollect(source)
      const list = [...events]
      const head = eventsBeforeStepFinish(list)
      const tailAt = list.findIndex((event) => event.type === "step-finish")
      const tail = tailAt === -1 ? [] : list.slice(tailAt)
      const injected = yield* dispatchToolCalls(runtime, toolCallsFrom(list))
      return Stream.fromIterable([...head, ...injected, ...tail])
    }),
  )
}