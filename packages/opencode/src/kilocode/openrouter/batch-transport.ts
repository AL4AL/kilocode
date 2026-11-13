// kilocode_change - new file
import * as Stream from "effect/Stream"
import type { LLMEvent } from "@opencode-ai/llm"
import type { ModelMessage } from "ai"
import { ProviderTransform } from "@/provider/transform"
import type { Auth } from "@/auth"
import type { Provider } from "@/provider/provider"
import type { Prepared } from "@/session/llm/request"
import type { SessionID } from "@/session/schema"
import type { MessageID } from "@/session/schema"
import { create, poll } from "./batch"
import { fromResult } from "./batch-completion"
import { OpenRouterBatchActive } from "./batch-active"
import { OpenRouterBatchStore } from "./batch-store"
import { setWaitingBatch, clearWaitingBatch } from "./batch-status"

export type BatchStreamInput = {
  sessionID: SessionID
  userMessageID: MessageID
  model: Provider.Model
  auth: Auth.Info | undefined
  prepared: Prepared
  abort: AbortSignal
  fetch?: typeof fetch
}

function token(auth: Auth.Info | undefined, env: Record<string, string | undefined>) {
  if (auth?.type === "api" && auth.key) return auth.key
  return env.OPENROUTER_API_KEY
}

function completionBody(input: BatchStreamInput) {
  const max = ProviderTransform.maxOutputTokensForRequest({
    model: input.model,
    options: input.prepared.params.options,
    maxOutputTokens: input.prepared.params.maxOutputTokens,
  })
  const body: Record<string, unknown> = {
    messages: input.prepared.messages as ModelMessage[],
    model: input.model.api.id.replace(/-batch$/, "").replace(/:batch$/, ""),
  }
  if (input.prepared.params.temperature != null) body.temperature = input.prepared.params.temperature
  if (input.prepared.params.topP != null) body.top_p = input.prepared.params.topP
  if (input.prepared.params.topK != null) body.top_k = input.prepared.params.topK
  if (max != null) body.max_tokens = max
  const tools = Object.entries(input.prepared.tools).map(([name, tool]) => ({
    type: "function",
    function: { name, description: tool.description, parameters: tool.inputSchema ?? { type: "object" } },
  }))
  if (tools.length > 0) body.tools = tools
  if (input.prepared.params.options && Object.keys(input.prepared.params.options).length > 0) {
    body.provider_options = input.prepared.params.options
  }
  return body
}

async function* runPoll(input: BatchStreamInput, tokenValue: string) {
  const customId = `kilo-${input.userMessageID}`
  const apiModel = input.model.api.id.replace(/-batch$/, "").replace(/:batch$/, "")
  const ctrl = new AbortController()
  const merged = new AbortController()
  const link = () => {
    if (input.abort.aborted) merged.abort(input.abort.reason)
    if (ctrl.signal.aborted) merged.abort()
  }
  input.abort.addEventListener("abort", link, { once: true })
  ctrl.signal.addEventListener("abort", link, { once: true })

  const existing = OpenRouterBatchStore.byCustom(customId)
  if (existing) {
    throw new Error(`Batch turn already submitted for ${customId}; refusing duplicate POST`)
  }

  let batchId: string | undefined
  try {
    const created = await create({
      token: tokenValue,
      fetch: input.fetch,
      payload: {
        endpoint: "/v1/chat/completions",
        model: apiModel,
        customId,
        body: completionBody(input),
      },
    })
    batchId = created.id
    OpenRouterBatchStore.upsert({
      batchId: created.id,
      customId,
      sessionID: input.sessionID,
      userMessageID: input.userMessageID,
      model: apiModel,
      providerID: input.model.providerID,
      createdAt: new Date().toISOString(),
    })
    OpenRouterBatchActive.set(input.sessionID, {
      batchId: created.id,
      customId,
      abort: ctrl,
      token: tokenValue,
      fetch: input.fetch,
    })
    setWaitingBatch({
      sessionID: input.sessionID,
      batchId: created.id,
      customId,
      modelId: apiModel,
    })

    const final = await poll({
      token: tokenValue,
      id: created.id,
      signal: merged.signal,
      fetch: input.fetch,
    })
    OpenRouterBatchStore.clear(customId)
    OpenRouterBatchActive.clear(input.sessionID)
    clearWaitingBatch(input.sessionID)
    const item = final.results?.find((r) => r.custom_id === customId) ?? final.results?.[0]
    const events = fromResult(item)
    for (const event of events) yield event
  } catch (err) {
    if (batchId && !merged.signal.aborted) OpenRouterBatchStore.clear(customId)
    OpenRouterBatchActive.clear(input.sessionID)
    clearWaitingBatch(input.sessionID)
    throw err
  } finally {
    ctrl.abort()
  }
}

export namespace OpenRouterBatchTransport {
  export function stream(input: BatchStreamInput): Stream.Stream<LLMEvent, unknown> {
  const env = process.env
  const key = token(input.auth, env)
  if (!key) return Stream.fail(new Error("OpenRouter API key required for batch models"))
    return Stream.fromAsyncIterable(runPoll(input, key), (e) => (e instanceof Error ? e : new Error(String(e))))
  }
}
