import { resolve } from "node:path"
import type { NativeConfig, NativeEvent } from "./contracts"
import type { createNativeStore } from "./store"
import type { NativeJsonObject } from "./types"

type Store = ReturnType<typeof createNativeStore>
type Emit = (event: NativeEvent) => void

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function safe(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) safe(item)
    return
  }
  const item = object(value)
  if (!item) return
  for (const [key, child] of Object.entries(item)) {
    if (/^(api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|authorization)$/i.test(key)) {
      throw new TypeError(`Credentials must be stored in SecretStorage, not native config (${key})`)
    }
    safe(child)
  }
}

function fields(config: Record<string, unknown>) {
  return (
    typeof config.providerID === "string" &&
    !!config.providerID.trim() &&
    typeof config.modelID === "string" &&
    !!config.modelID.trim() &&
    typeof config.agent === "string" &&
    !!config.agent.trim() &&
    (config.system == null || typeof config.system === "string") &&
    Number.isSafeInteger(config.maxSteps) &&
    (config.maxSteps as number) >= 1 &&
    (config.maxSteps as number) <= 32
  )
}

function parse(value: unknown): NativeConfig {
  const config = object(value)
  const permissions = object(config?.permissions)
  const options = object(config?.options)
  if (!config || !permissions || !options || !fields(config)) {
    throw new Error("Native runtime config is invalid")
  }
  if (!Object.values(permissions).every((value) => value === "allow" || value === "ask" || value === "deny")) {
    throw new Error("Native runtime permission policy is invalid")
  }
  safe(options)
  return config as unknown as NativeConfig
}

function json(value: object): NativeJsonObject {
  const data: unknown = JSON.parse(JSON.stringify(value))
  const result = object(data)
  if (!result) throw new TypeError("Native config must be a JSON object")
  return result as NativeJsonObject
}

export function createNativeConfig(store: Store, emit: Emit) {
  return {
    async get(dir: string) {
      const config = (await store.load(resolve(dir), "config")).data.config
      return config == null ? undefined : parse(config)
    },
    async set(dir: string, value: NativeConfig) {
      const config = parse(value)
      await store.update(resolve(dir), (data) => ({ ...data, config: json(config) }), "config")
      emit({ type: "config.updated", directory: resolve(dir), config })
      return config
    },
  }
}
