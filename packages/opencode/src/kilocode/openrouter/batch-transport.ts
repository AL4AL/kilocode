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
import { batchFailureMessage, create, poll } from "./batch"
import { fromResult } from "./batch-completion"
import { OpenRouterBatchActive } from "./batch-active"
import { OpenRouterBatchStore } from "./batch-store"
import { setWaitingBatch, clearWaitingBatch } from "./batch-status"
import { normalizeBatchMessages } from "./batch-messages"

type KeyProvider = { key?: string; options?: Record<string, unknown> }

export type BatchStreamInput = {
  sessionID: SessionID
  userMessageID: MessageID
  model: Provider.Model
  auth: Auth.Info | undefined
  provider?: KeyProvider
  prepared: Prepared
  abort: AbortSignal
  fetch?: typeof fetch
}

export function resolveOpenRouterKey(input: {
  auth?: Auth.Info
  provider?: KeyProvider
  env?: Record<string, string | undefined>
}) {
  if (input.auth?.type === "api" && input.auth.key) return input.auth.key
  const opt = input.provider?.options?.apiKey
  if (typeof opt === "string" && opt.trim()) return opt.trim()
  if (typeof input.provider?.key === "string" && input.provider.key.trim()) return input.provider.key.trim()
  return input.env?.OPENROUTER_API_KEY
}

function completionBody(input: BatchStreamInput) {
  const max = ProviderTransform.maxOutputTokensForRequest({
    model: input.model,
    options: input.prepared.params.options,
    maxOutputTokens: input.prepared.params.maxOutputTokens,
  })
  const wire = ProviderTransform.message(
    input.prepared.messages as ModelMessage[],
    input.model,
    input.prepared.messageTransformOptions ?? {},
  )
  const body: Record<string, unknown> = {
    messages: normalizeBatchMessages(wire),
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
  const options = { ...(input.prepared.params.options ?? {}) }
  const reasoning = options.reasoning
  delete options.reasoning
  if (reasoning && typeof reasoning === "object") body.reasoning = reasoning
  if (Object.keys(options).length > 0) body.provider_options = options
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

  const saved = OpenRouterBatchStore.byCustom(customId)
  if (
    saved &&
    (saved.sessionID !== input.sessionID ||
      saved.userMessageID !== input.userMessageID ||
      saved.providerID !== input.model.providerID)
  ) {
    throw new Error(`Batch store row for ${customId} does not match this turn; refusing duplicate POST`)
  }

  let batchId = saved?.batchId
  try {
    if (!batchId) {
      const payloadBody = completionBody(input)
      const created = await create({
        token: tokenValue,
        fetch: input.fetch,
        payload: {
          endpoint: "/v1/chat/completions",
          model: apiModel,
          customId,
          body: payloadBody,
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
    }

    OpenRouterBatchActive.set(input.sessionID, {
      batchId: batchId!,
      customId,
      abort: ctrl,
      token: tokenValue,
      fetch: input.fetch,
    })
    setWaitingBatch({
      sessionID: input.sessionID,
      batchId: batchId!,
      customId,
      modelId: apiModel,
    })

    const final = await poll({
      token: tokenValue,
      id: batchId!,
      signal: merged.signal,
      fetch: input.fetch,
    })
    if (final.status !== "completed") {
      const fail = batchFailureMessage(final)
      OpenRouterBatchStore.clear(customId)
      OpenRouterBatchActive.clear(input.sessionID)
      clearWaitingBatch(input.sessionID)
      throw new Error(fail)
    }
    OpenRouterBatchActive.clear(input.sessionID)
    const item = final.results?.find((r) => r.custom_id === customId) ?? final.results?.[0]
    const events = fromResult(item)
    for (const event of events) yield event
    OpenRouterBatchStore.clear(customId)
    clearWaitingBatch(input.sessionID)
  } catch (err) {
    if (!merged.signal.aborted) {
      OpenRouterBatchStore.clear(customId)
      OpenRouterBatchActive.clear(input.sessionID)
      clearWaitingBatch(input.sessionID)
    }
    throw err
  } finally {
    ctrl.abort()
  }
}

export namespace OpenRouterBatchTransport {
  export function stream(input: BatchStreamInput): Stream.Stream<LLMEvent, unknown> {
  const key = resolveOpenRouterKey({ auth: input.auth, provider: input.provider, env: process.env })
  if (!key) return Stream.fail(new Error("OpenRouter API key required for batch models"))
    return Stream.fromAsyncIterable(runPoll(input, key), (e) => (e instanceof Error ? e : new Error(String(e))))
  }
}
