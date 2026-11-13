// kilocode_change - new file
import type { Tool, ModelMessage } from "ai"
import * as Stream from "effect/Stream"
import { Effect } from "effect"
import type { LLMEvent } from "@opencode-ai/llm"
import { ToolRuntime } from "@opencode-ai/llm"
import { nativeTools } from "@/session/llm/native-runtime"

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
      const tailAt = list.findIndex((event) => event.type === "step-finish")
      const head = tailAt === -1 ? list : list.slice(0, tailAt)
      const tail = tailAt === -1 ? [] : list.slice(tailAt)
      const injected: LLMEvent[] = []
      for (const event of head) {
        if (event.type !== "tool-call" || event.providerExecuted) continue
        const dispatched = yield* ToolRuntime.dispatch(runtime, {
          type: "tool-call",
          id: event.id,
          name: event.name,
          input: event.input,
        })
        injected.push(...dispatched.events)
      }
      return Stream.fromIterable([...head, ...injected, ...tail])
    }),
  )
}
