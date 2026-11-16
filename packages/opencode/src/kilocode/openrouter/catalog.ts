// kilocode_change - new file
import type { Provider } from "@opencode-ai/core/models-dev"

const ROOT = "https://openrouter.ai/api/v1"
export const OPENROUTER_ORIGIN = "https://openrouter.ai"
const PAGE = 500
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
  reasoning?: {
    supported_efforts?: Array<string | null> | null
    mandatory?: boolean
  }
}

export type OpenRouterList = {
  data?: OpenRouterRow[]
  total_count?: number
  links?: { next?: string | null }
}

const BLOCKED_OUTPUT = new Set(["embeddings", "rerank", "decisions", "speech", "transcription"])
const GATEWAY_EFFORTS = ["max", "xhigh", "high", "medium", "low", "minimal", "none"]

type EffortOption = { type: "effort"; values: string[] }

function effortValues(row: OpenRouterRow) {
  const spec = row.reasoning
  if (!spec || spec.supported_efforts === undefined) return []
  const raw = spec.supported_efforts === null ? GATEWAY_EFFORTS : spec.supported_efforts
  const values = raw.filter((item): item is string => typeof item === "string" && item.length > 0)
  if (spec.mandatory) return values.filter((item) => item !== "none")
  return values
}

function effortOptions(values: string[]): EffortOption[] {
  if (values.length === 0) return []
  return [{ type: "effort", values }]
}

export function catalogQuery(offset = 0) {
  const params = new URLSearchParams({
    limit: String(PAGE),
    output_modalities: "text",
    offset: String(offset),
  })
  return `${ROOT}/models?${params}`
}

export function nextCatalogUrl(next: string) {
  if (next.startsWith("http")) return next
  return `${OPENROUTER_ORIGIN}${next.startsWith("/") ? next : `/${next}`}`
}

export function dedupeRows(rows: OpenRouterRow[]) {
  const map = new Map<string, OpenRouterRow>()
  for (const row of rows) {
    if (row.id) map.set(row.id, row)
  }
  return [...map.values()]
}

/** Live catalog wins on id clashes; keeps models.dev / config-only rows not returned by OpenRouter. */
export function overlayOpenRouterModels(
  base: Provider["models"],
  live: Provider["models"],
): Provider["models"] {
  return { ...base, ...live }
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
  const efforts = effortValues(row)
  const batch = batchCapable(row, twins)
  const name = batch && row.id.endsWith(":batch") ? row.name : batch ? `${row.name}` : row.name
  return {
    id: row.id,
    name,
    family: row.id.split("/")[0] ?? "",
    release_date: "",
    attachment: mods.input.includes("image") || mods.input.includes("pdf"),
    reasoning: efforts.length > 0 || params.includes("reasoning") || params.includes("include_reasoning"),
    reasoning_options: effortOptions(efforts),
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
  copyBatchEfforts(models, rows)
  return models
}

function effortList(model: Provider["models"][string]) {
  const options = (model as { reasoning_options?: EffortOption[] }).reasoning_options ?? []
  const effort = options.find((item) => item.type === "effort")
  return effort?.values ?? []
}

function copyBatchEfforts(models: Record<string, Provider["models"][string]>, rows: OpenRouterRow[]) {
  const suffix = ":batch"
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const [id, model] of Object.entries(models)) {
    if (!id.endsWith(suffix) || effortList(model).length > 0) continue
    const row = byId.get(id)
    if (row?.reasoning) continue
    const base = models[id.slice(0, -suffix.length)]
    const values = base ? effortList(base) : []
    if (values.length === 0) continue
    models[id] = {
      ...model,
      reasoning: true,
      reasoning_options: effortOptions(values),
    } as Provider["models"][string]
  }
}
