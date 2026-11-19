import type { ModelMessage } from "ai"
import { MessageV2 } from "@/session/message-v2"
import { OpenRouterBatchRetry } from "@/kilocode/openrouter/batch-retry"
import { KiloSessionMessageOrder } from "./message-order"
import { KiloSessionControl } from "./control"
import type { MessageID } from "@/session/schema"

function turn(messages: MessageV2.WithParts[], user: MessageV2.WithParts, assistant: MessageV2.WithParts) {
  if (assistant.info.role !== "assistant") return undefined
  if (assistant.info.parentID !== user.info.id || assistant.info.summary) return undefined
  if (
    KiloSessionMessageOrder.compare(
      user,
      assistant,
      messages.indexOf(user),
      messages.indexOf(assistant),
    ) >= 0
  )
    return undefined
  if (user.parts.some((part) => part.type === "subtask" || part.type === "compaction")) return undefined
  if (
    messages
      .slice(messages.indexOf(user) + 1)
      .some((message) =>
        message.parts.some(
          (part) => part.type === "tool" && part.tool === "plan_exit" && part.state.status === "completed",
        ),
      )
  )
    return undefined
  if (MessageV2.AbortedError.isInstance(assistant.info.error)) return assistant.info.id
  if (assistant.info.error) {
    if (OpenRouterBatchRetry.retryableError(assistant.info.error)) return assistant.info.id
    return undefined
  }
  return !assistant.info.finish || assistant.info.finish === "tool-calls" ? assistant.info.id : undefined
}

export namespace KiloSessionContinuation {
  export function resumable(messages: MessageV2.WithParts[], messageID: MessageID) {
    const row = messages.find((message) => message.info.id === messageID)
    if (!row || row.info.role !== "assistant") return false
    const parent = row.info.parentID
    if (!parent) return false
    const user = messages.find((message) => message.info.id === parent)
    if (!user || user.info.role !== "user") return false
    return turn(messages, user, row) === messageID
  }

  export function target(messages: MessageV2.WithParts[]) {
    const answered = new Set(
      messages.flatMap((message) => (message.info.role === "assistant" ? [message.info.parentID] : [])),
    )
    const latest = KiloSessionMessageOrder.latest(
      messages.filter(
        (message) =>
          message.info.role !== "user" ||
          answered.has(message.info.id) ||
          !KiloSessionControl.background(message.parts),
      ),
    )
    const user = latest.userMessage
    const assistant = latest.assistantMessage
    if (!user || !assistant) return undefined
    return turn(messages, user, assistant)
  }

  export function context(resume: boolean): ModelMessage[] {
    if (!resume) return []
    return [
      {
        role: "user",
        content:
          "[TASK RESUMPTION] Resume the interrupted task using the existing conversation. Check the current state before retrying interrupted tools. Do not repeat work that already completed.",
      },
    ]
  }
}
