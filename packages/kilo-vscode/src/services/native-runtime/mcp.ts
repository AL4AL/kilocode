import type { ChildProcess } from "child_process"
import { realpath } from "node:fs/promises"
import { isIP } from "node:net"
import { relative, resolve, sep } from "node:path"
import { spawn, exec } from "../../util/process"
import type { NativeMcpServer } from "./contracts"
import type { NativeSecretStorage } from "./providers"
import type { NativeJson, NativeJsonObject } from "./types"

const MAX_LINE = 1_048_576
const MAX_BODY = 4_194_304
const MAX_OUTPUT = 1_048_576
const PROTOCOL = "2025-03-26"

export type NativeMcpStdioConfig = {
  name: string
  transport: "stdio"
  command: string
  args?: string[]
  cwd?: string
  /** Non-secret environment values. Put credentials in secretEnv instead. */
  env?: Record<string, string>
  /** Environment variable name to NativeSecretStorage key. */
  secretEnv?: Record<string, string>
  enabled?: boolean
}

export type NativeMcpHttpConfig = {
  name: string
  transport: "http"
  url: string
  /** Non-sensitive HTTP headers. */
  headers?: Record<string, string>
  /** HTTP header name to NativeSecretStorage key. */
  secretHeaders?: Record<string, string>
  enabled?: boolean
}

export type NativeMcpConfig = NativeMcpStdioConfig | NativeMcpHttpConfig

export type NativeMcpOptions = {
  directory: string
  servers?: NativeMcpConfig[]
  secrets: NativeSecretStorage
  authorize: (directory: string, server: NativeMcpConfig) => boolean | Promise<boolean>
}

export type NativeMcpRequestOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

export type NativeMcpTool = NativeMcpServer["tools"][number] & { server: string }

export type NativeMcpManager = {
  readonly directory: string
  list(): NativeMcpServer[]
  discover(opts?: NativeMcpRequestOptions): Promise<NativeMcpTool[]>
  call(server: string, tool: string, args: NativeJsonObject, opts?: NativeMcpRequestOptions): Promise<NativeJsonObject>
  configure(servers: NativeMcpConfig[]): Promise<NativeMcpServer[]>
  dispose(): Promise<void>
}

type Rpc = {
  jsonrpc: "2.0"
  id?: number
  method?: string
  params?: NativeJsonObject
  result?: NativeJson
  error?: { code: number; message: string; data?: NativeJson }
}
type Client = {
  request(method: string, params?: NativeJsonObject, opts?: NativeMcpRequestOptions): Promise<NativeJson>
  close(): Promise<void>
}
type Entry = { config: NativeMcpConfig; state: NativeMcpServer; client?: Client; starting?: Promise<Client> }

function object(value: unknown): value is NativeJsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function json(value: unknown): value is NativeJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(json)
  return object(value) && Object.values(value).every(json)
}

function safeName(value: string) {
  return value.trim().length > 0 && value.length <= 128
}

function loopback(host: string) {
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || (isIP(host) === 4 && host.startsWith("127."))
}

