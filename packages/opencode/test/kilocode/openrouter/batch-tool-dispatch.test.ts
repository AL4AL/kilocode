import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent, Tool as NativeTool } from "@opencode-ai/llm"
import { dispatchToolCalls, eventsBeforeStepFinish, toolCallsFrom } from "@/kilocode/openrouter/batch-tool-dispatch"

describe("batch tool dispatch", () => {
  test("eventsBeforeStepFinish splits at step-finish", () => {
    const events = [
      LLMEvent.textDelta({ id: "t1", text: "hi" }),
      LLMEvent.toolCall({ id: "tc1", name: "echo", input: { x: 1 } }),
      LLMEvent.stepFinish({ reason: "tool-calls", index: 0, usage: { inputTokens: 1, outputTokens: 1 } }),
    ]
    expect(eventsBeforeStepFinish(events).map((e) => e.type)).toEqual(["text-delta", "tool-call"])
    expect(toolCallsFrom(events)).toHaveLength(1)
  })

  test("dispatchToolCalls runs native tool", async () => {
    const echo = NativeTool.make({
      description: "echo",
      jsonSchema: { type: "object", properties: { x: { type: "number" } } },
      execute: (args: unknown) =>
        Effect.succeed(typeof args === "object" && args != null && "x" in args ? `got ${(args as { x: number }).x}` : "bad"),
    })
    const calls = [LLMEvent.toolCall({ id: "tc_echo", name: "echo", input: { x: 2 } })]
    const out = await Effect.runPromise(dispatchToolCalls({ echo }, calls))
    const result = out.find((e) => e.type === "tool-result")
    expect(result?.type).toBe("tool-result")
    if (result?.type !== "tool-result") return
    expect(result.result.type).not.toBe("error")
  })
})