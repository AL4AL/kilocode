// kilocode_change - new file
import { Usage, type LLMEvent } from "@opencode-ai/llm"
import type { BatchResultItem } from "./batch"

const blockId = () => `batch_${Math.random().toString(36).slice(2, 10)}`

type ChatCompletion = {
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string | null
      tool_calls?: Array<{ id: string; type?: string; function?: { name: string; arguments: string } }>
      reasoning?: string
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    cost?: number
    cost_details?: { upstream_inference_cost?: number }
  }
}

function providerMetadata(body: ChatCompletion | undefined) {
  if (!body?.usage) return undefined
  const usage = body.usage
  if (usage.cost == null && usage.cost_details == null) return undefined
  return {
    openrouter: {
      usage: {
        cost: usage.cost,
        costDetails: usage.cost_details
          ? { upstreamInferenceCost: usage.cost_details.upstream_inference_cost }
          : undefined,
      },
    },
  }
}

function parseBody(raw: unknown): ChatCompletion | undefined {
  if (raw == null) return undefined
  if (typeof raw === "object") return raw as ChatCompletion
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as ChatCompletion
    } catch {
      return undefined
    }
  }
  return undefined
}

function bodyError(body: ChatCompletion | undefined): string | undefined {
  if (body == null || typeof body !== "object") return undefined
  const raw = (body as { error?: { message?: string; code?: string } }).error
  if (typeof raw?.message === "string" && raw.message.length > 0) return raw.message
  return undefined
}

export function fromResult(item: BatchResultItem | undefined): LLMEvent[] {
  if (item == null) throw new Error("Batch completed without result item")
  if (item.error?.message) throw new Error(item.error.message)
  const status = item.response?.status_code
  if (status != null && status >= 400) {
    throw new Error(`Batch item failed (${status})`)
  }
  const body = parseBody(item.response?.body)
  if (!body?.choices?.length) {
    const upstream = bodyError(body)
    throw new Error(
      upstream ??
        "Batch completed without chat completion body (OpenRouter job finished; upstream provider returned no completion)",
    )
  }

  const choice = body.choices[0]!
  const message = choice.message ?? {}
  const events: LLMEvent[] = [{ type: "step-start", index: 0 }]

  if (typeof message.reasoning === "string" && message.reasoning.length > 0) {
    const rid = blockId()
    events.push({ type: "reasoning-start", id: rid })
    events.push({ type: "reasoning-delta", id: rid, text: message.reasoning })
    events.push({ type: "reasoning-end", id: rid })
  }

  const text = typeof message.content === "string" ? message.content : ""
  if (text.length > 0) {
    const tid = blockId()
    events.push({ type: "text-start", id: tid })
    events.push({ type: "text-delta", id: tid, text })
    events.push({ type: "text-end", id: tid })
  }

  const calls = message.tool_calls ?? []
  for (const call of calls) {
    const name = call.function?.name ?? ""
    let args: unknown = call.function?.arguments ?? "{}"
    if (typeof args === "string") {
      try {
        args = JSON.parse(args)
      } catch {
        args = {}
      }
    }
    events.push({
      type: "tool-call",
      id: call.id,
      name,
      input: args,
    })
  }

  const reason =
    choice.finish_reason === "length"
      ? "length"
      : choice.finish_reason === "tool_calls"
        ? "tool-calls"
        : choice.finish_reason === "content_filter"
          ? "content-filter"
          : "stop"

  const usage =
    body.usage?.prompt_tokens != null || body.usage?.completion_tokens != null
      ? Usage.from({
          inputTokens: body.usage?.prompt_tokens,
          outputTokens: body.usage?.completion_tokens,
          totalTokens: body.usage?.total_tokens,
        })
      : undefined
  const meta = providerMetadata(body)

  events.push({ type: "step-finish", index: 0, reason, usage, providerMetadata: meta })
  events.push({ type: "finish", reason, usage, providerMetadata: meta })
  return events
}
