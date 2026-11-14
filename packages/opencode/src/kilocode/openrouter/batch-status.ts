// kilocode_change - new file
import type { SessionID } from "@/session/schema"

function race<T>(promise: Promise<T>) {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(resolve, 50) as T)])
}

type WaitingInput = {
  sessionID: SessionID
  batchId: string
  customId: string
  modelId: string
  phase?: "polling" | "cancelling"
}

async function waiting(input: WaitingInput) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { SessionStatus } = await import("@/session/status")
  return AppRuntime.runPromise(
    SessionStatus.Service.use((status) =>
      status.set(input.sessionID, {
        type: "waiting_batch",
        batchId: input.batchId,
        customId: input.customId,
        modelId: input.modelId,
        phase: input.phase,
      }),
    ),
  )
}

async function idle(sessionID: SessionID) {
  const { AppRuntime } = await import("@/effect/app-runtime")
  const { SessionStatus } = await import("@/session/status")
  return AppRuntime.runPromise(SessionStatus.Service.use((status) => status.set(sessionID, { type: "idle" })))
}

export function setWaitingBatch(input: WaitingInput) {
  race(waiting({ ...input, phase: input.phase ?? "polling" })).catch(() => undefined)
}

export function setCancellingBatch(input: Omit<WaitingInput, "phase">) {
  race(waiting({ ...input, phase: "cancelling" })).catch(() => undefined)
}

export function clearWaitingBatch(sessionID: SessionID) {
  race(idle(sessionID)).catch(() => undefined)
}
