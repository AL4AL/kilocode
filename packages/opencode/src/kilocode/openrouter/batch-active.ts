// kilocode_change - new file
import type { SessionID } from "@/session/schema"
import { cancel as cancelBatch } from "./batch"
import { OpenRouterBatchStore } from "./batch-store"

type Active = {
  batchId: string
  customId: string
  abort: AbortController
  token: string
  fetch?: typeof fetch
}

const active = new Map<SessionID, Active>()

export namespace OpenRouterBatchActive {
  export function set(sessionID: SessionID, row: Active) {
    active.set(sessionID, row)
  }

  export function get(sessionID: SessionID) {
    return active.get(sessionID)
  }

  export function clear(sessionID: SessionID) {
    active.delete(sessionID)
  }

  export async function cancelTurn(sessionID: SessionID) {
    const row = active.get(sessionID)
    if (row) {
      row.abort.abort()
      try {
        await cancelBatch({ token: row.token, id: row.batchId, fetch: row.fetch })
      } catch {
        // best effort
      }
      OpenRouterBatchStore.clear(row.customId)
      active.delete(sessionID)
      return true
    }
    const pending = OpenRouterBatchStore.bySession(sessionID)
    if (pending.length === 0) return false
    for (const p of pending) {
      OpenRouterBatchStore.clear(p.customId)
    }
    return true
  }
}
