import type {
  NativeChatMessage,
  NativeCompletionRequest,
  NativeGenerationEvent,
  NativeUsage,
} from "./openai-compatible"
import { NativeProviderError } from "./openai-compatible"
import { parseSse } from "./sse"
import { providerURL } from "./url"
import type { NativeJsonObject } from "./types"

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function input(messages: NativeChatMessage[]) {
  const items: NativeJsonObject[] = []
  const instructions: string[] = []
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) instructions.push(message.content)
      continue
    }
    if (message.role === "tool") {
      if (message.tool_call_id)
        items.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content ?? "" })
      continue
    }
    if (message.content) items.push({ role: message.role, content: message.content })
    if (message.role !== "assistant") continue
    for (const call of message.tool_calls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })
    }
  }
  return { input: items, instructions: instructions.join("\n\n") }
}

function endpoint(value: string, key: string, extra?: Record<string, string>) {
  const url = providerURL(value, true)
  const path = url.pathname.replace(/\/+$/, "")
  url.pathname = /\/responses$/i.test(path) ? path : /\/v1$/i.test(path) ? `${path}/responses` : `${path}/v1/responses`
  const headers = new Headers(extra)
  headers.set("authorization", `Bearer ${key}`)
  headers.set("content-type", "application/json")
  headers.set("accept", "text/event-stream")
  return { url, headers }
}

function count(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function text(value: Record<string, unknown>): NativeGenerationEvent[] {
  if (typeof value.delta !== "string") return []
  if (value.type === "response.output_text.delta") return [{ type: "text.delta", text: value.delta }]
  return [{ type: "reasoning.delta", text: value.delta }]
}

function call(value: Record<string, unknown>, ids: Map<string, number>): NativeGenerationEvent[] {
  const item = object(value.item)
  if (value.type === "response.output_item.added" && item?.type === "function_call") {
    const index = Number.isSafeInteger(value.output_index) ? (value.output_index as number) : ids.size
    if (typeof item.id === "string") ids.set(item.id, index)
    return [
      {
        type: "tool.delta",
        index,
        ...(typeof item.call_id === "string" ? { callID: item.call_id } : {}),
        ...(typeof item.name === "string" ? { name: item.name } : {}),
        arguments: "",
      },
    ]
  }
  if (value.type !== "response.function_call_arguments.delta" || typeof value.delta !== "string") return []
  const index = ids.get(typeof value.item_id === "string" ? value.item_id : "")
  return index == null ? [] : [{ type: "tool.delta", index, arguments: value.delta }]
}

function completed(value: Record<string, unknown>): NativeGenerationEvent[] {
  const usage = object(object(value.response)?.usage)
  const cached = object(usage?.input_tokens_details)
  const reasoning = object(usage?.output_tokens_details)
  return [
    ...(usage
      ? [
          {
            type: "usage" as const,
            usage: {
              input: count(usage.input_tokens),
              output: count(usage.output_tokens),
              reasoning: count(reasoning?.reasoning_tokens),
              cacheRead: count(cached?.cached_tokens),
              cacheWrite: 0,
            } satisfies NativeUsage,
          },
        ]
      : []),
    { type: "done", finishReason: "completed" },
  ]
}

function translate(value: Record<string, unknown>, ids: Map<string, number>): NativeGenerationEvent[] {
  if (value.type === "response.output_text.delta") return text(value)
  if (value.type === "response.reasoning_text.delta" || value.type === "response.reasoning_summary_text.delta") {
    return text(value)
  }
  if (value.type === "response.output_item.added" || value.type === "response.function_call_arguments.delta") {
    return call(value, ids)
  }
  if (value.type === "response.completed") return completed(value)
  if (value.type === "response.failed" || value.type === "error") {
    const error = object(value.error)
    throw new NativeProviderError(
      typeof error?.message === "string" ? error.message : "OpenAI Responses request failed",
      false,
    )
  }
  return []
}

function pause(value: number, signal: AbortSignal) {
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
      const chunk = await reader.read()
      if (chunk.done) break
      const value = chunk.value.subarray(0, bytes.length - size)
      bytes.set(value, size)
      size += value.length
      if (value.length < chunk.value.length || size === bytes.length) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(bytes.subarray(0, Math.min(size, 16_384)))
}

async function send(url: URL, headers: Headers, body: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    let response: Response
    try {
      response = await fetch(url, { method: "POST", headers, body, signal, redirect: "error" })
    } catch (err) {
      if (signal.aborted) throw signal.reason
      if (attempt === 2)
        throw new NativeProviderError("OpenAI Responses request failed", true, undefined, { cause: err })
      await pause(500 * (attempt + 1), signal)
      continue
    }
    if (response.ok) return response
    const text = await errorText(response)
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500
    if (!retryable || attempt === 2) {
      throw new NativeProviderError(
        `OpenAI Responses returned HTTP ${response.status}${text ? `: ${text}` : ""}`,
        retryable,
        response.status,
      )
    }
    const after = Number(response.headers.get("retry-after"))
    await pause(Number.isFinite(after) ? Math.max(0, Math.min(after * 1000, 15_000)) : 500 * (attempt + 1), signal)
  }
  throw new NativeProviderError("OpenAI Responses attempts were exhausted", true)
}

async function* events(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<NativeGenerationEvent> {
  const ids = new Map<string, number>()
  let finished = false
  for await (const frame of parseSse(body, signal)) {
    signal.throwIfAborted()
    if (frame.data === "[DONE]") {
      finished = true
      break
    }
    let value: unknown
    try {
      value = JSON.parse(frame.data)
    } catch (err) {
      throw new NativeProviderError("OpenAI Responses returned invalid event JSON", false, undefined, { cause: err })
    }
    const item = object(value)
    if (!item) throw new NativeProviderError("OpenAI Responses returned an invalid event payload", false)
    for (const event of translate(item, ids)) {
      if (event.type === "done") finished = true
      yield event
    }
  }
  if (!finished) throw new NativeProviderError("OpenAI Responses stream ended before completion", true)
}

export async function* streamOpenAIResponses(request: NativeCompletionRequest): AsyncGenerator<NativeGenerationEvent> {
  if (!request.apiKey) throw new NativeProviderError("Connect the OpenAI provider before using it", false)
  const timeout = AbortSignal.timeout(Math.max(1_000, Math.min(request.timeoutMs ?? 120_000, 600_000)))
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
  const target = endpoint(request.endpoint, request.apiKey, request.headers)
  const prompt = input(request.messages)
  const body = JSON.stringify({
    model: request.model,
    input: prompt.input,
    ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
    stream: true,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          })),
        }
      : {}),
    ...(request.maxTokens == null ? {} : { max_output_tokens: request.maxTokens }),
    ...(request.temperature == null ? {} : { temperature: request.temperature }),
  })
  const response = await send(target.url, target.headers, body, signal)
  if (!response.body) throw new NativeProviderError("OpenAI Responses returned an empty stream", true, response.status)
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
    throw new NativeProviderError("OpenAI Responses returned an unexpected content type", false, response.status)
  }
  yield* events(response.body, signal)
}
