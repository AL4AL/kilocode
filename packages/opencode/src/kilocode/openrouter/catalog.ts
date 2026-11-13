// kilocode_change - new file
import type { Provider } from "@opencode-ai/core/models-dev"

const ROOT = "https://openrouter.ai/api/v1"
const CHAT = "/api/v1/chat/completions"
const BATCH = "/api/v1/batches"

type Mods = string[] | undefined

export type OpenRouterRow = {
  id: string
  name: string
  description?: string
  context_length?: number
  architecture?: {
    input_modalities?: Mods
    output_modalities?: Mods
    modality?: string
  }
  endpoints?: string[]
  pricing?: {
    prompt?: string
    completion?: string
  }
  top_provider?: {
    max_completion_tokens?: number
  }
  supported_parameters?: string[]
}

export type OpenRouterList = { data?: OpenRouterRow[] }

const BLOCKED_OUTPUT = new Set(["embeddings", "rerank", "decisions", "speech", "transcription"])

export function catalogQuery() {
  const params = new URLSearchParams({
    limit: "1000",
    output_modalities: "text",
  })
  return `${ROOT}/models?${params}`
}

export function keepsChatText(row: OpenRouterRow) {
  if (!row.id) return false
  const id = row.id.toLowerCase()
  if (id.includes("embed") || id.includes("embedding")) return false
  if (id.includes("rerank")) return false
  if (id.includes("decision")) return false

  const paths = row.endpoints ?? []
  if (!paths.includes(CHAT)) return false
  if (paths.some((p) => p.includes("embeddings") || p.includes("/api/alpha/decisions") || p.includes("/rerank")))
    return false

  const out = row.architecture?.output_modalities ?? []
  if (out.some((m) => BLOCKED_OUTPUT.has(m))) return false
  if (out.length > 0 && !out.includes("text")) return false

  const modality = row.architecture?.modality ?? ""
  if (modality && !modality.includes("text")) return false

  return true
}

function keepsTextOutput(row: OpenRouterRow) {
  const out = row.architecture?.output_modalities ?? []
  if (out.some((m) => BLOCKED_OUTPUT.has(m))) return false
  if (out.length > 0 && !out.includes("text")) return false
  const modality = row.architecture?.modality ?? ""
  if (modality && !modality.includes("text")) return false
  return true
}

/** OpenRouter lists batch-only variants as `provider/model:batch` with only `/api/v1/batches`. */
export function keepsBatchTwin(row: OpenRouterRow) {
  if (!row.id?.endsWith(":batch")) return false
  if (!keepsTextOutput(row)) return false
  const id = row.id.toLowerCase()
  if (id.includes("embed") || id.includes("embedding") || id.includes("rerank") || id.includes("decision"))
    return false
  return (row.endpoints ?? []).includes(BATCH)
}

function batchTwinBases(rows: OpenRouterRow[]) {
  const bases = new Set<string>()
  for (const row of rows) {
    if (!keepsBatchTwin(row)) continue
    bases.add(row.id.slice(0, -":batch".length))
  }
  return bases
}

function costPerM(value: string | undefined) {
  const n = value == null ? 0 : Number(value)
  if (!Number.isFinite(n)) return 0
  return n * 1_000_000
}

function modalities(row: OpenRouterRow) {
  const input = row.architecture?.input_modalities ?? ["text"]
  const output = row.architecture?.output_modalities ?? ["text"]
  const ins: Array<"text" | "image" | "pdf" | "audio" | "video"> = []
  for (const m of input) {
    if (m === "text" || m === "image" || m === "audio" || m === "video") ins.push(m)
    if (m === "file" || m === "pdf") ins.push("pdf")
  }
  if (ins.length === 0) ins.push("text")
  const outs: Array<"text" | "image" | "pdf" | "audio" | "video"> = []
  for (const m of output) {
    if (m === "text" || m === "image" || m === "audio" || m === "video" || m === "pdf") outs.push(m)
  }
  if (outs.length === 0) outs.push("text")
  return { input: ins, output: outs }
}

export function batchCapable(row: OpenRouterRow, twins?: Set<string>) {
  if (row.id.endsWith(":batch")) return true
  if (twins?.has(row.id)) return true
  return (row.endpoints ?? []).includes(BATCH)
}

export function toCatalogModel(row: OpenRouterRow, twins?: Set<string>): Provider["models"][string] {
  const mods = modalities(row)
  const params = row.supported_parameters ?? []
  const batch = batchCapable(row, twins)
  const name = batch && row.id.endsWith(":batch") ? row.name : batch ? `${row.name}` : row.name
  return {
    id: row.id,
    name,
    family: row.id.split("/")[0] ?? "",
    release_date: "",
    attachment: mods.input.includes("image") || mods.input.includes("pdf"),
    reasoning: params.includes("reasoning") || params.includes("include_reasoning"),
    temperature: params.includes("temperature"),
    tool_call: true,
    batch,
    openrouterBatch: row.id.endsWith(":batch") ? true : undefined,
    cost: {
      input: costPerM(row.pricing?.prompt),
      output: costPerM(row.pricing?.completion),
    },
    limit: {
      context: row.context_length ?? row.top_provider?.max_completion_tokens ?? 128_000,
      output: row.top_provider?.max_completion_tokens ?? 8192,
    },
    modalities: mods,
  } as Provider["models"][string]
}

export function fromList(json: OpenRouterList): Provider["models"] {
  const rows = json.data ?? []
  const twins = batchTwinBases(rows)
  const models = {} as Record<string, Provider["models"][string]>
  for (const row of rows) {
    if (keepsChatText(row)) models[row.id] = toCatalogModel(row, twins)
  }
  for (const row of rows) {
    if (!keepsBatchTwin(row) || models[row.id]) continue
    models[row.id] = toCatalogModel(row, twins)
  }
  return models
}
