import path from "node:path"
import { FanoutStore, type Job, type Script } from "./store"

export type ScopeCtx = {
  paths: readonly string[]
  grants: readonly string[]
  file: string
}

function escape(value: string) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

/** Glob match. `**` crosses directories. A path without a star is a prefix. */
export function match(glob: string, file: string) {
  const norm = file.replaceAll("\\", "/")
  const pattern = glob.replaceAll("\\", "/")
  if (!pattern.includes("*")) return norm === pattern || norm.startsWith(pattern.endsWith("/") ? pattern : `${pattern}/`)
  const body = escape(pattern).replaceAll("\\*\\*", ".*").replaceAll("\\*", "[^/]*")
  return new RegExp(`^${body}$`).test(norm)
}

/** Project-relative form of a file. Absolute paths outside the root stay absolute. */
export function relative(root: string, file: string) {
  const abs = path.resolve(root, file)
  const rel = path.relative(root, abs).replaceAll("\\", "/")
  if (rel === "" || rel === ".." || rel.startsWith("../")) return abs.replaceAll("\\", "/")
  return rel
}

/** True when this actor may touch the file. Empty paths mean the job is unscoped. */
export function scopeAllows(ctx: ScopeCtx) {
  if (ctx.paths.length === 0) return true
  if (ctx.grants.some((glob) => match(glob, ctx.file))) return true
  return ctx.paths.some((glob) => match(glob, ctx.file))
}

function locate(sessionID: string) {
  for (const script of FanoutStore.list()) {
    const job = script.jobs.find((item) => item.sessionId === sessionID)
    if (job) return { script, job }
  }
}

/** Allows live on the owner's mailbox, addressed to this actor. */
function grants(script: Script, job: Job, file: string) {
  return script.jobs.flatMap((owner) =>
    (owner.box ?? []).flatMap((item) =>
      item.from === job.id && item.state === "allow" && item.paths.some((path) => match(path, file) || path === file)
        ? item.paths
        : [],
    ),
  )
}

function waiting(item: { from: string; state: string; paths: string[] }, from: string, file: string, rel: string) {
  return (
    item.from === from &&
    item.state === "open" &&
    item.paths.some((glob) => match(glob, file) || match(glob, rel) || glob === file || glob === rel)
  )
}

/**
 * Block a write outside the job's paths. An owned path becomes a mailbox request
 * for the owner instead of an edit. The request is saved before this returns.
 * Unscoped jobs are unchanged.
 */
export function guard(sessionID: string | undefined, file: string) {
  if (!sessionID) return Promise.resolve()
  return FanoutStore.withStore((scripts) => {
    let found: { script: Script; job: Job } | undefined
    for (const script of scripts) {
      const job = script.jobs.find((item) => item.sessionId === sessionID)
      if (job) found = { script, job }
    }
    if (!found) return
    const { script, job } = found
    const root = job.directory ?? script.directory
    const rel = relative(root, file)
    const grantList = [...grants(script, job, file), ...grants(script, job, rel)]
    if (scopeAllows({ paths: job.paths, grants: grantList, file: rel })) return
    if (scopeAllows({ paths: job.paths, grants: grantList, file })) return
    const owner = script.jobs.find((item) => {
      if (item.id === job.id || item.paths.length === 0) return false
      const base = item.directory ?? script.directory
      const owned = relative(base, file)
      return (
        scopeAllows({ paths: item.paths, grants: [], file: owned }) ||
        scopeAllows({ paths: item.paths, grants: [], file })
      )
    })
    if (!owner) return `Out of scope: ${rel}`
    const open = owner.box?.find((item) => waiting(item, job.id, file, rel))
    if (open) return `Owned by ${owner.label} (${rel}). Mailbox ${open.id} waiting.`
    const id = crypto.randomUUID()
    owner.box = [
      ...(owner.box ?? []),
      { id, from: job.id, paths: [rel], ask: `Allow ${job.label} to change ${rel}?`, state: "open" },
    ]
    return `Owned by ${owner.label} (${rel}). Mailbox ${id} created; wait for allow.`
  }).then((message) => {
    if (message) throw new Error(message)
  })
}

export async function answer(sessionID: string, requestID: string, state: "allow" | "deny" | "patch") {
  const found = locate(sessionID)
  if (!found) throw new Error("This session has no fan-out mailbox")
  const mail = await FanoutStore.setRequest(found.script.id, found.job.id, requestID, state)
  const requester = found.script.jobs.find((item) => item.id === mail.from)
  if (!requester) return mail
  const paths = mail.paths.join(", ")
  const text =
    state === "allow"
      ? `Request ${mail.id} was allowed. You may edit ${paths}.`
      : state === "deny"
        ? `Request ${mail.id} was denied. Do not edit ${paths}.`
        : `Request ${mail.id} will be patched by ${found.job.label}. Do not edit ${paths}.`
  await FanoutStore.notice(found.script.id, requester.id, text)
  return mail
}

export type Owned = { script: Script; job: Job }
