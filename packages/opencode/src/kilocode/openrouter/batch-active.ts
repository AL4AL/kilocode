// kilocode_change - new file
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { Auth } from "@/auth"
import type { SessionID } from "@/session/schema"
import { cancel as cancelBatch, waitUntilGone } from "./batch"
import { clearWaitingBatch, setCancellingBatch } from "./batch-status"
import { resolveOpenRouterKey } from "./batch-transport"
import { OpenRouterBatchStore } from "./batch-store"

const log = Log.create({ service: "openrouter.batch-active" })

type Active = {
  batchId: string
  customId: string
  abort: AbortController
  token: string
  fetch?: typeof fetch
}

const active = new Map<SessionID, Active>()

async function tokenFor(providerID: string) {
  try {
    const { AppRuntime } = await import("@/effect/app-runtime")
    const auth = await AppRuntime.runPromise(Auth.Service.pipe(Effect.flatMap((a) => a.get(providerID))))
    return resolveOpenRouterKey({ auth, env: process.env })
  } catch (err) {
    log.warn("batch cancel auth lookup failed", { err })
    return resolveOpenRouterKey({ env: process.env })
  }
}

type Target = {
  batchId: string
  customId: string
  modelId: string
  token: string
  fetch?: typeof fetch
  abort?: AbortController
}

function targets(sessionID: SessionID): Target[] {
  const rows = new Map<string, Target>()
  const live = active.get(sessionID)
  if (live) {
    const pending = OpenRouterBatchStore.byCustom(live.customId)
    rows.set(live.customId, {
      batchId: live.batchId,
      customId: live.customId,
      modelId: pending?.model ?? "",
      token: live.token,
      fetch: live.fetch,
      abort: live.abort,
    })
  }
  for (const row of OpenRouterBatchStore.bySession(sessionID)) {
    if (rows.has(row.customId)) continue
    rows.set(row.customId, {
      batchId: row.batchId,
      customId: row.customId,
      modelId: row.model,
      token: "",
      fetch: undefined,
    })
  }
  return [...rows.values()]
}

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
    const list = targets(sessionID)
    if (list.length === 0) return false

    for (const row of list) {
      const token = row.token || (await tokenFor("openrouter"))
      if (!token) {
        log.warn("batch cancel missing token", { batchId: row.batchId })
        OpenRouterBatchStore.clear(row.customId)
        continue
      }
      setCancellingBatch({
        sessionID,
        batchId: row.batchId,
        customId: row.customId,
        modelId: row.modelId,
      })
      try {
        await cancelBatch({ token, id: row.batchId, fetch: row.fetch })
        await waitUntilGone({ token, id: row.batchId, fetch: row.fetch })
      } catch (err) {
        log.warn("batch cancel verify failed", { batchId: row.batchId, err })
      }
      row.abort?.abort()
      OpenRouterBatchStore.clear(row.customId)
    }
    active.delete(sessionID)
    clearWaitingBatch(sessionID)
    return true
  }
}
