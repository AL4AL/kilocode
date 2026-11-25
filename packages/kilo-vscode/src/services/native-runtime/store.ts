import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { NativeDocument, NativeJsonObject } from "./types"

const LOCK_TIMEOUT = 30_000
const STALE_LOCK_AGE = 120_000

type Change = (data: NativeJsonObject) => NativeJsonObject | Promise<NativeJsonObject>

function scope(dir: string) {
  if (!dir.trim()) throw new TypeError("Native runtime state requires a directory scope")
  const path = resolve(dir)
  return process.platform === "win32" ? path.toLowerCase() : path
}

function code(err: unknown) {
  return err && typeof err === "object" && "code" in err ? err.code : undefined
}

function valid(doc: unknown, scope: string): doc is NativeDocument {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false
  const value = doc as Record<string, unknown>
  return (
    value.version === 1 &&
    value.scope === scope &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    value.data !== null &&
    typeof value.data === "object" &&
    !Array.isArray(value.data)
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return code(err) === "EPERM"
  }
}

async function stale(lock: string) {
  const owner = join(lock, "owner")
  try {
    const value: unknown = JSON.parse(await readFile(owner, "utf8"))
    if (!value || typeof value !== "object") return false
    const pid = Reflect.get(value, "pid")
    const at = Reflect.get(value, "at")
    if (!Number.isInteger(pid) || typeof at !== "number") return false
    return !alive(pid)
  } catch (err) {
    if (code(err) !== "ENOENT" && !(err instanceof SyntaxError)) throw err
    try {
      return Date.now() - (await stat(lock)).mtimeMs > STALE_LOCK_AGE
    } catch (statErr) {
      if (code(statErr) === "ENOENT") return false
      throw statErr
    }
  }
}

async function wait() {
  await new Promise<void>((done) => setTimeout(done, 30 + Math.floor(Math.random() * 40)))
}

async function reap(lock: string) {
  const path = join(lock, "reaper")
  const opened = await open(path, "wx", 0o600).then(
    (handle) => ({ handle }),
    (err: unknown) => ({ err }),
  )
  if ("err" in opened) {
    if (code(opened.err) === "ENOENT") return true
    if (code(opened.err) === "EEXIST") return false
    throw opened.err
  }
  const handle = opened.handle
  let removed = false
  try {
    if (!(await stale(lock))) return false
    await rm(lock, { recursive: true, force: true })
    removed = true
    return true
  } finally {
    try {
      await handle.close()
    } finally {
      if (!removed) await rm(path, { force: true })
    }
  }
}

async function acquire(file: string) {
  const lock = `${file}.lock`
  const token = randomUUID()
  const end = Date.now() + LOCK_TIMEOUT

  while (true) {
    try {
      await mkdir(lock)
      try {
        const handle = await open(join(lock, "owner"), "wx", 0o600)
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token }))
          await handle.sync()
        } finally {
          await handle.close()
        }
      } catch (err) {
        await rm(lock, { recursive: true, force: true })
        throw err
      }
      return async () => {
        const value: unknown = JSON.parse(await readFile(join(lock, "owner"), "utf8"))
        if (!value || typeof value !== "object" || Reflect.get(value, "token") !== token) {
          throw new Error(`Native runtime lock ownership changed for ${file}`)
        }
        await rm(lock, { recursive: true })
      }
    } catch (err) {
      if (code(err) !== "EEXIST") throw err
      if (await stale(lock)) {
        if (!(await reap(lock))) {
          if (Date.now() >= end) throw new Error(`Timed out waiting for native runtime state lock: ${file}`)
          await wait()
          continue
        }
        continue
      }
      if (Date.now() >= end) throw new Error(`Timed out waiting for native runtime state lock: ${file}`)
      await wait()
    }
  }
}

async function readOne(file: string, scope: string) {
  const value: unknown = JSON.parse(await readFile(file, "utf8"))
  if (!valid(value, scope)) throw new Error(`Invalid native runtime state document: ${file}`)
  return value
}

async function load(file: string, scope: string): Promise<NativeDocument> {
  const current = await readOne(file, scope).then(
    (value) => ({ value }),
    (err: unknown) => ({ err }),
  )
  if ("value" in current) return current.value

  const backup = await readOne(`${file}.bak`, scope).then(
    (value) => ({ value }),
    (err: unknown) => ({ err }),
  )
  if ("value" in backup) return backup.value
  if (code(current.err) === "ENOENT" && code(backup.err) === "ENOENT") {
    return { version: 1, scope, revision: 0, updatedAt: 0, data: {} }
  }
  throw new Error(`Could not recover native runtime state for ${scope}`, {
    cause: new AggregateError([current.err, backup.err]),
  })
}

async function syncDir(dir: string) {
  if (process.platform === "win32") return
  const handle = await open(dir, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function write(file: string, doc: NativeDocument) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    const handle = await open(tmp, "wx", 0o600)
    try {
      await handle.writeFile(JSON.stringify(doc))
      await handle.sync()
    } finally {
      await handle.close()
    }

    const bak = `${file}.bak`
    await rm(bak, { force: true })
    try {
      await rename(file, bak)
    } catch (err) {
      if (code(err) !== "ENOENT") throw err
    }
    await rename(tmp, file)
    await syncDir(dirname(file))
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export function createNativeStore(root: string) {
  const base = join(resolve(root), "native-runtime", "v1")

  function file(dir: string, name = "state") {
    if (!name.trim()) throw new TypeError("Native runtime state requires a document name")
    const key = scope(dir)
    const id = name === "state" ? key : `${key}\0${name}`
    const hash = createHash("sha256").update(id).digest("hex")
    return { path: join(base, `${hash}.json`), scope: id }
  }

  return {
    async load(dir: string, name?: string) {
      const item = file(dir, name)
      return load(item.path, item.scope)
    },
    async update(dir: string, change: Change, name?: string) {
      const item = file(dir, name)
      await mkdir(base, { recursive: true })
      const release = await acquire(item.path)
      try {
        const prev = await load(item.path, item.scope)
        const data = await change(structuredClone(prev.data))
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new TypeError("Native runtime state updates must return an object")
        }
        const next: NativeDocument = {
          version: 1,
          scope: item.scope,
          revision: prev.revision + 1,
          updatedAt: Date.now(),
          data,
        }
        await write(item.path, next)
        return next
      } finally {
        await release()
      }
    },
    async remove(dir: string, name: string) {
      const item = file(dir, name)
      await mkdir(base, { recursive: true })
      const release = await acquire(item.path)
      try {
        await rm(`${item.path}.bak`, { force: true })
        await rm(item.path, { force: true })
      } finally {
        await release()
      }
    },
  }
}
