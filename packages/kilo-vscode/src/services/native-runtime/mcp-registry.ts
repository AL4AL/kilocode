import { resolve } from "node:path"
import type { NativeEvent, NativeMcpServer } from "./contracts"
import {
  createNativeMcpManager,
  validateNativeMcpServer,
  type NativeMcpConfig,
  type NativeMcpManager,
  type NativeMcpOptions,
  type NativeMcpRequestOptions,
  type NativeMcpTool,
} from "./mcp"
import type { NativeSecretStorage } from "./providers"
import type { createNativeStore } from "./store"
import type { NativeJson, NativeJsonObject } from "./types"

type Store = ReturnType<typeof createNativeStore>
type Emit = (event: NativeEvent) => void
type Entry = { manager: NativeMcpManager; revision: number }
type Authorize = NativeMcpOptions["authorize"]

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function scope(dir: string) {
  const path = resolve(dir)
  return process.platform === "win32" ? path.toLowerCase() : path
}

function configs(value: unknown): NativeMcpConfig[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error("Stored MCP configuration must be an array")
  return value.map((entry) => {
    const config = object(entry)
    if (!config || typeof config.name !== "string" || (config.transport !== "stdio" && config.transport !== "http")) {
      throw new Error("Stored MCP configuration is invalid")
    }
    const item = config as unknown as NativeMcpConfig
    const errors = validateNativeMcpServer(item)
    if (errors.length) throw new Error(`MCP server ${item.name}: ${errors.join("; ")}`)
    return item
  })
}

function json(value: NativeMcpConfig[]): NativeJson {
  const data: unknown = JSON.parse(JSON.stringify(value))
  if (!Array.isArray(data)) throw new TypeError("MCP configuration must be a JSON array")
  return data as NativeJson
}

export function createNativeMcpService(store: Store, secrets: NativeSecretStorage, authorize: Authorize, emit: Emit) {
  const entries = new Map<string, Entry>()
  const starts = new Map<string, Promise<Entry>>()
  let disposed = false

  async function entry(dir: string) {
    if (disposed) throw new Error("MCP service is disposed")
    const path = resolve(dir)
    const key = scope(path)
    const doc = await store.load(path, "mcp")
    const list = configs(doc.data.servers)
    const current = entries.get(key)
    if (current) {
      if (current.revision !== doc.revision) {
        await current.manager.configure(list)
        current.revision = doc.revision
      }
      return current
    }

    const pending = starts.get(key)
    if (pending) return pending
    const starting = (async () => {
      const manager = createNativeMcpManager({ directory: path, servers: list, secrets, authorize })
      if (disposed) {
        await manager.dispose()
        throw new Error("MCP service is disposed")
      }
      const result = { manager, revision: doc.revision }
      entries.set(key, result)
      return result
    })()
    starts.set(key, starting)
    try {
      return await starting
    } finally {
      if (starts.get(key) === starting) starts.delete(key)
    }
  }

  function report(dir: string, list: NativeMcpServer[]) {
    emit({ type: "mcp.updated", directory: resolve(dir), servers: list })
    return list
  }

  return {
    async configure(dir: string, list: NativeMcpConfig[]) {
      const path = resolve(dir)
      const checked = configs(list)
      await store.update(path, (data) => ({ ...data, servers: json(checked) }), "mcp")
      const current = await entry(path)
      return report(path, current.manager.list())
    },
    async list(dir: string) {
      const current = await entry(dir)
      return current.manager.list()
    },
    async discover(dir: string, opts?: NativeMcpRequestOptions): Promise<NativeMcpTool[]> {
      const current = await entry(dir)
      try {
        const result = await current.manager.discover(opts)
        report(dir, current.manager.list())
        return result
      } catch (err) {
        report(dir, current.manager.list())
        throw err
      }
    },
    async tools(dir: string) {
      const current = await entry(dir)
      return current.manager.list().flatMap((server) => server.tools.map((tool) => ({ server: server.name, ...tool })))
    },
    async call(dir: string, server: string, tool: string, args: NativeJsonObject, opts?: NativeMcpRequestOptions) {
      const current = await entry(dir)
      return current.manager.call(server, tool, args, opts)
    },
    async dispose() {
      disposed = true
      await Promise.allSettled([...starts.values()])
      await Promise.all([...entries.values()].map((item) => item.manager.dispose()))
      entries.clear()
      starts.clear()
    },
  }
}
