import { describe, expect, setDefaultTimeout, test } from "bun:test"
import * as Stream from "effect/Stream"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { provideTmpdirServer } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { OpenRouterBatchStore } from "@/kilocode/openrouter/batch-store"
import { OpenRouterBatchActive } from "@/kilocode/openrouter/batch-active"
import {
  batchIntegrationRoot,
  installBatchMock,
  openRouterBatchModel,
  openRouterProviderConfig,
} from "./batch-integration-harness"

setDefaultTimeout(60_000)

import { RuntimeFlags } from "@/effect/runtime-flags"

const it = testEffect(
  LayerNode.compile(batchIntegrationRoot, [[RuntimeFlags.node, RuntimeFlags.layer({ client: "test" })]]),
)

describe("batch cancel integration", () => {
  it.instance(
    "HL-5 cancel mid-poll calls DELETE and clears store row",
    () =>
      provideTmpdirServer(
        ({ dir, llm }) =>
          Effect.gen(function* () {
            const restore = installBatchMock({
              statuses: Array.from({ length: 30 }, () => ({
                status: "in_progress" as const,
                results: null,
                delayMs: 100,
              })),
            })
            try {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const chat = yield* sessions.create({ title: "cancel" })
              const run = yield* prompt
                .prompt({
                  sessionID: chat.id,
                  agent: "chat",
                  model: openRouterBatchModel,
                  parts: [{ type: "text", text: "cancel me" }],
                })
                .pipe(Effect.forkChild({ startImmediately: true }))
              yield* pollWithTimeout(
                Effect.sync(() => (restore.mock.posts.length === 1 ? true : undefined)),
                "batch not posted",
              )
              yield* Effect.promise(() => OpenRouterBatchActive.cancelTurn(chat.id))
              yield* Fiber.interrupt(run).pipe(Effect.ignore)
              expect(restore.mock.deletes.length).toBe(1)
              expect(OpenRouterBatchStore.list().length).toBe(0)
            } finally {
              restore.restore()
            }
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
    45_000,
  )

  test("HL-6 duplicate POST blocked when store row exists for custom_id", async () => {
    const restore = installBatchMock({
      statuses: [{ status: "completed" as const, results: [] }],
    })
    try {
      const { OpenRouterBatchTransport } = await import("@/kilocode/openrouter/batch-transport")
      const { SessionID, MessageID } = await import("@/session/schema")
      const sid = SessionID.make("ses_dup")
      const uid = MessageID.make("msg_dup")
      OpenRouterBatchStore.upsert({
        batchId: "batch_x",
        customId: `kilo-${uid}`,
        sessionID: sid,
        userMessageID: uid,
        model: "anthropic/claude-haiku-5.5-batch",
        providerID: "openrouter",
        createdAt: new Date().toISOString(),
      })
      const stream = OpenRouterBatchTransport.stream({
        sessionID: sid,
        userMessageID: uid,
        model: {
          providerID: "openrouter",
          api: { id: "anthropic/claude-haiku-5.5-batch" },
          openrouterBatch: true,
        } as never,
        auth: { type: "api", key: "sk-test" },
        prepared: {
          system: [],
          messages: [{ role: "user", content: "hi" }],
          tools: {},
          params: { options: {} },
          messageTransformOptions: {},
          headers: {},
        },
        abort: new AbortController().signal,
        fetch: restore.mock.fetch,
      })
      await expect(Effect.runPromise(Stream.runCollect(stream))).rejects.toThrow("duplicate POST")
      expect(restore.mock.posts.length).toBe(0)
      OpenRouterBatchStore.clear(`kilo-${uid}`)
    } finally {
      restore.restore()
    }
  })
})
