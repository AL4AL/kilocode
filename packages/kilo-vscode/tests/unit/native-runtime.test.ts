import { describe, expect, it } from "bun:test"
import { createNativeRuntime } from "../../src/services/native-runtime/runtime"
import type { NativeEvent } from "../../src/services/native-runtime/contracts"
import type { NativeSecretStorage } from "../../src/services/native-runtime/providers"

const secrets: NativeSecretStorage = {
  get: async () => undefined,
  store: async () => undefined,
  delete: async () => undefined,
}

describe("native runtime event boundary", () => {
  it("fans events out in order and isolates listener failures", () => {
    let errors = 0
    const runtime = createNativeRuntime({
      root: "/tmp/kilo-native-runtime-events",
      secrets,
      trusted: () => true,
      onError: () => errors++,
    })
    const events: NativeEvent[] = []
    runtime.onEvent(() => {
      throw new Error("listener failed")
    })
    runtime.onEvent((event) => events.push(event))

    runtime.emit({ type: "runtime.status", status: "ready" })
    runtime.emit({ type: "runtime.status", status: "busy" })

    expect(events.map((event) => event.type)).toEqual(["runtime.status", "runtime.status"])
    expect(events.map((event) => event.type === "runtime.status" && event.status)).toEqual(["ready", "busy"])
    expect(errors).toBe(2)
    runtime.dispose()
  })

  it("removes listeners on unsubscribe and rejects subscriptions after disposal", () => {
    const runtime = createNativeRuntime({ root: "/tmp/kilo-native-runtime-events", secrets, trusted: () => true })
    const events: NativeEvent[] = []
    const off = runtime.onEvent((event) => events.push(event))
    off()
    runtime.emit({ type: "runtime.status", status: "ready" })
    runtime.dispose()

    expect(events).toEqual([])
    expect(() => runtime.onEvent(() => undefined)).toThrow("disposed")
  })
})
