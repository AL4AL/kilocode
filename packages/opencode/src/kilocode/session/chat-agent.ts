// kilocode_change - new file
import type { ModelMessage } from "ai"
import type { Agent } from "@/agent/agent"

export const CHAT_AGENT = "chat"

export function isChat(agent: string | Agent.Info) {
  const name = typeof agent === "string" ? agent : agent.name
  return name === CHAT_AGENT
}

/** History-only messages for chat agent (no system-role rows). */
export function chatMessages(messages: ModelMessage[]) {
  return messages.filter((m) => m.role === "user" || m.role === "assistant")
}

export function chatToolChoice(agent: string | Agent.Info): "none" | undefined {
  return isChat(agent) ? "none" : undefined
}
