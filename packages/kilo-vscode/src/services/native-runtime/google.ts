import type {
  NativeChatMessage,
  NativeChatTool,
  NativeCompletionRequest,
  NativeGenerationEvent,
  NativeUsage,
} from "./openai-compatible"
import { NativeProviderError } from "./openai-compatible"
import { parseSse } from "./sse"
import { providerURL } from "./url"
import type { NativeJsonObject } from "./types"

type Part = Record<string, unknown>
type Content = { role: "user" | "model"; parts: Part[] }

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function json(value: string): NativeJsonObject {
  try {
    const result: unknown = JSON.parse(value)
    const record = object(result)
    if (record) return record as NativeJsonObject
  } catch (err) {
    throw new NativeProviderError("Provider returned invalid function-call arguments", false, undefined, { cause: err })
  }
  throw new NativeProviderError("Provider returned invalid function-call arguments", false)
}

function add(contents: Content[], role: Content["role"], part: Part) {
  const last = contents.at(-1)
  if (last?.role === role) {
    last.parts.push(part)
    return
  }
  contents.push({ role, parts: [part] })
}

function messages(input: NativeChatMessage[]) {
  const contents: Content[] = []
  const system: string[] = []
  const names = new Map<string, string>()
  for (const msg of input) {
    if (msg.role === "system") {
      if (msg.content) system.push(msg.content)
      continue
    }
    if (msg.role === "tool") {
      const name = msg.tool_call_id && names.get(msg.tool_call_id)
      if (name) add(contents, "user", { functionResponse: { name, response: { content: msg.content ?? "" } } })
      continue
    }
    if (msg.role === "user") {
      add(contents, "user", { text: msg.content ?? "" })
      continue
    }
    if (msg.content) add(contents, "model", { text: msg.content })
    for (const call of msg.tool_calls ?? []) {
      names.set(call.id, call.function.name)
      add(contents, "model", {
        functionCall: { name: call.function.name, args: json(call.function.arguments) },
      })
    }
  }
  return { contents, system }
}

function tools(input: NativeChatTool[]) {
  return input.map((tool) => ({
    name: tool.function.name,
    ...(tool.function.description ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters,
  }))
}

function usage(value: unknown): NativeUsage | undefined {
  const item = object(value)
  if (!item) return
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)
  return {
    input: count(item.promptTokenCount),
    output: count(item.candidatesTokenCount),
    reasoning: count(item.thoughtsTokenCount),
    cacheRead: count(item.cachedContentTokenCount),
    cacheWrite: 0,
  }
}

function* part(value: unknown, candidate: number, index: number): Generator<NativeGenerationEvent> {
  const item = object(value)
  if (typeof item?.text === "string" && item.text) {
    yield item.thought === true ? { type: "reasoning.delta", text: item.text } : { type: "text.delta", text: item.text }
  }
  const call = object(item?.functionCall)
  if (typeof call?.name !== "string") return
  const args = object(call.args) ?? {}
  yield {
    type: "tool.delta",
    index: candidate * 100 + index,
    callID: typeof call.id === "string" ? call.id : `google-${candidate}-${index}`,
    name: call.name,
    arguments: JSON.stringify(args),
  }
}

function* candidate(value: unknown, index: number): Generator<NativeGenerationEvent> {
  const item = object(value)
  const content = object(item?.content)
  const parts = Array.isArray(content?.parts) ? content.parts : []
  for (const [n, value] of parts.entries()) yield* part(value, index, n)
  const reason = item?.finishReason
  if (typeof reason === "string" && reason !== "FINISH_REASON_UNSPECIFIED") yield { type: "done", finishReason: reason }
}

