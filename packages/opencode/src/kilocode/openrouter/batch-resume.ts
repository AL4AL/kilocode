// kilocode_change - new file
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { batchFailureMessage, get, poll, TERMINAL, type BatchInfo } from "./batch"
import { fromResult } from "./batch-completion"
import { resolveOpenRouterKey } from "./batch-transport"
import { OpenRouterBatchStore, type PendingBatch } from "./batch-store"
import { setWaitingBatch, clearWaitingBatch } from "./batch-status"
import { OpenRouterBatchPostCompletion } from "./batch-post-completion"
import { OpenRouterBatchActive } from "./batch-active"
import { SessionPrompt } from "@/session/prompt"
import type { SessionID } from "@/session/schema"

const log = Log.create({ service: "openrouter.batch-resume" })

const POLL_TICK_MS = 5_000
const polling = new Set<string>()

async function runtime() {
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime
}

async function tokenFor(providerID: string) {
  try {
    const app = await runtime()
    const auth = await app.runPromise(Auth.Service.pipe(Effect.flatMap((a) => a.get(providerID))))
    return resolveOpenRouterKey({ auth, env: process.env })
  } catch (err) {
    log.warn("batch resume auth lookup failed", { err })
    return resolveOpenRouterKey({ env: process.env })
  }
}

async function modelFor(row: PendingBatch) {
  try {
    const app = await runtime()
    const providers = await app.runPromise(Provider.Service.pipe(Effect.flatMap((p) => p.list())))
    const provider = providers[row.providerID as keyof typeof providers]
    const mdl = provider?.models[row.model] ?? provider?.models[`${row.model}-batch`]
    if (mdl) return mdl
  } catch (err) {
    log.warn("batch resume model lookup failed", { err })
  }
  return {
    providerID: row.providerID,
    api: { id: row.model, npm: "@openrouter/ai-sdk-provider" },
    openrouterBatch: true,
  } as Provider.Model
}

async function finishCompleted(row: PendingBatch, info: BatchInfo, opts?: { fetch?: typeof fetch }) {
  if (OpenRouterBatchActive.get(row.sessionID)) return
  const item = info.results?.find((r) => r.custom_id === row.customId) ?? info.results?.[0]
  if (!item) {
    log.warn("batch resume missing result item", { batchId: row.batchId, customId: row.customId })
    return
  }
  let events
  try {
    events = fromResult(item)
  } catch (err) {
    OpenRouterBatchStore.clear(row.customId)
    clearWaitingBatch(row.sessionID)
    log.warn("batch resume upstream result unusable", {
      batchId: row.batchId,
      customId: row.customId,
      err,
    })
    return
  }
  const model = await modelFor(row)
  const app = await runtime()
  const outcome = await app.runPromise(
    OpenRouterBatchPostCompletion.run({
      sessionID: row.sessionID,
      userMessageID: row.userMessageID,
      model,
      events,
      customId: row.customId,
      batchId: row.batchId,
    }),
  )
  if (outcome.persisted || outcome.dispatched) {
    OpenRouterBatchStore.clear(row.customId)
    clearWaitingBatch(row.sessionID)
    log.info("batch resume post-completion", {
      batchId: row.batchId,
      sessionID: row.sessionID,
      persisted: outcome.persisted,
      dispatched: outcome.dispatched,
      continued: outcome.continued,
    })
    const sid = row.sessionID as SessionID
    await app.runPromise(SessionPrompt.Service.pipe(Effect.flatMap((svc) => svc.titleIfDefault(sid)))).catch((err) => {
      log.warn("batch resume title after backfill failed", { sessionID: sid, err })
    })
    return
  }
  log.warn("batch post-completion made no progress", {
    batchId: row.batchId,
    sessionID: row.sessionID,
    skippedReason: outcome.skippedReason,
  })
}

async function pollPending(row: PendingBatch, token: string, opts?: { fetch?: typeof fetch }) {
  setWaitingBatch({
    sessionID: row.sessionID,
    batchId: row.batchId,
    customId: row.customId,
    modelId: row.model,
  })
  try {
    const final = await poll({ token, id: row.batchId, fetch: opts?.fetch })
    if (final.status === "completed") await finishCompleted(row, final, opts)
    else {
      OpenRouterBatchStore.clear(row.customId)
      clearWaitingBatch(row.sessionID)
      log.warn("batch ended without completion", { batchId: row.batchId, message: batchFailureMessage(final) })
    }
  } catch (err) {
    log.warn("batch resume poll interrupted", { batchId: row.batchId, err })
  }
}

function startPoll(row: PendingBatch, token: string, opts?: { fetch?: typeof fetch }) {
  if (OpenRouterBatchActive.get(row.sessionID)) return
  if (polling.has(row.batchId)) return
  polling.add(row.batchId)
  void pollPending(row, token, opts).finally(() => polling.delete(row.batchId))
}

/** Re-register a batch so sweep can backfill after serve restart (no new OpenRouter POST). */
export function trackPending(row: PendingBatch) {
  OpenRouterBatchStore.upsert(row)
  void sweepPending()
}

/** Reconcile local pending rows with OpenRouter; start long poll loops for in-flight batches. */
export async function sweepPending(opts?: { fetch?: typeof fetch }) {
  const rows = OpenRouterBatchStore.list()
  if (rows.length === 0) return
  for (const row of rows) {
    const token = await tokenFor(row.providerID)
    if (!token) continue
    try {
      const info = await get({ token, id: row.batchId, fetch: opts?.fetch })
      if (info.status === "completed") {
        await finishCompleted(row, info, opts)
        continue
      }
      if (TERMINAL.has(info.status)) {
        OpenRouterBatchStore.clear(row.customId)
        clearWaitingBatch(row.sessionID)
        log.info("cleared terminal batch row", { batchId: row.batchId, status: info.status })
        continue
      }
      startPoll(row, token, opts)
    } catch (err) {
      log.warn("batch resume sweep GET failed; polling", { batchId: row.batchId, err })
      startPoll(row, token, opts)
    }
  }
}

let armed = false

/** While `kilo serve` runs (extension enabled), sweep every 5s and poll until batches finish. */
export function armBatchResumeLoop(opts?: { fetch?: typeof fetch }) {
  if (armed) return
  armed = true
  const tick = () => void sweepPending(opts).catch((err) => log.warn("batch sweep tick failed", { err }))
  tick()
  setInterval(tick, POLL_TICK_MS)
}
