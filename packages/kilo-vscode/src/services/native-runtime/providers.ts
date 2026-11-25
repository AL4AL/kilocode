import type {
  NativeChatMessage,
  NativeChatTool,
  NativeCompletionRequest,
  NativeGenerationEvent,
} from "./openai-compatible"
import { NativeProviderError, streamOpenAI } from "./openai-compatible"
import type { NativeEvent, NativeModel, NativeProvider } from "./contracts"
import { providerURL } from "./url"
import { streamAnthropic } from "./anthropic"
import { streamGoogle } from "./google"
import { streamOpenAIResponses } from "./openai-responses"
import { initiateDeviceAuth, pollDeviceAuth } from "@kilocode/kilo-gateway/device-auth"
import { KILO_API_BASE, KILO_OPENROUTER_BASE, ANONYMOUS_API_KEY } from "@kilocode/kilo-gateway/constants"
import { buildKiloHeaders, getDefaultHeaders } from "@kilocode/kilo-gateway/headers"
import { fetchKiloModels } from "@kilocode/kilo-gateway/models"
import type { NativeJsonObject } from "./types"

export type NativeSecretStorage = {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>
  store(key: string, value: string): Thenable<void> | Promise<void>
  delete(key: string): Thenable<void> | Promise<void>
}

export type NativeProviderConfig = NativeProvider & {
  protocol: "openai-compatible" | "openai-responses" | "anthropic" | "google"
  endpoint: string
  authEndpoint?: string
  catalogURL?: string
  organizationID?: string
  headers?: Record<string, string>
  maxTokensField?: NativeCompletionRequest["maxTokensField"]
}

export type NativeGenerationOptions = {
  signal?: AbortSignal
  temperature?: number
  maxTokens?: number
  includeUsage?: boolean
  timeoutMs?: number
  retries?: number
  tools?: NativeChatTool[]
  metadata?: { taskId?: string; projectId?: string }
}

const key = (id: string) => `kilocode.native-runtime.provider.${encodeURIComponent(id)}`

function model(provider: NativeProviderConfig, id: string) {
  const value = provider.models.find((item) => item.id === id)
  if (!value) throw new NativeProviderError(`Model ${id} is not configured for provider ${provider.id}`, false)
  return value
}

function endpoint(value: string, credentials: boolean) {
  providerURL(value, credentials)
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function modality<T extends string>(value: unknown, values: readonly T[], fallback: readonly T[]): T[] {
  if (!Array.isArray(value)) return [...fallback]
  const result = value.filter((item): item is T => typeof item === "string" && values.includes(item as T))
  return result.length ? result : [...fallback]
}

function kiloModels(value: unknown): NativeModel[] {
  const data = object(value)
  if (!data) return []
  const input = ["text", "image", "audio", "video", "pdf"] as const
  const output = ["text", "image", "audio"] as const
  return Object.entries(data).flatMap(([id, value]) => {
    const item = object(value)
    const limit = object(item?.limit)
    if (
      !item ||
      !limit ||
      typeof limit.context !== "number" ||
      limit.context < 1 ||
      typeof limit.output !== "number" ||
      limit.output < 1
    ) {
      return []
    }
    const features = object(item.modalities)
    const opts = object(item.options)
    return [
      {
        id,
        providerID: "kilo",
        name: typeof item.name === "string" ? item.name : id,
        contextWindow: limit.context,
        maxOutputTokens: limit.output,
        input: modality(features?.input, input, ["text"]),
        output: modality(features?.output, output, ["text"]),
        capabilities: {
          streaming: true,
          tools: item.tool_call === true,
          reasoning: item.reasoning === true,
          structuredOutput: false,
        },
        options: { ...(opts as NativeJsonObject | undefined), isFree: item.isFree === true },
      },
    ]
  })
}

async function pause(delay: number, signal: AbortSignal) {
  signal.throwIfAborted()
  const deferred = Promise.withResolvers<void>()
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort)
    deferred.resolve()
  }, delay)
  const abort = () => {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    deferred.reject(signal.reason)
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  await deferred.promise
}

