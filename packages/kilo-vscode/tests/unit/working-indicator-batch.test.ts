import { describe, expect, test } from "bun:test"
import { showsWorking, tracksElapsed } from "../../webview-ui/src/components/shared/working-indicator-utils"
import type { Timing } from "../../webview-ui/src/context/session-timing"

describe("waiting_batch working indicator", () => {
  test("shows working while batch poll is in flight", () => {
    expect(showsWorking("waiting_batch", false, false, false)).toBe(true)
    expect(showsWorking("idle", false, false, false)).toBe(false)
  })

  test("tracks elapsed time while waiting_batch", () => {
    const timing: Timing = { active: 0, since: Date.now() }
    expect(tracksElapsed("waiting_batch", false, timing, false)).toBe(true)
    expect(tracksElapsed("idle", false, timing, false)).toBe(false)
  })
})
