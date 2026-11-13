import { describe, expect, setDefaultTimeout } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { reply, TestLLMServer } from "../../lib/llm-server"
import { provideTmpdirServer } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"
import { KiloSessionPromptQueue } from "@/kilocode/session/prompt-queue"
import {
  batchIntegrationRoot,
  installBatchMock,
  textPart,
  openRouterBatchModel,
  openRouterProviderConfig,
} from "./batch-integration-harness"

setDefaultTimeout(60_000)

import { RuntimeFlags } from "@/effect/runtime-flags"

const it = testEffect(
  LayerNode.compile(batchIntegrationRoot, [[RuntimeFlags.node, RuntimeFlags.layer({ client: "test" })]]),
)

describe("batch queue integration", () => {
  it.instance(
    "HL-3 / queue-slot-audit: slot held during batch poll; second prompt waits",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const restore = installBatchMock({
              statuses: [
                ...Array.from({ length: 8 }, () => ({ status: "in_progress" as const, results: null, delayMs: 80 })),
                {
                  status: "completed" as const,
                  results: [
                    {
                      custom_id: "a",
                      response: {
                        status_code: 200,
                        body: { choices: [{ finish_reason: "stop", message: { content: "first batch" } }] },
                      },
                    },
                  ],
                },
                {
                  status: "completed" as const,
                  results: [
                    {
                      custom_id: "b",
                      response: {
                        status_code: 200,
                        body: { choices: [{ finish_reason: "stop", message: { content: "second batch" } }] },
                      },
                    },
                  ],
                },
              ],
            })
            try {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const chat = yield* sessions.create({ title: "queue serial" })
              const first = yield* prompt
                .prompt({
                  sessionID: chat.id,
                  agent: "chat",
                  model: openRouterBatchModel,
                  parts: [{ type: "text", text: "first" }],
                })
                .pipe(Effect.forkChild({ startImmediately: true }))
              yield* pollWithTimeout(
                Effect.sync(() => (restore.mock.posts.length === 1 ? true : undefined)),
                "batch POST missing",
              )
              const secondID = MessageID.ascending()
              const second = yield* prompt
                .prompt({
                  sessionID: chat.id,
                  messageID: secondID,
                  agent: "chat",
                  model: openRouterBatchModel,
                  parts: [{ type: "text", text: "second" }],
                })
                .pipe(Effect.forkChild({ startImmediately: true }))
              yield* pollWithTimeout(
                Effect.sync(() =>
                  KiloSessionPromptQueue.hasFollowup(chat.id) || KiloSessionPromptQueue.snapshot(chat.id).length > 0
                    ? true
                    : undefined,
                ),
                "follow-up never queued",
              )
              expect(restore.mock.posts.length).toBe(1)
              yield* Fiber.join(first)
              yield* Fiber.join(second)
              const rows = yield* sessions.messages({ sessionID: chat.id })
              expect(rows.filter((m) => m.info.role === "assistant").length).toBeGreaterThanOrEqual(2)
              expect(rows.some((m) => textPart(m, "first batch"))).toBe(true)
            } finally {
              restore.restore()
            }
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
    60_000,
  )

  it.instance(
    "HL-4 drop queued message while batch polling",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const restore = installBatchMock({
              statuses: [
                { status: "in_progress" as const, results: null, delayMs: 80 },
                {
                  status: "completed" as const,
                  results: [
                    {
                      custom_id: "a",
                      response: {
                        status_code: 200,
                        body: { choices: [{ finish_reason: "stop", message: { content: "done" } }] },
                      },
                    },
                  ],
                },
              ],
            })
            try {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const chat = yield* sessions.create({ title: "drop queued" })
              const running = yield* prompt
                .prompt({
                  sessionID: chat.id,
                  agent: "chat",
                  model: openRouterBatchModel,
                  parts: [{ type: "text", text: "active" }],
                })
                .pipe(Effect.forkChild({ startImmediately: true }))
              yield* pollWithTimeout(
                Effect.sync(() => (restore.mock.posts.length === 1 ? true : undefined)),
                "batch not started",
              )
              const queued = MessageID.ascending()
              yield* prompt
                .prompt({
                  sessionID: chat.id,
                  messageID: queued,
                  agent: "chat",
                  model: openRouterBatchModel,
                  parts: [{ type: "text", text: "drop me" }],
                })
                .pipe(Effect.forkChild({ startImmediately: true }))
              yield* pollWithTimeout(
                Effect.sync(() => (KiloSessionPromptQueue.snapshot(chat.id).includes(queued) ? true : undefined)),
                "queued id missing",
              )
              const dropped = yield* KiloSessionPromptQueue.drop(chat.id, queued)
              expect(dropped).toBe(true)
              expect(KiloSessionPromptQueue.snapshot(chat.id)).not.toContain(queued)
              yield* Fiber.join(running)
            } finally {
              restore.restore()
            }
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
    45_000,
  )
})