async function device(id: string, base: string, signal: AbortSignal, emit: (event: NativeEvent) => void) {
  const init = await initiateDeviceAuth({
    baseURL: base,
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  if (!init.code.trim() || !Number.isFinite(init.expiresIn) || init.expiresIn < 1) {
    throw new NativeProviderError("Device authorization returned invalid verification details", false)
  }
  const verification = providerURL(init.verificationUrl, true)
  emit({
    type: "provider.auth.device",
    providerID: id,
    code: init.code,
    verificationURL: verification.toString(),
    expiresIn: init.expiresIn,
  })
  const end = Date.now() + Math.max(1, Math.min(init.expiresIn, 1800)) * 1000
  while (Date.now() < end) {
    const result = await pollDeviceAuth(init.code, {
      baseURL: base,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    })
    if (result.status === "approved") {
      if (!result.token?.trim()) throw new NativeProviderError("Device authorization returned no token", false)
      return result.token
    }
    if (result.status === "denied" || result.status === "expired") {
      throw new NativeProviderError(`Device authorization ${result.status}`, false)
    }
    if (result.status !== "pending")
      throw new NativeProviderError("Device authorization returned an unknown status", false)
    await pause(3_000, signal)
  }
  throw new NativeProviderError("Device authorization expired", false)
}

export function createProviderRegistry(secrets: NativeSecretStorage, emit: (event: NativeEvent) => void = () => {}) {
  const providers = new Map<string, NativeProviderConfig>()
  const auth = new Map<string, AbortController>()
  const epochs = new Map<string, number>()
  const queues = new Map<string, Promise<void>>()

  function advance(id: string) {
    const value = (epochs.get(id) ?? 0) + 1
    epochs.set(id, value)
    return value
  }

  async function sequence(id: string, action: () => Promise<void>) {
    const prev = queues.get(id) ?? Promise.resolve()
    const next = prev.then(action, action)
    queues.set(id, next)
    try {
      await next
    } finally {
      if (queues.get(id) === next) queues.delete(id)
    }
  }

  async function list(): Promise<NativeProvider[]> {
    return Promise.all(
      [...providers.values()].map(async (provider) => ({
        ...provider,
        connected: provider.auth === "none" || (await secrets.get(key(provider.id))) != null,
      })),
    )
  }

  async function refreshKilo(provider: NativeProviderConfig, token?: string) {
    const result = await fetchKiloModels({
      kilocodeToken: token,
      kilocodeOrganizationId: provider.organizationID,
      baseURL: provider.catalogURL,
    })
    if (result.error) {
      throw new NativeProviderError(
        `Kilo model catalog failed: ${result.error.kind}`,
        result.error.kind === "network" || result.error.kind === "http",
        result.error.status,
      )
    }
    const models = kiloModels(result.models)
    if (!models.length) throw new NativeProviderError("Kilo model catalog contained no tool-capable models", true)
    provider.models = models
    emit({ type: "provider.updated", providers: await list() })
  }

  return {
    register(provider: NativeProviderConfig) {
      if (provider.auth !== "none" && provider.auth !== "secret" && provider.auth !== "device") {
        throw new NativeProviderError(`Provider auth flow ${provider.auth} is not implemented`, false)
      }
      endpoint(provider.endpoint, provider.auth !== "none")
      if (provider.authEndpoint) providerURL(provider.authEndpoint, true)
      if (provider.auth === "device" && !provider.authEndpoint) {
        throw new TypeError(`Device-auth provider ${provider.id} requires an auth endpoint`)
      }
      if (!provider.id.trim() || (!provider.models.length && provider.id !== "kilo"))
        throw new TypeError("Provider ID and model catalog must not be empty")
      const ids = new Set<string>()
      for (const model of provider.models) {
        if (!model.id.trim() || ids.has(model.id) || model.contextWindow < 1 || model.maxOutputTokens < 1) {
          throw new TypeError(`Invalid model catalog for provider ${provider.id}`)
        }
        ids.add(model.id)
      }
      providers.set(provider.id, structuredClone(provider))
    },
    async registerKilo(
      options: { organizationID?: string; endpoint?: string; authEndpoint?: string; catalogURL?: string } = {},
    ) {
      const id = "kilo"
      const provider: NativeProviderConfig = {
        id,
        name: "Kilo Gateway",
        auth: "device",
        connected: false,
        protocol: "openai-compatible",
        endpoint: options.endpoint ?? KILO_OPENROUTER_BASE,
        authEndpoint: options.authEndpoint ?? KILO_API_BASE,
        catalogURL: options.catalogURL?.replace(/\/+$/, ""),
        organizationID: options.organizationID,
        headers: {
          ...getDefaultHeaders(),
          ...buildKiloHeaders(undefined, { kilocodeOrganizationId: options.organizationID }),
          "X-KILOCODE-EDITORNAME": "Kilo VS Code Extension",
        },
        models: [],
      }
      endpoint(provider.endpoint, true)
      providerURL(provider.authEndpoint ?? KILO_API_BASE, true)
      providers.set(id, provider)
      try {
        await refreshKilo(provider, await secrets.get(key(id)))
      } catch (err) {
        emit({
          type: "provider.catalog.error",
          providerID: id,
          message: err instanceof Error ? err.message : String(err),
        })
      }
      return list()
    },
    async refresh(id: string) {
      const provider = providers.get(id)
      if (!provider) throw new NativeProviderError(`Unknown provider: ${id}`, false)
      if (id !== "kilo") return list()
      await refreshKilo(provider, await secrets.get(key(id)))
      return list()
    },
    async connect(id: string, secret: string) {
      const provider = providers.get(id)
      if (!provider) throw new NativeProviderError(`Unknown provider: ${id}`, false)
      if (provider.auth !== "secret")
        throw new NativeProviderError(`Provider ${id} does not accept API-key authentication`, false)
      if (!secret.trim()) throw new TypeError("Provider credentials must not be empty")
      const epoch = advance(id)
      await sequence(id, async () => {
        if (epochs.get(id) !== epoch) throw new NativeProviderError(`Connection superseded for ${id}`, false)
        await secrets.store(key(id), secret)
        if (epochs.get(id) !== epoch) {
          await secrets.delete(key(id))
          throw new NativeProviderError(`Connection superseded for ${id}`, false)
        }
      })
      const result = await list()
      if (epochs.get(id) !== epoch) throw new NativeProviderError(`Connection superseded for ${id}`, false)
      return result
    },
    async connectDevice(id: string, signal?: AbortSignal) {
      const provider = providers.get(id)
      if (!provider) throw new NativeProviderError(`Unknown provider: ${id}`, false)
      if (provider.auth !== "device" || !provider.authEndpoint) {
        throw new NativeProviderError(`Provider ${id} does not use device authorization`, false)
      }
      if (auth.has(id)) throw new NativeProviderError(`Device authorization is already active for ${id}`, false)
      const ctl = new AbortController()
      const epoch = advance(id)
      const abort = () => ctl.abort(signal?.reason)
      auth.set(id, ctl)
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      try {
        const baseURL = provider.authEndpoint.replace(/\/+$/, "")
        const token = await device(id, baseURL, ctl.signal, emit)
        await sequence(id, async () => {
          if (epochs.get(id) !== epoch || ctl.signal.aborted) {
            throw new NativeProviderError(`Connection superseded for ${id}`, false)
          }
          await secrets.store(key(id), token)
          if (epochs.get(id) !== epoch || ctl.signal.aborted) {
            await secrets.delete(key(id))
            throw new NativeProviderError(`Connection superseded for ${id}`, false)
          }
        })
        if (provider.id === "kilo") {
          try {
            await refreshKilo(provider, token)
          } catch (err) {
            emit({
              type: "provider.catalog.error",
              providerID: id,
              message: err instanceof Error ? err.message : String(err),
            })
          }
        }
        const result = await list()
        if (epochs.get(id) !== epoch) throw new NativeProviderError(`Connection superseded for ${id}`, false)
        emit({ type: "provider.auth.status", providerID: id, status: "approved" })
        return result
      } catch (err) {
        if (ctl.signal.aborted) throw ctl.signal.reason
        const text = err instanceof Error ? err.message : String(err)
        const status = text.endsWith("denied") ? "denied" : text.endsWith("expired") ? "expired" : "error"
        emit({ type: "provider.auth.status", providerID: id, status, message: text })
        throw err
      } finally {
        if (auth.get(id) === ctl) auth.delete(id)
        signal?.removeEventListener("abort", abort)
      }
    },
    async disconnect(id: string) {
      if (!providers.has(id)) throw new NativeProviderError(`Unknown provider: ${id}`, false)
      advance(id)
      const ctl = auth.get(id)
      if (ctl) {
        auth.delete(id)
        ctl.abort(new Error("Device authorization cancelled"))
      }
      await sequence(id, async () => {
        await secrets.delete(key(id))
      })
      return list()
    },
    list,
    async *stream(
      id: string,
      modelID: string,
      messages: NativeChatMessage[],
      options: NativeGenerationOptions = {},
    ): AsyncGenerator<NativeGenerationEvent> {
      const provider = providers.get(id)
      if (!provider) throw new NativeProviderError(`Unknown provider: ${id}`, false)
      const selected = model(provider, modelID)
      const secret = provider.auth !== "none" ? await secrets.get(key(provider.id)) : undefined
      const free = provider.id === "kilo" && selected.options.isFree === true
      if (provider.auth !== "none" && !secret && !free)
        throw new NativeProviderError(`Connect provider ${id} before using it`, false)
      const request: NativeCompletionRequest = {
        endpoint: provider.endpoint,
        ...(secret ? { apiKey: secret } : free ? { apiKey: ANONYMOUS_API_KEY } : {}),
        headers: {
          ...provider.headers,
          ...(provider.id === "kilo"
            ? buildKiloHeaders(options.metadata, { kilocodeOrganizationId: provider.organizationID })
            : {}),
          ...(provider.id === "kilo" ? { "X-KILOCODE-EDITORNAME": "Kilo VS Code Extension" } : {}),
        },
        model: selected.id,
        messages,
        tools: options.tools,
        temperature: options.temperature,
        maxTokens: options.maxTokens ?? selected.maxOutputTokens,
        maxTokensField: provider.maxTokensField,
        includeUsage: options.includeUsage,
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        signal: options.signal,
      }
      if (provider.protocol === "anthropic") {
        yield* streamAnthropic(request)
        return
      }
      if (provider.protocol === "google") {
        yield* streamGoogle(request)
        return
      }
      if (provider.protocol === "openai-responses") {
        yield* streamOpenAIResponses(request)
        return
      }
      yield* streamOpenAI(request)
    },
    dispose() {
      for (const id of providers.keys()) advance(id)
      for (const [id, ctl] of auth) {
        ctl.abort(new Error("Native runtime disposed"))
      }
      auth.clear()
    },
  }
}
