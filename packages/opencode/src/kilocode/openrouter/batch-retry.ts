// kilocode_change - new file
import type { MessageV2 } from "@/session/message-v2"
import { OpenRouterBatchStore } from "./batch-store"
import type { SessionID } from "@/session/schema"
import type { MessageID } from "@/session/schema"

const patterns = [
  /unsupported\s+['"]?reasoning['"]?\s+content/i,
  /unsupported\s+['"]?tool-call['"]?\s+content/i,
  /tool messages must include.*tool_call_id/i,
  /preflight failed for batch request/i,
  /unsupported\s+reasoning/i,
  /unsupported\s+tool-call/i,
  /batch item failed/i,
  /openrouter batch/i,
]

function text(error: unknown) {
  if (error == null) return ""
  if (typeof error === "string") return error
  if (typeof error !== "object") return String(error)
  const row = error as { message?: unknown; data?: { message?: unknown } }
  if (typeof row.message === "string") return row.message
  if (row.data && typeof row.data.message === "string") return row.data.message
  return ""
}

export namespace OpenRouterBatchRetry {
  /** Batch validation / item errors that clear with normalized history and a fresh POST. */
  export function retryableError(error: unknown) {
    const msg = text(error)
    if (msg.length === 0) return false
    return patterns.some((re) => re.test(msg))
  }

  export function retryableAssistant(assistant: MessageV2.WithParts | undefined) {
    if (!assistant || assistant.info.role !== "assistant") return false
    if (!assistant.info.error) return false
    return retryableError(assistant.info.error)
  }

  export function clearForResume(input: {
    sessionID: SessionID
    assistantMessageID: MessageID
    userMessageID?: MessageID
  }) {
    OpenRouterBatchStore.clearSession(input.sessionID)
    if (input.userMessageID) OpenRouterBatchStore.clear(`kilo-${input.userMessageID}`)
  }
}