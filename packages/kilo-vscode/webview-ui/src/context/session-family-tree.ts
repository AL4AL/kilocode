import type { Message, ToolPart } from "../types/messages"
import { childID } from "./session-utils"
import { fanoutIds } from "./fanout-family"

export function visibleToolParts(
  toolParts: Record<string, ToolPart[] | undefined>,
  sessionID: string,
  messages: Message[],
): ToolPart[] {
  const tools = toolParts[sessionID]
  if (!tools || tools.length === 0 || messages.length === 0) return []
  const ids = new Set(messages.map((msg) => msg.id))
  return tools.filter((part) => !part.messageID || ids.has(part.messageID))
}

/** BFS over task tool metadata to collect child session ids for a root session. */
export function sessionIDs(
  toolParts: Record<string, ToolPart[] | undefined>,
  rootID: string,
  source: (sessionID: string) => Message[],
): Set<string> {
  const ids = new Set<string>([rootID])
  const queue = [rootID]
  while (queue.length > 0) {
    const sid = queue.pop()!
    const tools = toolParts[sid]
    if (!tools || tools.length === 0 || !tools.some((t) => t.tool === "task")) continue
    for (const p of visibleToolParts(toolParts, sid, source(sid))) {
      const child = childID(
        p as {
          type: string
          tool?: string
          metadata?: { sessionId?: string }
          state?: { metadata?: { sessionId?: string } }
        },
      )
      if (child && !ids.has(child)) {
        ids.add(child)
        queue.push(child)
      }
    }
  }
  return ids
}

export function sessionFamily(rootID: string, children: (id: string) => readonly string[]): Set<string> {
  const ids = new Set([rootID])
  for (const id of ids) {
    for (const child of children(id)) ids.add(child)
  }
  for (const id of fanoutIds(rootID)) ids.add(id)
  return ids
}