function* translate(value: Record<string, unknown>): Generator<NativeGenerationEvent> {
  const candidates = Array.isArray(value.candidates) ? value.candidates : []
  for (const [index, item] of candidates.entries()) yield* candidate(item, index)
  const tokenUsage = usage(value.usageMetadata)
  if (tokenUsage) yield { type: "usage", usage: tokenUsage }
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

async function errorText(response: Response) {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const bytes = new Uint8Array(16_385)
  let size = 0
  try {
    while (size < bytes.length) {
      const value = await reader.read()
      if (value.done) break
      const chunk = value.value.subarray(0, bytes.length - size)
      bytes.set(chunk, size)
      size += chunk.length
      if (chunk.length < value.value.length || size === bytes.length) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(bytes.subarray(0, Math.min(size, 16_384)))
}

function endpoint(value: string, model: string, key: string, extra?: Record<string, string>) {
  const url = providerURL(value, true)
  const name = model.replace(/^models\//, "")
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models/${encodeURIComponent(name)}:streamGenerateContent`
  url.searchParams.set("alt", "sse")
  const headers = new Headers(extra)
  headers.set("content-type", "application/json")
  headers.set("accept", "text/event-stream")
  headers.set("x-goog-api-key", key)
  return { url, headers }
}

function payload(request: NativeCompletionRequest) {
  const prompt = messages(request.messages)
  return JSON.stringify({
    contents: prompt.contents,
    ...(prompt.system.length ? { systemInstruction: { parts: prompt.system.map((text) => ({ text })) } } : {}),
    ...(request.tools?.length ? { tools: [{ functionDeclarations: tools(request.tools) }] } : {}),
    generationConfig: {
      ...(request.maxTokens == null ? {} : { maxOutputTokens: request.maxTokens }),
      ...(request.temperature == null ? {} : { temperature: request.temperature }),
    },
  })
}

function parse(value: string) {
  let data: unknown
  try {
    data = JSON.parse(value)
  } catch (err) {
    throw new NativeProviderError("Google provider returned invalid event JSON", false, undefined, { cause: err })
  }
  const record = object(data)
  if (!record) throw new NativeProviderError("Google provider returned an invalid event payload", false)
  return record
}

async function response(url: URL, headers: Headers, body: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    let result: Response
    try {
      result = await fetch(url, { method: "POST", headers, body, signal, redirect: "error" })
    } catch (err) {
      if (signal.aborted) throw signal.reason
      if (attempt === 2)
        throw new NativeProviderError("Google provider request failed", true, undefined, { cause: err })
      await delay(500 * (attempt + 1), signal)
      continue
    }
    if (result.ok) return result
    const text = await errorText(result)
    const retryable = result.status === 408 || result.status === 429 || result.status >= 500
    if (!retryable || attempt === 2) {
      throw new NativeProviderError(
        `Google provider returned HTTP ${result.status}${text ? `: ${text}` : ""}`,
        retryable,
        result.status,
      )
    }
    const after = Number(result.headers.get("retry-after"))
    await delay(Number.isFinite(after) ? Math.max(0, Math.min(after * 1000, 15_000)) : 500 * (attempt + 1), signal)
  }
  throw new NativeProviderError("Google provider attempts were exhausted", true)
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
    for (const event of translate(parse(frame.data))) {
      if (event.type === "done") {
        finished = true
        reason = event.finishReason
        continue
      }
      yield event
    }
  }
  if (!finished) throw new NativeProviderError("Google provider stream ended before completion", true)
  yield { type: "done", ...(reason ? { finishReason: reason } : {}) }
}

export async function* streamGoogle(request: NativeCompletionRequest): AsyncGenerator<NativeGenerationEvent> {
  if (!request.apiKey) throw new NativeProviderError("Connect the Google provider before using it", false)
  const timeout = AbortSignal.timeout(Math.max(1_000, Math.min(request.timeoutMs ?? 120_000, 600_000)))
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
  const target = endpoint(request.endpoint, request.model, request.apiKey, request.headers)
  const result = await response(target.url, target.headers, payload(request), signal)
  if (!result.body) throw new NativeProviderError("Google provider returned an empty stream", true, result.status)
  if (!(result.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
    throw new NativeProviderError("Google provider returned an unexpected response type", false, result.status)
  }
  yield* events(result.body, signal)
}
