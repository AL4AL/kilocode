import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "fanout-store" })

export const MAX_JOB_ATTEMPTS = 2

export type Status = "pending" | "running" | "done" | "failed"

export type Job = {
  id: string
  sessionId?: string
  label: string
  title?: string
  /** Last small-model input key, so a title is not regenerated for the same step. */
  mark?: string
  prompt: string
  paths: string[]
  isolate: boolean
  directory?: string
  status: Status
  error?: string
  output?: string
  attempt: number
  box?: Mail[]
  /** One note for this agent, delivered on its next idle turn. */
  notice?: string
}

export type Mail = {
  id: string
  from: string
  paths: string[]
  ask: string
  state: "open" | "allow" | "deny" | "patch"
  woke?: boolean
}

export type Report = {
  id: string
  jobID: string
  sessionId?: string
  status: "done" | "failed"
  text: string
  at: number
}

export type Script = {
  id: string
  parentID: string
  directory: string
  cap: number
  agent: string
  messageID?: string
  callID?: string
  partID?: string
  /** Last counts written onto the parent tool part. */
  published?: string
  jobs: Job[]
  inbox: Report[]
  /** Index of the next report that has not been delivered to the parent. */
  cursor: number
}

type File = {
  version: 1
  scripts: Script[]
}

export type Counts = {
  pending: number
  running: number
  done: number
  failed: number
}

function file() {
  return path.join(Global.Path.state, "fanout.json")
}

function missing(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT"
}

function read(): File {
  try {
    const data = JSON.parse(readFileSync(file(), "utf8")) as File
    if (data.version !== 1 || !Array.isArray(data.scripts)) throw new Error("fanout store has an unexpected shape")
    return data
  } catch (err) {
    if (missing(err)) return { version: 1, scripts: [] }
    log.error("fanout store unreadable", { err })
    throw err
  }
}

function write(data: File) {
  const dest = file()
  mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, dest)
}

let chain = Promise.resolve()

function change<T>(fn: (data: File) => T): Promise<T> {
  const run = chain.then(() => {
    const data = read()
    const result = fn(data)
    write(data)
    return result
  })
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function countsOf(script: Script): Counts {
  const counts = { pending: 0, running: 0, done: 0, failed: 0 }
  for (const job of script.jobs) counts[job.status] += 1
  return counts
}

export namespace FanoutStore {
  /** Read-modify-write the script list. Mutations are saved even when the function returns a message. */
  export function withStore<T>(fn: (scripts: Script[]) => T) {
    return change((data) => fn(data.scripts))
  }

  export function list() {
    return read().scripts
  }

  export function get(id: string) {
    return read().scripts.find((script) => script.id === id)
  }

  export function counts(id: string): Counts {
    const script = get(id)
    if (!script) return { pending: 0, running: 0, done: 0, failed: 0 }
    return countsOf(script)
  }

  export function page(id: string, offset: number, limit: number) {
    const script = get(id)
    if (!script) return
    const start = Math.max(0, Math.floor(offset))
    const size = Math.min(100, Math.max(1, Math.floor(limit)))
    return {
      scriptId: script.id,
      total: script.jobs.length,
      ...countsOf(script),
      offset: start,
      sessionIds: script.jobs.flatMap((job) => (job.sessionId ? [job.sessionId] : [])),
      jobs: script.jobs.slice(start, start + size).map((job) => ({
        id: job.id,
        label: job.label,
        status: job.status,
        ...(job.sessionId ? { sessionId: job.sessionId } : {}),
        ...(job.title ? { title: job.title } : {}),
      })),
    }
  }

  export function open(input: {
    id: string
    parentID: string
    directory: string
    cap: number
    agent: string
    messageID?: string
    callID?: string
  }) {
    return change((data) => {
      data.scripts.push({
        id: input.id,
        parentID: input.parentID,
        directory: input.directory,
        cap: input.cap,
        agent: input.agent,
        messageID: input.messageID,
        callID: input.callID,
        jobs: [],
        inbox: [],
        cursor: 0,
      })
      return input.id
    })
  }

  export function patchScript(id: string, patch: Partial<Pick<Script, "partID" | "published">>) {
    return change((data) => {
      const script = data.scripts.find((item) => item.id === id)
      if (!script) return
      Object.assign(script, patch)
    })
  }

  export function addJob(scriptID: string, job: Job) {
    return change((data) => {
      const script = data.scripts.find((item) => item.id === scriptID)
      if (!script) throw new Error(`Unknown fan-out script ${scriptID}`)
      script.jobs.push(job)
      return job
    })
  }

  export function patch(scriptID: string, jobID: string, patch: Partial<Job>) {
    return change((data) => {
      const script = data.scripts.find((item) => item.id === scriptID)
      const job = script?.jobs.find((item) => item.id === jobID)
      if (!script || !job) throw new Error(`Unknown fan-out job ${scriptID}/${jobID}`)
      Object.assign(job, patch)
      return job
    })
  }

  export function pushReport(scriptID: string, report: Report) {
    return change((data) => {
      const script = data.scripts.find((item) => item.id === scriptID)
      if (!script) throw new Error(`Unknown fan-out script ${scriptID}`)
      script.inbox.push(report)
      return report
    })
  }

  export function addRequest(scriptID: string, jobID: string, mail: Mail) {
    return change((data) => {
      const job = data.scripts.find((item) => item.id === scriptID)?.jobs.find((item) => item.id === jobID)
      if (!job) return
      job.box = [...(job.box ?? []), mail]
    })
  }

  export function setRequest(scriptID: string, jobID: string, requestID: string, state: Mail["state"]) {
    return change((data) => {
      const job = data.scripts.find((item) => item.id === scriptID)?.jobs.find((item) => item.id === jobID)
      const mail = job?.box?.find((item) => item.id === requestID)
      if (!mail) throw new Error(`Unknown scope request ${requestID}`)
      mail.state = state
      return mail
    })
  }

  export function notice(scriptID: string, jobID: string, text: string) {
    return change((data) => {
      const job = data.scripts.find((item) => item.id === scriptID)?.jobs.find((item) => item.id === jobID)
      if (!job) return
      job.notice = job.notice ? `${job.notice}\n\n${text}` : text
    })
  }

  export function clearNotice(scriptID: string, jobID: string) {
    return change((data) => {
      const job = data.scripts.find((item) => item.id === scriptID)?.jobs.find((item) => item.id === jobID)
      if (job) job.notice = undefined
    })
  }

  export function markMail(scriptID: string, jobID: string, requestID: string) {
    return change((data) => {
      const mail = data.scripts
        .find((item) => item.id === scriptID)
        ?.jobs.find((item) => item.id === jobID)
        ?.box?.find((item) => item.id === requestID)
      if (mail) mail.woke = true
    })
  }

  export function ack(scriptID: string) {
    return change((data) => {
      const script = data.scripts.find((item) => item.id === scriptID)
      if (!script) return
      if (script.cursor < script.inbox.length) script.cursor += 1
    })
  }
}
