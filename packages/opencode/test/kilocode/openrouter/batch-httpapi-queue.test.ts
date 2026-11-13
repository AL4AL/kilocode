import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionID, MessageID } from "@/session/schema"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"

/**
 * HTTP `DELETE ...?queued=true` delegates to KiloSessionPromptQueue.drop while
 * the session is in waiting_batch (HL-4 integration covers the live path).
 * This unit guard keeps the API contract aligned with the queue helper.
 */
describe("batch httpapi queue drop", () => {
  test("drop rejects active message ids but removes queued ids", async () => {
    const sessionID = SessionID.make("ses_httpapi_batch")
    const active = MessageID.make("msg_active")
    const queued = MessageID.make("msg_queued")
    const slot = Effect.gen(function* () {
      yield* Effect.promise(() => new Promise((r) => setTimeout(r, 500)))
      return "done"
    })
    const cancel = Effect.succeed("cancelled" as const)
    void Effect.runPromise(KiloSessionPromptQueue.enqueue(sessionID, active, slot, cancel))
    void Effect.runPromise(KiloSessionPromptQueue.enqueue(sessionID, queued, slot, cancel))
    await Effect.runPromise(
      Effect.promise(async () => {
        const deadline = Date.now() + 2000
        while (Date.now() < deadline) {
          if (KiloSessionPromptQueue.snapshot(sessionID).includes(queued)) return
          await new Promise((r) => setTimeout(r, 20))
        }
        throw new Error("queued id not visible")
      }),
    )
    expect(await Effect.runPromise(KiloSessionPromptQueue.drop(sessionID, active))).toBe(false)
    expect(await Effect.runPromise(KiloSessionPromptQueue.drop(sessionID, queued))).toBe(true)
    expect(KiloSessionPromptQueue.snapshot(sessionID)).not.toContain(queued)
  })
})
