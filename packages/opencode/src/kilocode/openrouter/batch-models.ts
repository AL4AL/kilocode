// kilocode_change - new file
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"

type Meta = { batch?: boolean; openrouterBatch?: boolean }

export function eligible(apiID: string, source?: Meta) {
  if (source?.batch === true || source?.openrouterBatch === true) return true
  if (apiID.endsWith(":batch")) return true
  return false
}

export function injectBatchPicker(models: Record<string, Provider.Model>, providerID: string) {
  if (providerID !== "openrouter") return
  for (const model of Object.values({ ...models })) {
    const api = model.api.id.replace(/-batch$/, "").replace(/:batch$/, "")
    if (model.openrouterBatch) continue
    if (!eligible(api, model as Meta)) continue
    if (model.api.id.endsWith(":batch")) continue
    const batchID = `${api}-batch`
    if (models[batchID] || models[`${api}:batch`]) continue
    models[batchID] = {
      ...model,
      id: ModelV2.ID.make(batchID),
      name: `${model.name} · Batch`,
      openrouterBatch: true,
    }
  }
}
