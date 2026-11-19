import { describe, expect, test } from "bun:test"
import { OpenRouterBatchRetry } from "@/kilocode/openrouter/batch-retry"

describe("OpenRouterBatchRetry.retryableError", () => {
  test("matches unsupported reasoning batch validation", () => {
    expect(
      OpenRouterBatchRetry.retryableError({
        name: "UnknownError",
        data: {
          message:
            "Batch request 'kilo-x' contains unsupported 'reasoning' content. Batch does not support this content.",
        },
      }),
    ).toBe(true)
  })

  test("rejects unrelated errors", () => {
    expect(OpenRouterBatchRetry.retryableError({ name: "UnknownError", data: { message: "rate limited" } })).toBe(
      false,
    )
  })
})