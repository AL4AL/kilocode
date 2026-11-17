import type { Job, Script } from "./store"

export type ReportMode = "each" | "rollup" | "none"

const ROLLUP_CHARS = 12_000
const ROLLUP_LINES = 60
const LINE = 240

export function allSettled(script: Script) {
  return script.jobs.length > 0 && script.jobs.every((job) => job.status === "done" || job.status === "failed")
}

/** Prefer the child's FANOUT_RESULT line when present. */
export function extractResult(text: string) {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines.at(i)?.trim() ?? ""
    if (line.startsWith("FANOUT_RESULT ")) return line.slice("FANOUT_RESULT ".length).trim()
    if (line.startsWith("FANOUT_RESULT:")) return line.slice("FANOUT_RESULT:".length).trim()
  }
  return text.trim()
}

export function parseResult(text: string) {
  const line = extractResult(text)
  return line === text.trim() ? undefined : line
}

export function jobSummary(job: Job) {
  if (job.status === "failed") return job.error ?? "failed"
  if (job.output) {
    const line = parseResult(job.output)
    if (line) return line
    return job.output.trim().split("\n").at(0)?.slice(0, LINE) ?? "done"
  }
  return job.status
}

export function reportBody(job: Job, text: string) {
  const core = extractResult(text).slice(0, 8_000)
  const tag = job.status === "failed" ? "fail" : "ok"
  return `[${job.label}] FANOUT_RESULT ${tag} ${core}`
}

function countsOf(script: Script) {
  const counts = { pending: 0, running: 0, done: 0, failed: 0 }
  for (const job of script.jobs) counts[job.status] += 1
  return counts
}

export function buildRollup(script: Script) {
  const counts = countsOf(script)
  const head = [
    `Fan-out finished (script ${script.id}).`,
    `Done ${counts.done}, failed ${counts.failed}, total ${script.jobs.length}.`,
    "Each line is one child. Open the spawn card to see full sessions.",
    "---",
  ]
  const body = script.jobs.slice(0, ROLLUP_LINES).map((job) => {
    if (job.status === "done") return `${job.label}: ${extractResult(job.output ?? "").slice(0, LINE)}`
    return `${job.label}: failed — ${(job.error ?? "unknown").slice(0, 200)}`
  })
  const tail =
    script.jobs.length > ROLLUP_LINES
      ? [`---`, `… ${script.jobs.length - ROLLUP_LINES} more children (see spawn roster).`]
      : []
  const text = [...head, ...body, ...tail].join("\n").slice(0, ROLLUP_CHARS)
  return `${text}\n\nfanout-report:rollup-${script.id}`
}

export function inboxQueued(script: Script) {
  const mode = script.report ?? "each"
  if (mode === "none") return 0
  if (mode === "rollup") return allSettled(script) && !script.rollupSent ? 1 : 0
  return Math.max(0, script.inbox.length - script.cursor)
}