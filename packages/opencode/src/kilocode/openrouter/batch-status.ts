// kilocode_change - new file
import type { SessionID } from "@/session/schema"

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
  await AppRuntime.runPromise(
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
  void waiting({ ...input, phase: input.phase ?? "polling" }).catch(() => undefined)
}

export function setCancellingBatch(input: Omit<WaitingInput, "phase">) {
  void waiting({ ...input, phase: "cancelling" }).catch(() => undefined)
}

export function clearWaitingBatch(sessionID: SessionID) {
  void idle(sessionID).catch(() => undefined)
}