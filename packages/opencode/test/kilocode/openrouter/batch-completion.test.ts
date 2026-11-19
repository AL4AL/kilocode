import { describe, expect, test } from "bun:test"
import { fromResult } from "@/kilocode/openrouter/batch-completion"

describe("batch completion events", () => {
  test("maps assistant text", () => {
    const events = fromResult({
      custom_id: "x",
      response: {
        status_code: 200,
        body: {
          choices: [{ finish_reason: "stop", message: { content: "hello" } }],
        },
      },
    })
    expect(events.some((e) => e.type === "text-delta" && e.type === "text-delta" ? e.text === "hello" : false)).toBe(true)
    expect(events.at(-1)?.type).toBe("finish")
  })

  test("maps openrouter cost metadata", () => {
    const events = fromResult({
      custom_id: "x",
      response: {
        status_code: 200,
        body: {
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0012 },
        },
      },
    })
    const step = events.find((e) => e.type === "step-finish")
    const or =
      step?.type === "step-finish"
        ? (step.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined)
        : undefined
    expect(or?.usage?.cost).toBe(0.0012)
  })

  test("rejects empty completion with body error", () => {
    expect(() =>
      fromResult({
        custom_id: "x",
        response: {
          status_code: 200,
          body: { error: { message: "Upstream provider error" } },
        },
      }),
    ).toThrow("Upstream provider error")
  })

  test("maps tool calls", () => {
    const events = fromResult({
      custom_id: "x",
      response: {
        status_code: 200,
        body: {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [{ id: "tc1", function: { name: "read", arguments: "{}" } }],
              },
            },
          ],
        },
      },
    })
    expect(events.some((e) => e.type === "tool-call" && e.name === "read")).toBe(true)
  })
})
