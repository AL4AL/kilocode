// kilocode_change - new file
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import { Provider } from "@/provider/provider"
import { get, poll, TERMINAL, type BatchInfo } from "./batch"
import { fromResult } from "./batch-completion"
import { OpenRouterBatchStore, type PendingBatch } from "./batch-store"
import { setWaitingBatch, clearWaitingBatch } from "./batch-status"
import { OpenRouterBatchBackfill } from "./batch-backfill"

const log = Log.create({ service: "openrouter.batch-resume" })

async function runtime() {
  const { AppRuntime } = await import("@/effect/app-runtime")
  return AppRuntime
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
  const item = info.results?.find((r) => r.custom_id === row.customId) ?? info.results?.[0]
  if (!item) {
    log.warn("batch resume missing result item", { batchId: row.batchId, customId: row.customId })
    OpenRouterBatchStore.clear(row.customId)
    return
  }
  const events = fromResult(item)
  const model = await modelFor(row)
  const app = await runtime()
  const ok = await app.runPromise(
    OpenRouterBatchBackfill.apply({
      sessionID: row.sessionID,
      userMessageID: row.userMessageID,
      model,
      events,
    }),
  )
  if (ok) {
    clearWaitingBatch(row.sessionID)
    log.info("batch resume backfilled assistant", { batchId: row.batchId, sessionID: row.sessionID })
    return
  }
  OpenRouterBatchStore.clear(row.customId)
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
    if (TERMINAL.has(final.status)) {
      if (final.status === "completed") await finishCompleted(row, final, opts)
      else OpenRouterBatchStore.clear(row.customId)
      clearWaitingBatch(row.sessionID)
    }
  } catch (err) {
    log.warn("batch resume poll failed", { batchId: row.batchId, err })
    clearWaitingBatch(row.sessionID)
  }
}

/** On instance start, drop stale rows whose batch already finished on OpenRouter. */
export async function sweepPending(opts?: { fetch?: typeof fetch }) {
  const rows = OpenRouterBatchStore.list()
  if (rows.length === 0) return
  for (const row of rows) {
    const token = row.providerID === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined
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
      void pollPending(row, token, opts)
    } catch (err) {
      log.warn("batch resume sweep failed", { batchId: row.batchId, err })
    }
  }
}
