import { describe, expect, test } from "bun:test"
import * as Stream from "effect/Stream"
import { Effect } from "effect"
import { fromResult } from "@/kilocode/openrouter/batch-completion"
import { withToolDispatch } from "@/kilocode/openrouter/batch-tool-dispatch"

describe("batch tool dispatch", () => {
  test("runs tools before step-finish when batch emits a single burst", async () => {
    const item = {
      custom_id: "kilo-u",
      response: {
        status_code: 200,
        body: {
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [{ id: "call_x", function: { name: "missing", arguments: "{}" } }],
              },
            },
          ],
        },
      },
    }
    const source = Stream.fromIterable(fromResult(item))
    const stream = withToolDispatch(source, {}, { messages: [], abort: new AbortController().signal })
    const types = await Effect.runPromise(stream.pipe(Stream.map((e) => e.type), Stream.runCollect))
    const order = [...types]
    const finish = order.indexOf("step-finish")
    const result = order.indexOf("tool-result")
    expect(result).toBeGreaterThan(-1)
    expect(finish).toBeGreaterThan(result)
  })
})
