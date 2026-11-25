import type { NativeJsonObject } from "./types"
import { parseSse } from "./sse"
import { providerURL } from "./url"

export type NativeChatMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
}

export type NativeChatTool = {
  type: "function"
  function: { name: string; description?: string; parameters: NativeJsonObject }
}

export type NativeUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type NativeGenerationEvent =
  | { type: "text.delta"; text: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "tool.delta"; index: number; callID?: string; name?: string; arguments: string }
  | { type: "usage"; usage: NativeUsage }
  | { type: "done"; finishReason?: string }

export type NativeCompletionRequest = {
  endpoint: string
  apiKey?: string
  headers?: Record<string, string>
  model: string
  messages: NativeChatMessage[]
  tools?: NativeChatTool[]
  temperature?: number
  maxTokens?: number
  maxTokensField?: "max_tokens" | "max_completion_tokens"
  includeUsage?: boolean
  timeoutMs?: number
  retries?: number
  signal?: AbortSignal
}

export class NativeProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "NativeProviderError"
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function endpoint(value: string, credentials: boolean) {
  const url = providerURL(value, credentials)
  const path = url.pathname.replace(/\/+$/, "")
  if (/\/chat\/completions$/i.test(path)) url.pathname = path
  else if (/\/v1$/i.test(path)) url.pathname = `${path}/chat/completions`
  else url.pathname = `${path}/v1/chat/completions`
  return url
}

function delay(value: number, signal: AbortSignal) {
  if (value <= 0) {
    signal.throwIfAborted()
    return Promise.resolve()
  }
  const deferred = Promise.withResolvers<void>()
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", abort)
    deferred.resolve()
  }, value)
  const abort = () => {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    deferred.reject(signal.reason)
  }
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  return deferred.promise
}

function retryAfter(value: string | null, attempt: number) {
  if (value) {
    const seconds = Number(value)
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(seconds * 1000, 15_000))
    const date = Date.parse(value)
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 15_000))
  }
  return Math.min(500 * 2 ** attempt, 8_000)
}

async function errorText(response: Response) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < 16_384) {
      const chunk = await reader.read()
      if (chunk.done) break
      const value = chunk.value.subarray(0, 16_384 - size)
      chunks.push(value)
      size += value.length
      if (value.length < chunk.value.length) {
        await reader.cancel()
        break
      }
      if (size === 16_384) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  const value = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    value.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(value)
}

function usage(value: unknown): NativeUsage | undefined {
  if (!record(value)) return
  const prompt = record(value.prompt_tokens_details) ? value.prompt_tokens_details : {}
  const completion = record(value.completion_tokens_details) ? value.completion_tokens_details : {}
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)
  return {
    input: count(value.prompt_tokens ?? value.input_tokens),
    output: count(value.completion_tokens ?? value.output_tokens),
    reasoning: count(completion.reasoning_tokens),
    cacheRead: count(prompt.cached_tokens),
    cacheWrite: count(prompt.cache_creation_tokens),
  }
}

function parse(data: string) {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch (err) {
    throw new NativeProviderError("Provider returned invalid JSON in its event stream", false, undefined, {
      cause: err,
    })
  }
  if (!record(value)) throw new NativeProviderError("Provider returned an invalid event payload", false)
  const choice = Array.isArray(value.choices) && record(value.choices[0]) ? value.choices[0] : undefined
  return { value, reason: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined }
}

function* tools(value: unknown): Generator<NativeGenerationEvent> {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (!record(item)) continue
    const fn = record(item.function) ? item.function : undefined
    const index = Number.isSafeInteger(item.index) ? (item.index as number) : 0
    yield {
      type: "tool.delta",
      index,
      ...(typeof item.id === "string" ? { callID: item.id } : {}),
      ...(typeof fn?.name === "string" ? { name: fn.name } : {}),
      arguments: typeof fn?.arguments === "string" ? fn.arguments : "",
    }
  }
}

function* translate(value: Record<string, unknown>): Generator<NativeGenerationEvent> {
  const choice = Array.isArray(value.choices) && record(value.choices[0]) ? value.choices[0] : undefined
  const delta = choice && record(choice.delta) ? choice.delta : undefined
  if (typeof delta?.content === "string" && delta.content) yield { type: "text.delta", text: delta.content }
  if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
    yield { type: "reasoning.delta", text: delta.reasoning_content }
  }
  yield* tools(delta?.tool_calls)
  const tokenUsage = usage(value.usage)
  if (tokenUsage) yield { type: "usage", usage: tokenUsage }
}

async function* events(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<NativeGenerationEvent> {
  let finished = false
  let reason: string | undefined

  for await (const frame of parseSse(body, signal)) {
    signal.throwIfAborted()
    if (frame.data === "[DONE]") {
      finished = true
      break
    }

    const chunk = parse(frame.data)
    if (chunk.reason) reason = chunk.reason
    yield* translate(chunk.value)
  }

  if (!finished && !reason) throw new NativeProviderError("Provider stream ended before reporting completion", true)
  yield { type: "done", ...(reason ? { finishReason: reason } : {}) }
}

async function send(url: URL, headers: Headers, body: string, signal: AbortSignal, retries: number) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    signal.throwIfAborted()
    let response: Response
    try {
      response = await fetch(url, { method: "POST", headers, body, signal, redirect: "error" })
    } catch (err) {
      if (signal.aborted) throw signal.reason
      if (attempt >= retries) throw new NativeProviderError("Provider request failed", true, undefined, { cause: err })
      await delay(retryAfter(null, attempt), signal)
      continue
    }

    if (response.ok) return response
    const text = await errorText(response)
    const canRetry = response.status === 408 || response.status === 429 || response.status >= 500
    if (!canRetry || attempt >= retries) {
      throw new NativeProviderError(
        `Provider returned HTTP ${response.status}${text ? `: ${text}` : ""}`,
        canRetry,
        response.status,
      )
    }
    await delay(retryAfter(response.headers.get("retry-after"), attempt), signal)
  }
  throw new NativeProviderError("Provider request attempts were exhausted", true)
}

export async function* streamOpenAI(request: NativeCompletionRequest): AsyncGenerator<NativeGenerationEvent> {
  const credentialHeader = Object.keys(request.headers ?? {}).some((key) =>
    /(authorization|api[-_]?key|token|secret|password)/i.test(key),
  )
  const url = endpoint(request.endpoint, Boolean(request.apiKey || credentialHeader))
  const timeout = AbortSignal.timeout(Math.max(1_000, Math.min(request.timeoutMs ?? 120_000, 600_000)))
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
  const retries = Math.max(0, Math.min(request.retries ?? 2, 3))
  const headers = new Headers(request.headers)
  headers.set("content-type", "application/json")
  headers.set("accept", "text/event-stream")
  if (request.apiKey && !headers.has("authorization")) headers.set("authorization", `Bearer ${request.apiKey}`)
  const body = JSON.stringify({
    model: request.model,
    messages: request.messages,
    stream: true,
    ...(request.includeUsage ? { stream_options: { include_usage: true } } : {}),
    ...(request.temperature == null ? {} : { temperature: request.temperature }),
    ...(request.maxTokens == null ? {} : { [request.maxTokensField ?? "max_tokens"]: request.maxTokens }),
    ...(request.tools?.length ? { tools: request.tools } : {}),
  })
  const response = await send(url, headers, body, signal, retries)
  if (!response.body) throw new NativeProviderError("Provider returned an empty response stream", true, response.status)
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    throw new NativeProviderError(
      `Provider returned an unexpected content type: ${contentType || "missing"}`,
      false,
      response.status,
    )
  }
  yield* events(response.body, signal)
}
