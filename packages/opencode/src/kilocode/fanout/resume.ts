import * as Log from "@opencode-ai/core/util/log"
import { OpenRouterBatchStore } from "@/kilocode/openrouter/batch-store"
import { SessionID } from "@/session/schema"
import { FanoutStore, MAX_JOB_ATTEMPTS, type Job, type Script } from "./store"
import { launch, deliver, publish, wake } from "./run"
import { refresh, release, reserve } from "./title"

const log = Log.create({ service: "fanout-resume" })
const TICK_MS = 5_000
const live = new Set<string>()
const delivering = new Set<string>()
const titleAt = new Map<string, number>()

async function runtime() {
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime
}

async function inside<T>(directory: string, run: () => Promise<T>) {
  const { provide } = await import("@/kilocode/instance")
  return provide({ directory, fn: run })
}

async function start(script: Script, job: Job) {
  const app = await runtime()
  const dir = job.directory ?? script.directory
  const outcome = await inside(dir, () => app.runPromise(launch({ scriptID: script.id, jobID: job.id })))
  if (!outcome || outcome.directory === dir) return
  await inside(outcome.directory, () => app.runPromise(launch({ scriptID: script.id, jobID: job.id })))
}

function queued(script: Script, job: Job) {
  if (live.has(job.id)) return false
  if (job.status === "pending") return true
  if (job.status !== "running") return false
  if (!job.sessionId) return true
  return OpenRouterBatchStore.bySession(SessionID.make(job.sessionId)).length === 0
}

async function sweep() {
  const app = await runtime()
  for (const script of FanoutStore.list()) {
    const running = script.jobs.filter((job) => job.status === "running").length
    const room = script.cap - running
    const pending = script.jobs.filter((job) => job.status === "pending" && !live.has(job.id))
    const resume = script.jobs.filter((job) => job.status === "running" && queued(script, job))
    const chosen = [...resume, ...pending.slice(0, Math.max(0, room - resume.length))]
    for (const job of chosen) {
      if (live.has(job.id)) continue
      live.add(job.id)
      void start(script, job)
        .catch((err) => {
          log.warn("fan-out job failed", { err, job: job.id })
          const text = err instanceof Error ? err.message : String(err)
          const latest = FanoutStore.get(script.id)?.jobs.find((item) => item.id === job.id)
          if (!latest || latest.status === "done" || latest.status === "failed") return
          const attempt = latest.attempt + 1
          const status = attempt < MAX_JOB_ATTEMPTS ? "pending" : "failed"
          return FanoutStore.patch(script.id, job.id, { status, attempt, error: text })
        })
        .finally(() => live.delete(job.id))
    }
    void inside(script.directory, () => app.runPromise(publish(script.id))).catch((err) =>
      log.warn("fan-out count publish failed", { err, script: script.id }),
    )
    for (const job of script.jobs) {
      if (!job.notice && !job.box?.some((item) => item.state === "open" && !item.woke)) continue
      void inside(job.directory ?? script.directory, () =>
        app.runPromise(wake({ scriptID: script.id, jobID: job.id })),
      ).catch((err) => log.warn("fan-out mailbox wake failed", { err, job: job.id }))
    }
    if (!delivering.has(script.id) && script.inbox.length > script.cursor) {
      delivering.add(script.id)
      void inside(script.directory, () => app.runPromise(deliver(script.id)))
        .catch((err) => log.warn("fan-out delivery failed", { err, script: script.id }))
        .finally(() => delivering.delete(script.id))
    }
    const open = script.jobs.filter((job) => job.status === "pending" || job.status === "running")
    const startAt = titleAt.get(script.id) ?? 0
    const picks =
      open.length === 0
        ? []
        : [0, 1].flatMap((step) => {
            const job = open[(startAt + step) % open.length]
            if (!job || !reserve(job.id)) return []
            return [job]
          })
    if (open.length > 0) titleAt.set(script.id, startAt + 1)
    for (const job of picks) {
      void inside(script.directory, () => app.runPromise(refresh({ scriptID: script.id, jobID: job.id })))
        .catch((err) => log.warn("fan-out title sweep failed", { err, job: job.id }))
        .finally(() => release(job.id))
    }
  }
}

let armed = false

/** Re-arm fan-out jobs whenever kilo serve starts, next to the OpenRouter batch resume loop. */
export function armFanoutResume() {
  if (armed) return
  armed = true
  const tick = () => void sweep().catch((err) => log.warn("fan-out sweep failed", { err }))
  tick()
  setInterval(tick, TICK_MS)
}
