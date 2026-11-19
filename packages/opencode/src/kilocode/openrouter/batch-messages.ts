// kilocode_change - new file
import type { ModelMessage } from "ai"

type Part = { type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown }

type Assistant = Extract<ModelMessage, { role: "assistant" }>
type AssistantParts = Extract<Assistant["content"], unknown[]>

function thinking(part: AssistantParts[number]) {
  if (part.type !== "reasoning") return ""
  return part.text.trim()
}

function stripReasoning(content: AssistantParts) {
  return content.filter((p) => p.type !== "reasoning") as AssistantParts
}

function mergeThought(content: AssistantParts, thought: string): AssistantParts {
  if (thought.length === 0) return content
  const next = [...content]
  const i = next.findIndex((p) => p.type === "text")
  if (i >= 0) {
    const part = next[i]
    if (part.type !== "text") return next
    const tail = part.text.trim()
    next[i] = { ...part, text: tail.length > 0 ? `${thought}\n\n${part.text}` : thought }
    return next
  }
  return [{ type: "text", text: thought }, ...next]
}

function scrubReasoning(msg: ModelMessage): ModelMessage {
  if (!Array.isArray(msg.content)) return msg
  const parts = msg.content as AssistantParts
  if (!parts.some((p) => p.type === "reasoning")) return msg
  if (msg.role !== "assistant") return { ...msg, content: stripReasoning(parts) } as ModelMessage
  const thought = parts
    .map((p) => thinking(p))
    .filter((t) => t.length > 0)
    .join("\n\n")
  const bare = stripReasoning(parts)
  if (!bare.some((p) => p.type === "tool-call")) return { ...msg, content: bare }
  return { ...msg, content: mergeThought(bare, thought) }
}

function args(input: unknown) {
  if (typeof input === "string") return input
  return JSON.stringify(input ?? {})
}

function output(value: unknown) {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "object" && "type" in value && (value as Part).type === "text" && "value" in value)
    return String((value as { value: unknown }).value)
  return JSON.stringify(value)
}

type BatchWire = Record<string, unknown> & { role: string }

/** OpenRouter batch chat/completions rejects reasoning + ai-sdk tool-call parts in history. */
export function normalizeBatchMessages(msgs: ModelMessage[]): BatchWire[] {
  const scrubbed = msgs.map(scrubReasoning)
  const wire: BatchWire[] = []
  for (const msg of scrubbed) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const parts = msg.content as Part[]
      const calls = parts.filter((p) => p.type === "tool-call")
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
        .trim()
      if (calls.length === 0) {
        if (text.length > 0) wire.push({ role: "assistant", content: text })
        else if (typeof msg.content === "string") wire.push({ role: "assistant", content: msg.content })
        continue
      }
      wire.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        tool_calls: calls.map((call) => ({
          id: call.toolCallId ?? "",
          type: "function",
          function: {
            name: call.toolName ?? "",
            arguments: args(call.input),
          },
        })),
      })
      continue
    }
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content as Part[]) {
        if (part.type !== "tool-result") continue
        const id = part.toolCallId ?? ""
        if (id.length === 0) continue
        wire.push({
          role: "tool",
          content: output(part.output),
          tool_call_id: id,
        })
      }
      continue
    }
    if (msg.role === "tool" && typeof (msg as unknown as { toolCallId?: string }).toolCallId === "string") {
      const id = (msg as unknown as { toolCallId: string }).toolCallId
      if (id.length === 0) continue
      wire.push({
        role: "tool",
        content: typeof msg.content === "string" ? msg.content : output(msg.content),
        tool_call_id: id,
      })
      continue
    }
    if (Array.isArray(msg.content) && msg.content.some((p) => (p as Part).type === "tool-call" || (p as Part).type === "tool-result")) {
      const text = (msg.content as Part[])
        .filter((p) => p.type === "text")
        .map((p) => p.text ?? "")
        .join("\n")
      if (text.length > 0) wire.push({ role: msg.role, content: text })
      continue
    }
    if (typeof msg.content === "string" || msg.content == null) {
      wire.push({ role: msg.role, content: msg.content ?? "" })
      continue
    }
    wire.push(msg as BatchWire)
  }
  return wire
}