function within(root: string, path: string) {
  const value = relative(root, path)
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`))
}

function runner(command: string) {
  const name = command
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.toLowerCase()
    .replace(/\.cmd$|\.exe$|\.bat$/g, "")
  return name === "npx" || name === "bunx" || name === "npm" || name === "pnpm" || name === "yarn"
}

function envErrors(env: Record<string, string>, label: string, refs = false) {
  const errors: string[] = []
  for (const [key, value] of Object.entries(env)) {
    const invalid = !key || key.includes("=") || key.includes("\0") || (refs ? !value.trim() : value.includes("\0"))
    if (invalid) errors.push(`${label} entries must have valid names and values`)
    if (!refs && /(api[-_]?key|token|secret|password|authorization|credential)/i.test(key)) {
      errors.push(`Sensitive environment variable ${key} must use secretEnv`)
    }
  }
  return errors
}

function stdioErrors(config: NativeMcpStdioConfig) {
  const errors: string[] = []
  if (!config.command.trim()) errors.push("stdio command is required")
  if (runner(config.command))
    errors.push("Package-manager runners are not supported; MCP packages are never installed or executed")
  if (config.args?.some((arg) => arg.includes("\0"))) errors.push("stdio arguments must not contain NUL bytes")
  if (config.cwd?.includes("\0")) errors.push("stdio cwd must not contain NUL bytes")
  errors.push(...envErrors(config.env ?? {}, "stdio environment"))
  errors.push(...envErrors(config.secretEnv ?? {}, "stdio secret environment", true))
  return errors
}

function httpUrlErrors(config: NativeMcpHttpConfig) {
  const errors: string[] = []
  try {
    const url = new URL(config.url)
    if (url.protocol !== "http:" && url.protocol !== "https:") errors.push("MCP HTTP URL must use HTTP or HTTPS")
    if (url.username || url.password) errors.push("MCP credentials must not be embedded in the URL")
    if (
      [...url.searchParams.keys()].some((key) =>
        /(api[-_]?key|access[-_]?token|token|secret|password|authorization)/i.test(key),
      )
    ) {
      errors.push("MCP credentials must use SecretStorage references, not URL query parameters")
    }
    if (url.hash) errors.push("MCP HTTP URL must not contain a fragment")
    const secrets = Object.keys(config.secretHeaders ?? {}).length > 0
    if (secrets && url.protocol === "http:" && !loopback(url.hostname)) {
      errors.push("MCP secrets require HTTPS except for loopback HTTP endpoints")
    }
  } catch {
    errors.push("MCP HTTP URL must be a valid absolute URL")
  }
  return errors
}

function headerErrors(config: NativeMcpHttpConfig) {
  const errors: string[] = []
  const sensitive = /(authorization|auth[-_]?token|api[-_]?key|secret|token|cookie|password)/i
  for (const [key, value] of Object.entries(config.headers ?? {})) {
    if (!key.trim() || /[\r\n:]/.test(key) || /[\r\n]/.test(value)) errors.push("MCP HTTP headers must be valid")
    if (sensitive.test(key)) errors.push(`Sensitive header ${key} must use secretHeaders`)
  }
  for (const [key, ref] of Object.entries(config.secretHeaders ?? {})) {
    if (!key.trim() || /[\r\n:]/.test(key) || !ref.trim()) errors.push("MCP secret header references must be valid")
  }
  return errors
}

export function validateNativeMcpServer(config: NativeMcpConfig): string[] {
  const errors = safeName(config.name) ? [] : ["Server name must be 1-128 non-whitespace characters"]
  return [
    ...errors,
    ...(config.transport === "stdio" ? stdioErrors(config) : [...httpUrlErrors(config), ...headerErrors(config)]),
  ]
}

function fail(message: string): Error {
  return new Error(message)
}

function rpcError(value: Rpc): Error | undefined {
  if (!value.error) return undefined
  return new Error(`MCP error ${value.error.code}: ${value.error.message}`)
}

function timeout(opts?: NativeMcpRequestOptions) {
  const ms = opts?.timeoutMs ?? 30_000
  if (!Number.isFinite(ms) || ms < 1 || ms > 300_000)
    throw new RangeError("MCP timeout must be between 1 and 300000 ms")
  opts?.signal?.throwIfAborted()
  return AbortSignal.any([...(opts?.signal ? [opts.signal] : []), AbortSignal.timeout(ms)])
}

function rpcResult(value: unknown, id: number): NativeJson {
  if (!object(value) || value.jsonrpc !== "2.0" || value.id !== id) throw fail("Invalid MCP JSON-RPC response")
  const msg = value as unknown as Rpc
  const err = rpcError(msg)
  if (err) throw err
  if (!("result" in value) || !json(msg.result)) throw fail("MCP response did not contain a valid JSON result")
  return msg.result
}

function bounded(value: NativeJson, max = MAX_OUTPUT) {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text, "utf8") > max) throw new RangeError(`MCP output exceeded the ${max}-byte limit`)
  return value
}

function parseLine(line: string): Rpc {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE)
    throw new RangeError(`MCP protocol line exceeded the ${MAX_LINE}-byte limit`)
  const value: unknown = JSON.parse(line)
  if (!object(value) || value.jsonrpc !== "2.0") throw fail("Invalid MCP JSON-RPC message")
  return value as unknown as Rpc
}

function stdioClient(child: ChildProcess): Client {
  const pending = new Map<number, { resolve(value: NativeJson): void; reject(err: Error): void; clear(): void }>()
  const closed = Promise.withResolvers<void>()
  let seq = 0
  let buf = Buffer.alloc(0)
  let stderrSize = 0
  let ended = false
  child.stdout?.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    if (buf.length > MAX_LINE && buf.indexOf(10) < 0) {
      stop(new RangeError(`MCP protocol line exceeded the ${MAX_LINE}-byte limit`))
      void terminate(child)
      return
    }
    let end = buf.indexOf(10)
    while (end >= 0) {
      const line = buf.subarray(0, end).toString("utf8").trim()
      buf = buf.subarray(end + 1)
      if (line) {
        try {
          const msg = parseLine(line)
          if (typeof msg.id !== "number") continue
          const entry = pending.get(msg.id)
          if (!entry) continue
          pending.delete(msg.id)
          entry.clear()
          if (rpcError(msg)) entry.reject(rpcError(msg)!)
          else if (!json(msg.result)) entry.reject(fail("MCP response did not contain a valid JSON result"))
          else entry.resolve(bounded(msg.result))
        } catch (err) {
          stop(err instanceof Error ? err : new Error(String(err)))
          void terminate(child)
          return
        }
      }
      end = buf.indexOf(10)
    }
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrSize += chunk.length
    if (stderrSize > MAX_BODY) {
      stop(new RangeError(`MCP process output exceeded the ${MAX_BODY}-byte limit`))
      void terminate(child)
    }
  })
  child.once("error", (err) => stop(err))
  child.once("close", (code, signal) => {
    ended = true
    const err = fail(`MCP process closed (${signal ?? `code ${code}`})`)
    stop(err)
    closed.resolve()
  })

  return {
    async request(method, params, opts) {
      const signal = timeout(opts)
      const id = ++seq
      const deferred = Promise.withResolvers<NativeJson>()
      const timer = setTimeout(() => {
        pending.delete(id)
        entry.clear()
        deferred.reject(new Error(`MCP ${method} timed out`))
      }, opts?.timeoutMs ?? 30_000)
      const abort = () => {
        pending.delete(id)
        clearTimeout(timer)
        deferred.reject(signal.reason instanceof Error ? signal.reason : fail("MCP request cancelled"))
        if (!ended)
          child.stdin?.write(
            `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Request cancelled" } })}\n`,
          )
      }
      const entry = {
        resolve: deferred.resolve,
        reject: deferred.reject,
        clear: () => {
          clearTimeout(timer)
          signal.removeEventListener("abort", abort)
        },
      }
      pending.set(id, entry)
      signal.addEventListener("abort", abort, { once: true })
      const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`
      if (Buffer.byteLength(line, "utf8") > MAX_LINE) {
        pending.delete(id)
        entry.clear()
        deferred.reject(new RangeError(`MCP protocol line exceeded the ${MAX_LINE}-byte limit`))
        return deferred.promise
      }
      child.stdin?.write(line, (err) => {
        if (!err) return
        pending.delete(id)
        entry.clear()
        deferred.reject(err)
      })
      if (signal.aborted) abort()
      return deferred.promise
    },
    async close() {
      if (ended) return
      child.stdin?.end()
      await terminate(child)
      await closed.promise
    },
  }

  function stop(err: Error) {
    for (const item of pending.values()) {
      item.clear()
      item.reject(err)
    }
    pending.clear()
  }
}

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (process.platform === "win32") {
    await exec("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { timeout: 10_000 }).catch((err: unknown) => {
      console.error("[Kilo New] Failed to terminate MCP process tree:", err)
      child.kill()
    })
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch (err) {
    if (!(err && typeof err === "object" && "code" in err && err.code === "ESRCH")) {
      console.error("[Kilo New] Failed to terminate MCP process group:", err)
      child.kill("SIGTERM")
    }
  }
  await new Promise<void>((done) => setTimeout(done, 1_000))
  try {
    process.kill(-child.pid!, 0)
    process.kill(-child.pid!, "SIGKILL")
  } catch (err) {
    if (!(err && typeof err === "object" && "code" in err && err.code === "ESRCH")) {
      console.error("[Kilo New] Failed to force-stop MCP process group:", err)
    }
  }
}

async function body(response: Response, max = MAX_BODY) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const item = await reader.read()
    if (item.done) break
    size += item.value.length
    if (size > max) {
      await reader.cancel("MCP response exceeded size limit")
      throw new RangeError(`MCP HTTP response exceeded the ${max}-byte limit`)
    }
    chunks.push(item.value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function httpClient(config: NativeMcpHttpConfig, headers: Record<string, string>): Client {
  let seq = 0
  let session: string | undefined
  let protocol = PROTOCOL
  let closed = false
  const endpoint = new URL(config.url).toString()

  return {
    async request(method, params, opts) {
      if (closed) throw fail("MCP HTTP client is disposed")
      const signal = timeout(opts)
      const id = ++seq
      const init = async () => {
        const result = await send(
          {
            jsonrpc: "2.0",
            id,
            method,
            params: params ?? {
              protocolVersion: PROTOCOL,
              capabilities: {},
              clientInfo: { name: "kilo-native-runtime", version: "1.0.0" },
            },
          },
          signal,
        )
        if (!object(result) || typeof result.protocolVersion !== "string")
          throw fail("MCP initialize returned an invalid result")
        protocol = result.protocolVersion
        await send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal, true)
        return result
      }
      if (method === "initialize") {
        const result = await init()
        return result as NativeJson
      }
      return send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }, signal)
    },
    async close() {
      closed = true
    },
  }

  async function send(msg: Rpc, signal: AbortSignal, notification = false): Promise<NativeJson> {
    const hdr = new Headers(headers)
    hdr.set("content-type", "application/json")
    hdr.set("accept", "application/json, text/event-stream")
    hdr.set("mcp-protocol-version", protocol)
    if (session) hdr.set("mcp-session-id", session)
    const payload = JSON.stringify(msg)
    if (Buffer.byteLength(payload, "utf8") > MAX_BODY)
      throw new RangeError(`MCP HTTP request exceeded the ${MAX_BODY}-byte limit`)
    const res = await fetch(endpoint, { method: "POST", headers: hdr, body: payload, signal, redirect: "error" })
    const sid = res.headers.get("mcp-session-id")
    if (sid) session = sid
    if (!res.ok) throw fail(`MCP HTTP request failed with status ${res.status}`)
    if (notification || res.status === 202 || res.status === 204) return null
    const text = await body(res)
    if (!text.trim()) throw fail("MCP HTTP response body was empty")
    let value: unknown
    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      const frames = text.split(/\r?\n\r?\n/)
      const id = msg.id
      value = frames
        .flatMap((frame) =>
          frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim()),
        )
        .map((line) => JSON.parse(line) as unknown)
        .find((item) => object(item) && item.id === id)
    } else {
      value = JSON.parse(text) as unknown
    }
    if (!msg.id) return null
    return bounded(rpcResult(value, msg.id))
  }
}

function tools(value: NativeJson, name: string): NativeMcpTool[] {
  if (!object(value) || !Array.isArray(value.tools)) throw fail("MCP tools/list returned an invalid result")
  return value.tools.map((tool): NativeMcpTool => {
    if (!object(tool) || typeof tool.name !== "string" || !object(tool.inputSchema))
      throw fail("MCP server returned an invalid tool")
    return {
      server: name,
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
    }
  })
}

function processEnv(extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {}
  const keys = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "SHELL",
    "ComSpec",
    "COMSPEC",
  ]
  for (const key of keys) {
    if (process.env[key] != null) env[key] = process.env[key]
  }
  return Object.assign(env, extra)
}

export function createNativeMcpManager(opts: NativeMcpOptions): NativeMcpManager {
  const directory = resolve(opts.directory)
  const entries = new Map<string, Entry>()
  let disposed = false

  function list() {
    return [...entries.values()].map((entry) => ({
      ...entry.state,
      tools: entry.state.tools.map((tool) => ({ ...tool })),
    }))
  }

  function install(configs: NativeMcpConfig[]) {
    const names = new Set<string>()
    for (const config of configs) {
      const errors = validateNativeMcpServer(config)
      if (errors.length) throw new TypeError(`${config.name || "MCP server"}: ${errors.join("; ")}`)
      if (names.has(config.name)) throw new TypeError(`Duplicate MCP server name: ${config.name}`)
      names.add(config.name)
    }
    return configs
  }

  function entry(name: string) {
    const found = entries.get(name)
    if (!found) throw new Error(`Unknown MCP server: ${name}`)
    if (found.config.enabled === false) throw new Error(`MCP server ${name} is disabled`)
    return found
  }

  async function client(found: Entry): Promise<Client> {
    if (disposed) throw fail("MCP manager is disposed")
    if (found.client) return found.client
    if (found.starting) return found.starting
    found.state.status = "connecting"
    found.state.error = undefined
    found.starting = (async () => {
      try {
        if (!(await opts.authorize(directory, found.config)))
          throw fail(`MCP server ${found.config.name} was not authorized`)
        if (found.config.transport === "stdio") {
          const root = await realpath(directory)
          const cwd = await realpath(resolve(root, found.config.cwd ?? "."))
          if (!within(root, cwd)) throw fail(`MCP server ${found.config.name} cwd must stay inside the workspace`)
          const env = processEnv(found.config.env)
          for (const [key, ref] of Object.entries(found.config.secretEnv ?? {})) {
            const secret = await opts.secrets.get(ref)
            if (secret == null) throw fail(`MCP secret ${ref} is not available`)
            env[key] = secret
          }
          const target = await realpath(cwd)
          if (!within(root, target)) throw fail(`MCP server ${found.config.name} cwd changed outside the workspace`)
          const child = spawn(found.config.command, found.config.args ?? [], {
            cwd: target,
            env,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          })
          found.client = stdioClient(child)
        } else {
          const headers = { ...found.config.headers }
          for (const [key, ref] of Object.entries(found.config.secretHeaders ?? {})) {
            const secret = await opts.secrets.get(ref)
            if (secret == null) throw fail(`MCP secret ${ref} is not available`)
            headers[key] = secret
          }
          found.client = httpClient(found.config, headers)
        }
        const rpc = found.client
        await rpc.request(
          "initialize",
          {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: { name: "kilo-native-runtime", version: "1.0.0" },
          },
          { timeoutMs: 10_000 },
        )
        found.state.status = "connected"
        return rpc
      } catch (err) {
        found.state.status = "error"
        found.state.error = err instanceof Error ? err.message : String(err)
        await found.client?.close()
        found.client = undefined
        throw err
      }
    })()
    try {
      return await found.starting
    } finally {
      found.starting = undefined
    }
  }

  async function configure(configs: NativeMcpConfig[]) {
    install(configs)
    await Promise.allSettled([...entries.values()].map((item) => item.starting))
    await Promise.all([...entries.values()].map((item) => item.client?.close()))
    entries.clear()
    for (const config of configs) {
      entries.set(config.name, {
        config: { ...config },
        state: {
          name: config.name,
          transport: config.transport,
          status: config.enabled === false ? "disabled" : "connecting",
          tools: [],
        },
      })
    }
    return list()
  }

  install(opts.servers ?? [])
  for (const config of opts.servers ?? []) {
    entries.set(config.name, {
      config: { ...config },
      state: {
        name: config.name,
        transport: config.transport,
        status: config.enabled === false ? "disabled" : "connecting",
        tools: [],
      },
    })
  }

  return {
    directory,
    list,
    async discover(request = {}) {
      const result: NativeMcpTool[] = []
      await Promise.all(
        [...entries.values()]
          .filter((item) => item.config.enabled !== false)
          .map(async (item) => {
            try {
              const rpc = await client(item)
              const found = tools(await rpc.request("tools/list", {}, request), item.config.name)
              item.state.tools = found.map(({ server: _server, ...tool }) => tool)
              result.push(...found)
            } catch (err) {
              item.state.status = "error"
              item.state.error = err instanceof Error ? err.message : String(err)
              throw err
            }
          }),
      )
      return result.sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
    },
    async call(name, tool, args, request = {}) {
      if (!object(args)) throw new TypeError("MCP tool arguments must be a JSON object")
      const found = entry(name)
      const rpc = await client(found)
      if (!found.state.tools.some((item) => item.name === tool)) {
        const listed = tools(await rpc.request("tools/list", {}, request), name)
        found.state.tools = listed.map(({ server: _server, ...item }) => item)
      }
      if (!found.state.tools.some((item) => item.name === tool)) throw new Error(`Unknown MCP tool ${name}.${tool}`)
      const value = await rpc.request("tools/call", { name: tool, arguments: args }, request)
      if (!object(value)) throw fail("MCP tools/call returned an invalid result")
      return bounded(value) as NativeJsonObject
    },
    configure,
    async dispose() {
      if (disposed) return
      disposed = true
      await Promise.allSettled([...entries.values()].map((item) => item.starting))
      await Promise.all([...entries.values()].map((item) => item.client?.close()))
      for (const item of entries.values()) {
        item.client = undefined
        item.state.status = "disabled"
      }
    },
  }
}
