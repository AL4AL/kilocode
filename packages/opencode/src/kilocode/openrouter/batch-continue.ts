// kilocode_change - new file
import * as Log from "@opencode-ai/core/util/log"
import { Cause, Effect } from "effect"
import { Session } from "@/session/session"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Permission } from "@/permission"
import { Question } from "@/question"
import { Suggestion } from "@/kilocode/suggestion"
import { OpenRouterBatchStore } from "./batch-store"
import type { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"

const log = Log.create({ service: "openrouter.batch.continue" })

export function autoContinueEnabled() {
  return process.env.KILO_OPENROUTER_BATCH_AUTO_CONTINUE === "1"
}

function unfinished(messages: MessageV2.WithParts[]) {
  const last = messages.findLast((m) => m.info.role === "assistant")
  if (!last) return false
  return last.parts.some(
    (p) => p.type === "tool" && p.state.status !== "completed" && p.state.status !== "error",
  )
}

function needsModelStep(messages: MessageV2.WithParts[]) {
  const last = messages.findLast((m) => m.info.role === "assistant")
  if (!last || last.info.role !== "assistant") return false
  if (unfinished(messages)) return false
  return last.info.finish === "tool-calls" || last.info.finish == null
}

const familyPending = Effect.fn("OpenRouterBatchContinue.familyPending")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  const permission = yield* Permission.Service
  const question = yield* Question.Service
  const pending = [
    ...(yield* permission.list()),
    ...(yield* question.list()),
    ...(yield* Effect.promise(() => Suggestion.list())),
  ]
  if (pending.length === 0) return false
  const family = new Set([sessionID])
  for (const parent of family) {
    const children = yield* sessions.children(parent)
    for (const child of children) family.add(child.id)
  }
  return pending.some((request) => family.has(request.sessionID))
})

export namespace OpenRouterBatchContinue {
  export const tryFork = Effect.fn("OpenRouterBatchContinue.tryFork")(function* (input: {
    sessionID: SessionID
    customId: string
  }) {
    if (!autoContinueEnabled()) return false

    if (OpenRouterBatchStore.bySession(input.sessionID).length > 0) {
      log.info("skip auto-continue", { sessionID: input.sessionID, reason: "pending_batch_store" })
      return false
    }

    const sessions = yield* Session.Service
    const session = yield* sessions.get(input.sessionID).pipe(Effect.exit)
    if (session._tag === "Failure") return false
    if (session.value.revert || session.value.time.archived) return false

    const runState = yield* SessionRunState.Service
    const busy = yield* runState.assertNotBusy(input.sessionID).pipe(Effect.exit)
    if (busy._tag === "Failure") return false

    const status = yield* SessionStatus.Service
    const phase = (yield* status.get(input.sessionID)).type
    if (phase !== "idle") return false

    if (yield* familyPending(input.sessionID)) return false

    const messages = yield* sessions.messages({ sessionID: input.sessionID })
    if (!needsModelStep(messages)) return false

    const mod = yield* Effect.promise(() => import("@/session/prompt"))
    const prompts = yield* mod.SessionPrompt.Service

    yield* prompts
      .loop({ sessionID: input.sessionID })
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void
          return Effect.gen(function* () {
            yield* Effect.logError("batch auto-continue failed", { sessionID: input.sessionID, cause })
          })
        }),
        Effect.forkDetach,
      )

    log.info("batch auto-continue forked", { sessionID: input.sessionID, customId: input.customId })
    return true
  })
}