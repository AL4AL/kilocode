// kilocode_change - new file
import type { SessionID } from "@/session/schema"

function race<T>(promise: Promise<T>) {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(resolve, 50) as T)])
}

async function waiting(input: { sessionID: SessionID; batchId: string; customId: string; modelId: string }) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { SessionStatus } = await import("@/session/status")
  return AppRuntime.runPromise(
    SessionStatus.Service.use((status) =>
      status.set(input.sessionID, {
        type: "waiting_batch",
        batchId: input.batchId,
        customId: input.customId,
        modelId: input.modelId,
      }),
    ),
  )
}

async function idle(sessionID: SessionID) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { SessionStatus } = await import("@/session/status")
  return AppRuntime.runPromise(SessionStatus.Service.use((status) => status.set(sessionID, { type: "idle" })))
}

export function setWaitingBatch(input: { sessionID: SessionID; batchId: string; customId: string; modelId: string }) {
  race(waiting(input)).catch(() => undefined)
}

export function clearWaitingBatch(sessionID: SessionID) {
  race(idle(sessionID)).catch(() => undefined)
}
