/**
 * Process spawning utilities for the VS Code extension.
 *
 * All helpers set `windowsHide: true` to prevent cmd.exe console windows from
 * flashing on Windows. Always use these instead of importing `spawn` or
 * `execFile` from `child_process` directly.
 *
 * If you need the raw callback form of `execFile`, pass `windowsHide: true`
 * explicitly in the options object.
 */

import {
  spawn as _spawn,
  execFile as _execFile,
  type SpawnOptions,
  type ExecFileOptionsWithStringEncoding,
  type ChildProcess,
} from "child_process"
import { promisify } from "util"

const _exec = promisify(_execFile)

/** `child_process.spawn` with `windowsHide: true` forced on. */
export function spawn(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return _spawn(cmd, args, { windowsHide: true, ...opts })
}

/** Promisified `child_process.execFile` with `windowsHide: true` forced on. */
export async function exec(
  cmd: string,
  args: string[],
  opts: Omit<ExecFileOptionsWithStringEncoding, "encoding"> = {},
): Promise<{ stdout: string; stderr: string }> {
  return _exec(cmd, args, { ...opts, encoding: "utf8", windowsHide: true })
}

function processGroup(pid: number) {
  try {
    process.kill(-pid, 0)
    return true
  } catch (err) {
    return !(err && typeof err === "object" && "code" in err && err.code === "ESRCH")
  }
}

async function killGroup(pid: number) {
  const end = Date.now() + 1_000
  while (processGroup(pid) && Date.now() < end) await new Promise<void>((done) => setTimeout(done, 25))
  if (!processGroup(pid)) return
  try {
    process.kill(-pid, "SIGKILL")
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code !== "ESRCH") {
      console.error("[Kilo New] Failed to force-stop command process group:", err)
    }
  }
  const drain = Date.now() + 1_000
  while (processGroup(pid) && Date.now() < drain) await new Promise<void>((done) => setTimeout(done, 25))
}

export function execTree(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  const deferred = Promise.withResolvers<{ stdout: string; stderr: string }>()
  const timers: { timeout?: ReturnType<typeof setTimeout> } = {}
  const max = opts.maxBuffer ?? 1_048_576
  let stdout = ""
  let stderr = ""
  let size = 0
  let failure: Error | undefined
  let closed = false
  let stopping = false
  let tree: Promise<void> | undefined

  const kill = () => {
    if (!child.pid || closed || stopping) return
    stopping = true
    if (process.platform === "win32") {
      tree = exec("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { timeout: 10_000 })
        .then(() => undefined)
        .catch((err: unknown) => {
          console.error("[Kilo New] Failed to terminate command process tree:", err)
          child.kill()
        })
      return
    }
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code !== "ESRCH") {
        console.error("[Kilo New] Failed to terminate command process group:", err)
      }
    }
    tree = killGroup(child.pid)
  }

  const abort = () => {
    failure =
      opts.signal?.reason instanceof Error
        ? opts.signal.reason
        : new Error(String(opts.signal?.reason ?? "Command aborted"))
    kill()
  }

  const data = (value: Buffer, stream: "stdout" | "stderr") => {
    size += value.length
    if (size > max) {
      failure ??= new RangeError(`Command output exceeded the ${max}-byte limit`)
      kill()
      return
    }
    if (stream === "stdout") stdout += value.toString("utf8")
    if (stream === "stderr") stderr += value.toString("utf8")
  }

  child.stdout?.on("data", (value: Buffer) => data(value, "stdout"))
  child.stderr?.on("data", (value: Buffer) => data(value, "stderr"))
  child.once("error", (err) => {
    failure ??= err
  })
  child.once("spawn", () => {
    if (failure) kill()
  })
  child.once("close", (code, signal) => {
    closed = true
    clearTimeout(timers.timeout)
    opts.signal?.removeEventListener("abort", abort)
    void (tree ?? Promise.resolve()).then(
      () => finish(code, signal),
      (err: unknown) => {
        failure ??= err instanceof Error ? err : new Error(String(err))
        finish(code, signal)
      },
    )
  })

  if (opts.timeout) {
    timers.timeout = setTimeout(() => {
      failure = new Error(`Command timed out after ${opts.timeout} ms`)
      kill()
    }, opts.timeout)
  }
  opts.signal?.addEventListener("abort", abort, { once: true })
  if (opts.signal?.aborted) abort()
  return deferred.promise

  function finish(code: number | null, signal: NodeJS.Signals | null) {
    if (failure) {
      deferred.reject(
        Object.assign(
          new Error(`${failure.message}${stdout || stderr ? `\n${stdout}${stderr}` : ""}`, { cause: failure }),
          { stdout, stderr },
        ),
      )
      return
    }
    if (code !== 0) {
      deferred.reject(
        Object.assign(
          new Error(`Command exited with ${signal ?? `code ${code}`}${stdout || stderr ? `\n${stdout}${stderr}` : ""}`),
          { stdout, stderr },
        ),
      )
      return
    }
    deferred.resolve({ stdout, stderr })
  }
}
