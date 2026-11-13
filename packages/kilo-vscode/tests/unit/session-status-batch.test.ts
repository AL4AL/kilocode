import { describe, expect, test } from "bun:test"
import { clientSessionStatus, isRunningStatus, seedSessionStatuses } from "../../src/session-status"

describe("waiting_batch status", () => {
  test("counts as running", () => {
    expect(isRunningStatus("waiting_batch")).toBe(true)
    expect(isRunningStatus("busy")).toBe(true)
    expect(isRunningStatus(undefined)).toBe(false)
  })

  test("clientSessionStatus preserves waiting_batch payload", () => {
    const raw = {
      type: "waiting_batch" as const,
      batchId: "batch_x",
      customId: "kilo-msg",
      modelId: "anthropic/claude-haiku-5.5-batch",
    }
    expect(clientSessionStatus(raw)).toEqual(raw)
  })

  test("seedSessionStatuses posts batch fields", async () => {
    const map = new Map<string, string>()
    const posts: unknown[] = []
    await seedSessionStatuses(
      {
        session: {
          status: async () => ({
            data: {
              ses_1: {
                type: "waiting_batch",
                batchId: "batch_seed",
                customId: "kilo-1",
                modelId: "m-batch",
              },
            },
          }),
        },
      } as never,
      "/tmp",
      map,
      (msg) => posts.push(msg),
      false,
    )
    expect(map.get("ses_1")).toBe("waiting_batch")
    expect(posts[0]).toMatchObject({
      type: "sessionStatus",
      sessionID: "ses_1",
      status: "waiting_batch",
      batchId: "batch_seed",
      modelId: "m-batch",
    })
  })
})
