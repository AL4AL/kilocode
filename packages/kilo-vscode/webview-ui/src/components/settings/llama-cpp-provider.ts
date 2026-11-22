import { LLAMA_CPP_PROVIDER_ID } from "../../../../src/shared/provider-model"

export const LLAMA_CPP_DEFAULTS = {
  baseURL: "http://127.0.0.1:8080/v1",
  apiKey: "sk-local",
  modelID: "qwen36-local",
  modelName: "Qwen3.6-35B local",
  context: "131072",
  output: "32768",
  timeout: "600000",
  temperature: "0.6",
  topP: "0.95",
  topK: "20",
  reasoning: true,
  toolCall: true,
  thinking: true,
}

export type LlamaCppForm = typeof LLAMA_CPP_DEFAULTS
export type LlamaCppField = keyof LlamaCppForm

export type LlamaCppConfig = {
  npm: "@ai-sdk/openai-compatible"
  name: "llama.cpp"
  options: { baseURL: string; timeout: number }
  models: Record<
    string,
    {
      name: string
      tool_call: boolean
      reasoning: boolean
      temperature: true
      limit: { context: number; output: number }
      options: { temperature: number; topP: number; topK: number; enable_thinking: boolean }
    }
  >
}

export type LlamaCppResult = { config?: LlamaCppConfig; errors: Partial<Record<LlamaCppField, string>> }

function numeric(value: string, min: number, max: number, integer = false) {
  const number = value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) return
  return number
}

function parseURL(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return
  return url
}

function numbers(form: LlamaCppForm, errors: LlamaCppResult["errors"]) {
  const context = numeric(form.context, 1, 2_097_152, true)
  const output = numeric(form.output, 1, 1_048_576, true)
  const timeout = numeric(form.timeout, 1_000, 3_600_000, true)
  const temperature = numeric(form.temperature, 0, 2)
  const topP = numeric(form.topP, 0, 1)
  const topK = numeric(form.topK, 1, 1_000, true)

  if (context === undefined) errors.context = "settings.providers.llamaCpp.error.context"
  if (output === undefined || (context !== undefined && output > context)) {
    errors.output = "settings.providers.llamaCpp.error.output"
  }
  if (timeout === undefined) errors.timeout = "settings.providers.llamaCpp.error.timeout"
  if (temperature === undefined) errors.temperature = "settings.providers.llamaCpp.error.temperature"
  if (topP === undefined) errors.topP = "settings.providers.llamaCpp.error.topP"
  if (topK === undefined) errors.topK = "settings.providers.llamaCpp.error.topK"

  return { context, output, timeout, temperature, topP, topK }
}

export function validateLlamaCppForm(form: LlamaCppForm): LlamaCppResult {
  const errors: LlamaCppResult["errors"] = {}
  const url = parseURL(form.baseURL.trim())
  if (!url) errors.baseURL = "settings.providers.llamaCpp.error.baseURL"
  if (!form.modelID.trim() || /\s/.test(form.modelID)) errors.modelID = "settings.providers.llamaCpp.error.modelID"
  if (!form.modelName.trim()) errors.modelName = "settings.providers.llamaCpp.error.modelName"

  const value = numbers(form, errors)
  if (
    Object.keys(errors).length > 0 ||
    !url ||
    value.context === undefined ||
    value.output === undefined ||
    value.timeout === undefined ||
    value.temperature === undefined ||
    value.topP === undefined ||
    value.topK === undefined
  ) {
    return { errors }
  }

  return {
    errors,
    config: {
      npm: "@ai-sdk/openai-compatible",
      name: "llama.cpp",
      options: { baseURL: url.toString().replace(/\/$/, ""), timeout: value.timeout },
      models: {
        [form.modelID.trim()]: {
          name: form.modelName.trim(),
          tool_call: form.toolCall,
          reasoning: form.reasoning,
          temperature: true,
          limit: { context: value.context, output: value.output },
          options: {
            temperature: value.temperature,
            topP: value.topP,
            topK: value.topK,
            enable_thinking: form.thinking,
          },
        },
      },
    },
  }
}

export { LLAMA_CPP_PROVIDER_ID }
