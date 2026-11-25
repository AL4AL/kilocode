import Anthropic, { type Anthropic as AnthropicTypes } from "@anthropic-ai/sdk"
import type {
  NativeChatMessage,
  NativeCompletionRequest,
  NativeGenerationEvent,
  NativeUsage,
} from "./openai-compatible"
import { NativeProviderError } from "./openai-compatible"
import { providerURL } from "./url"

type Message = AnthropicTypes.MessageParam
type Block = AnthropicTypes.ContentBlockParam

function base(value: string, credentials: boolean) {
  const url = providerURL(value, credentials)
  url.search = ""
  url.hash = ""
  url.pathname = url.pathname.replace(/\/(v1\/messages|v1)\/?$/i, "")
  return url.toString().replace(/\/$/, "")
}

function add(messages: Message[], role: Message["role"], block: Block) {
  const last = messages.at(-1)
  if (last?.role === role && Array.isArray(last.content)) {
    last.content.push(block)
    return
  }
  messages.push({ role, content: [block] })
}

function parsed(value: string): Record<string, unknown> {
  try {
    const result: unknown = JSON.parse(value)
    if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>
  } catch (err) {
    throw new NativeProviderError("Provider returned invalid tool arguments", false, undefined, { cause: err })
  }
  throw new NativeProviderError("Provider returned invalid tool arguments", false)
}

function messages(input: NativeChatMessage[]) {
  const output: Message[] = []
  const system: string[] = []
  for (const msg of input) {
    if (msg.role === "system") {
      if (msg.content) system.push(msg.content)
      continue
    }
    if (msg.role === "tool") {
      if (!msg.tool_call_id) continue
      add(output, "user", {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: msg.content ?? "",
        ...(msg.content?.startsWith("Error:") ? { is_error: true } : {}),
      })
      continue
    }
    if (msg.role === "user") {
      add(output, "user", { type: "text", text: msg.content ?? "" })
      continue
    }
    if (msg.content) add(output, "assistant", { type: "text", text: msg.content })
    for (const call of msg.tool_calls ?? []) {
      add(output, "assistant", {
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: parsed(call.function.arguments),
      })
    }
  }
  return { messages: output, system: system.join("\n\n") }
}

function usage(value: AnthropicTypes.Usage, output = value.output_tokens): NativeUsage {
  return {
    input: value.input_tokens,
    output,
    reasoning: 0,
    cacheRead: value.cache_read_input_tokens ?? 0,
    cacheWrite: value.cache_creation_input_tokens ?? 0,
  }
}

function translate(event: AnthropicTypes.RawMessageStreamEvent, reason?: string): NativeGenerationEvent[] {
  if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
    return [
      {
        type: "tool.delta",
        index: event.index,
        callID: event.content_block.id,
        name: event.content_block.name,
        arguments: "",
      },
    ]
  }
  if (event.type === "content_block_delta") {
    if (event.delta.type === "text_delta") return [{ type: "text.delta", text: event.delta.text }]
    if (event.delta.type === "thinking_delta") return [{ type: "reasoning.delta", text: event.delta.thinking }]
    if (event.delta.type === "input_json_delta") {
      return [{ type: "tool.delta", index: event.index, arguments: event.delta.partial_json }]
    }
  }
  if (event.type === "message_stop") return [{ type: "done", ...(reason ? { finishReason: reason } : {}) }]
  return []
}

function client(request: NativeCompletionRequest) {
  if (!request.apiKey) throw new NativeProviderError("Connect the Anthropic provider before using it", false)
  return new Anthropic({
    apiKey: request.apiKey,
    baseURL: base(request.endpoint, true),
    defaultHeaders: request.headers,
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
    maxRetries: Math.max(0, Math.min(request.retries ?? 2, 3)),
    timeout: Math.max(1_000, Math.min(request.timeoutMs ?? 120_000, 600_000)),
  })
}

function params(request: NativeCompletionRequest) {
  const prompt = messages(request.messages)
  return {
    model: request.model,
    max_tokens: request.maxTokens ?? 4096,
    messages: prompt.messages,
    ...(prompt.system ? { system: prompt.system } : {}),
    ...(request.temperature == null ? {} : { temperature: request.temperature }),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters as AnthropicTypes.Tool["input_schema"],
          })),
        }
      : {}),
  }
}

async function* events(
  stream: AsyncIterable<AnthropicTypes.RawMessageStreamEvent>,
  signal?: AbortSignal,
): AsyncGenerator<NativeGenerationEvent> {
  let ended = false
  let reason: string | undefined
  let tokens: NativeUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  try {
    for await (const event of stream) {
      if (event.type === "message_start") {
        tokens = usage(event.message.usage, 0)
        yield { type: "usage", usage: tokens }
        continue
      }
      if (event.type === "message_delta") {
        tokens = { ...tokens, output: event.usage.output_tokens }
        reason = event.delta.stop_reason ?? reason ?? undefined
        yield { type: "usage", usage: tokens }
        continue
      }
      for (const item of translate(event, reason)) {
        if (item.type === "done") ended = true
        yield item
      }
    }
  } catch (err) {
    if (signal?.aborted) throw signal.reason
    const status =
      err && typeof err === "object" && "status" in err && typeof err.status === "number" ? err.status : undefined
    const text = err instanceof Error ? err.message : String(err)
    throw new NativeProviderError(text, status == null || status === 429 || status >= 500, status, { cause: err })
  }
  if (!ended) throw new NativeProviderError("Anthropic stream ended before completion", true)
}

export async function* streamAnthropic(request: NativeCompletionRequest): AsyncGenerator<NativeGenerationEvent> {
  const stream = client(request).messages.stream(params(request), { signal: request.signal })
  yield* events(stream, request.signal)
}
