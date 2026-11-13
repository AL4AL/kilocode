import { describe, expect, test } from "bun:test"
import { assertSendAllowed, ReasoningOutputBudgetError } from "@/kilocode/session/reasoning-output-guard"
import type { Provider } from "@/provider/provider"

const model = {
  limit: { context: 128_000, output: 32_000 },
} as Provider.Model

describe("reasoning output guard", () => {
  test("allows when headroom sufficient", () => {
    expect(() =>
      assertSendAllowed({
        model,
        messages: [{ role: "user", content: "hi" }],
        tools: {},
        configured: 16_000,
        options: { openrouter: { reasoning: { effort: "low" } } },
      }),
    ).not.toThrow()
  })

  test("blocks when math leaves tiny headroom", () => {
    const big = "x".repeat(120_000)
    expect(() =>
      assertSendAllowed({
        model,
        messages: [{ role: "user", content: big }],
        tools: {},
        configured: 1024,
        options: { openrouter: { reasoning: { effort: "max" } } },
      }),
    ).toThrow(ReasoningOutputBudgetError)
  })
})
