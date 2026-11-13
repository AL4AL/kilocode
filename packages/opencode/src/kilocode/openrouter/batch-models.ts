// kilocode_change - new file
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"

/** Subset synced from OpenRouter batch quickstart examples; extend as catalog exposes fields. */
const ALLOW = new Set([
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-opus-4.5",
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-pro",
  "meta-llama/llama-3.3-70b-instruct",
])

export function eligible(apiID: string, source?: { batch?: boolean; openrouterBatch?: boolean }) {
  if (source?.batch === true || source?.openrouterBatch === true) return true
  const base = apiID.replace(/-batch$/, "")
  return ALLOW.has(base) || ALLOW.has(apiID)
}

export function injectBatchPicker(models: Record<string, Provider.Model>, providerID: string) {
  if (providerID !== "openrouter") return
  for (const model of Object.values({ ...models })) {
    const api = model.api.id.replace(/-batch$/, "")
    if (!eligible(api, model as { batch?: boolean; openrouterBatch?: boolean })) continue
    if (model.openrouterBatch) continue
    const batchID = `${api}-batch`
    if (models[batchID]) continue
    models[batchID] = {
      ...model,
      id: ModelV2.ID.make(batchID),
      name: `${model.name} · Batch`,
      openrouterBatch: true,
    }
  }
}
