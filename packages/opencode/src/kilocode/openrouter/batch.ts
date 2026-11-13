// kilocode_change - new file
import { Schema } from "effect"

export const BASE = "https://openrouter.ai/api/v1/batches"

const pollMs = () => {
  const raw = process.env.KILO_OPENROUTER_BATCH_POLL_MS
  const n = raw ? Number(raw) : 60_000
  return Number.isFinite(n) && n > 0 ? n : 60_000
}

const timeoutMs = () => {
  const raw = process.env.KILO_OPENROUTER_BATCH_TIMEOUT_MS
  const n = raw ? Number(raw) : 25 * 60 * 60_000
  return Number.isFinite(n) && n > 0 ? n : 25 * 60 * 60_000
}

export const BatchStatus = Schema.Literals([
  "validating",
  "in_progress",
  "finalizing",
  "completed",
  "failed",
  "expired",
  "cancelling",
  "cancelled",
] as const)

export type BatchStatus = Schema.Schema.Type<typeof BatchStatus>

export const TERMINAL = new Set<BatchStatus>(["completed", "failed", "expired", "cancelled"])

export type BatchError = { code?: number; message: string }

export type BatchUsage = {
  input?: number
  output?: number
  total?: number
}

export type BatchResultItem = {
  custom_id: string
  response?: { status_code?: number; body?: unknown }
  error?: { message?: string }
}

export type BatchInfo = {
  id: string
  status: BatchStatus
  model?: string
  results?: BatchResultItem[] | null
  error?: BatchError
  usage?: BatchUsage
}

export type CreateInput = {
  endpoint: "/v1/chat/completions"
  model: string
  customId: string
  body: Record<string, unknown>
  provider?: { only?: string[]; allow_fallbacks?: boolean }
}

export type FetchLike = typeof fetch

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
    const id = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id)
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      },
      { once: true },
    )
  })

export function buildCreateBody(input: CreateInput) {
  const out: Record<string, unknown> = {
    endpoint: input.endpoint,
    model: input.model,
    requests: [
      {
        custom_id: input.customId,
        body: input.body,
      },
    ],
  }
  if (input.provider) out.provider = input.provider
  return out
}

export async function create(input: {
  token: string
  payload: CreateInput
  fetch?: FetchLike
}): Promise<BatchInfo> {
  const http = input.fetch ?? fetch
  const res = await http(BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildCreateBody(input.payload)),
  })
  const json = (await res.json().catch(() => ({}))) as BatchInfo & { error?: BatchError }
  if (res.status !== 202) {
    const message = json.error?.message ?? `OpenRouter batch create failed (${res.status})`
    throw new Error(message)
  }
  if (!json.id) throw new Error("OpenRouter batch create missing id")
  return json
}

export async function get(input: { token: string; id: string; fetch?: FetchLike }): Promise<BatchInfo> {
  const http = input.fetch ?? fetch
  const res = await http(`${BASE}/${encodeURIComponent(input.id)}`, {
    headers: { Authorization: `Bearer ${input.token}` },
  })
  const json = (await res.json().catch(() => ({}))) as BatchInfo & { error?: BatchError }
  if (!res.ok) {
    const message = json.error?.message ?? `OpenRouter batch get failed (${res.status})`
    throw new Error(message)
  }
  return json
}

export async function cancel(input: { token: string; id: string; fetch?: FetchLike }) {
  const http = input.fetch ?? fetch
  const res = await http(`${BASE}/${encodeURIComponent(input.id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${input.token}` },
  })
  if (res.status === 404) return
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: BatchError }
    const message = json.error?.message ?? `OpenRouter batch cancel failed (${res.status})`
    throw new Error(message)
  }
}

export async function poll(input: {
  token: string
  id: string
  signal?: AbortSignal
  fetch?: FetchLike
  onStatus?: (info: BatchInfo) => void
}): Promise<BatchInfo> {
  const start = Date.now()
  let wait = pollMs()
  while (true) {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError")
    const info = await get({ token: input.token, id: input.id, fetch: input.fetch })
    input.onStatus?.(info)
    if (TERMINAL.has(info.status)) return info
    if (Date.now() - start > timeoutMs()) throw new Error("OpenRouter batch poll timed out")
    await sleep(wait, input.signal)
    if (wait < 5 * 60_000) wait = Math.min(wait * 1.5, 5 * 60_000)
  }
}
