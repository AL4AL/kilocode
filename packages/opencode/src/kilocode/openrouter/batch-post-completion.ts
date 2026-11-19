// kilocode_change - new file
import * as Log from "@opencode-ai/core/util/log"
import { Effect } from "effect"
import type { LLMEvent } from "@opencode-ai/llm"
import { OpenRouterBatchActive } from "./batch-active"
import { OpenRouterBatchBackfill } from "./batch-backfill"
import { OpenRouterBatchToolReplay } from "./batch-tool-replay"
import { OpenRouterBatchContinue } from "./batch-continue"
import type { SessionID } from "@/session/schema"
import type { MessageID } from "@/session/schema"
import type { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { toolCallsFrom } from "./batch-tool-dispatch"

const log = Log.create({ service: "openrouter.batch.post-completion" })

const latch = new Set<string>()

export type SkipReason =
  | "batch_active"
  | "backfill_skipped"
  | "latched"
  | "no_assistant"
  | "nothing_to_do"

export type PostCompletionOutcome = {
  persisted: boolean
  dispatched: boolean
  continued: boolean
  skippedReason?: SkipReason
  assistantMessageID?: MessageID
}

export namespace OpenRouterBatchPostCompletion {
  export const run = Effect.fn("OpenRouterBatchPostCompletion.run")(function* (input: {
    sessionID: SessionID
    userMessageID: MessageID
    model: Provider.Model
    events: LLMEvent[]
    customId: string
    batchId: string
  }) {
    if (OpenRouterBatchActive.get(input.sessionID)) {
      log.info("skip post-completion", {
        phase: "guard",
        outcome: "skipped",
        reason: "batch_active",
        batchId: input.batchId,
        customId: input.customId,
        sessionID: input.sessionID,
        userMessageID: input.userMessageID,
      })
      return { persisted: false, dispatched: false, continued: false, skippedReason: "batch_active" } satisfies PostCompletionOutcome
    }

    if (latch.has(input.customId)) {
      return { persisted: false, dispatched: false, continued: false, skippedReason: "latched" } satisfies PostCompletionOutcome
    }
    latch.add(input.customId)

    try {
      const persisted = yield* OpenRouterBatchBackfill.apply({
        sessionID: input.sessionID,
        userMessageID: input.userMessageID,
        model: input.model,
        events: input.events,
      })

      const sessions = yield* Session.Service
      const rows = yield* sessions.messages({ sessionID: input.sessionID })
      const assistant = [...rows]
        .reverse()
        .find((m) => m.info.role === "assistant" && m.info.parentID === input.userMessageID)
      if (!assistant || assistant.info.role !== "assistant") {
        log.warn("post-completion missing assistant", {
          batchId: input.batchId,
          customId: input.customId,
          sessionID: input.sessionID,
          userMessageID: input.userMessageID,
        })
        return {
          persisted,
          dispatched: false,
          continued: false,
          skippedReason: "no_assistant",
        } satisfies PostCompletionOutcome
      }

      const hasCalls = toolCallsFrom(input.events).length > 0
      const hasPending = assistant.parts.some(
        (p) => p.type === "tool" && (p.state.status === "pending" || p.state.status === "running"),
      )

      let dispatched = false
      if (hasCalls && hasPending) {
        dispatched = yield* OpenRouterBatchToolReplay.run({
          sessionID: input.sessionID,
          assistantMessageID: assistant.info.id,
          events: input.events,
        })
        log.info("post-completion tool replay", {
          batchId: input.batchId,
          customId: input.customId,
          sessionID: input.sessionID,
          assistantMessageID: assistant.info.id,
          dispatched,
        })
      }

      if (!persisted && !dispatched) {
        return {
          persisted,
          dispatched,
          continued: false,
          skippedReason: "nothing_to_do",
          assistantMessageID: assistant.info.id,
        } satisfies PostCompletionOutcome
      }

      const continued = yield* OpenRouterBatchContinue.tryFork({
        sessionID: input.sessionID,
        customId: input.customId,
      })

      return {
        persisted,
        dispatched,
        continued,
        assistantMessageID: assistant.info.id,
      } satisfies PostCompletionOutcome
    } finally {
      latch.delete(input.customId)
    }
  })
}