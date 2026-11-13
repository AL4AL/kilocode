import { describe, expect, setDefaultTimeout } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { reply, TestLLMServer } from "../../lib/llm-server"
import { provideTmpdirServer } from "../../fixture/fixture"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import {
  batchIntegrationRoot,
  batchPostBody,
  installBatchMock,
  textPart,
  openRouterBatchModel,
  openRouterProviderConfig,
  testSyncModel,
} from "./batch-integration-harness"

setDefaultTimeout(60_000)

const it = testEffect(
  LayerNode.compile(batchIntegrationRoot, [[RuntimeFlags.node, RuntimeFlags.layer({ client: "test" })]]),
)

const completed = {
  statuses: [
    { status: "in_progress" as const, results: null },
    {
      status: "completed" as const,
      results: [
        {
          custom_id: "placeholder",
          response: {
            status_code: 200,
            body: {
              choices: [{ finish_reason: "stop", message: { content: "batch assistant" } }],
            },
          },
        },
      ],
    },
  ],
}

describe("batch session integration", () => {
  it.instance(
    "resolves openrouter batch model from config",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
            const { ModelV2 } = yield* Effect.promise(() => import("@opencode-ai/core/model"))
            const { ProviderV2 } = yield* Effect.promise(() => import("@opencode-ai/core/provider"))
            const provider = yield* Provider.Service
            const m = yield* provider.getModel(
              ProviderV2.ID.make("openrouter"),
              ModelV2.ID.make("anthropic/claude-haiku-5.5-batch"),
            )
            expect(m.openrouterBatch).toBe(true)
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
  )

  it.instance(
    "HL-1 chat agent + batch model yields assistant text without system in batch body",
    () =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            const restore = installBatchMock(completed)
            try {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const chat = yield* sessions.create({ title: "batch chat" })
              const out = yield* prompt.prompt({
                sessionID: chat.id,
                agent: "chat",
                model: openRouterBatchModel,
                parts: [{ type: "text", text: "hello batch" }],
              })
              expect(out.info.role).toBe("assistant")
              expect(restore.mock.posts.length).toBe(1)
              expect(textPart(out, "batch assistant")).toBe(true)
              const body = batchPostBody(restore.mock)
              const msgs = body?.messages as Array<{ role: string }> | undefined
              expect(msgs?.some((m) => m.role === "system")).toBe(false)
            } finally {
              restore.restore()
            }
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
    45_000,
  )

  it.instance(
    "HL-12 length finish with no user-visible text adds output limit warning",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const { KiloSessionProcessor } = yield* Effect.promise(() => import("@/kilocode/session/processor"))
            const restore = installBatchMock({
              statuses: [
                {
                  status: "completed" as const,
                  results: [
                    {
                      custom_id: "x",
                      response: {
                        status_code: 200,
                        body: {
                          choices: [
                            {
                              finish_reason: "length",
                              message: { content: "" },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              ],
            })
            try {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const chat = yield* sessions.create({ title: "length batch" })
              yield* prompt.prompt({
                sessionID: chat.id,
                agent: "chat",
                model: openRouterBatchModel,
                parts: [{ type: "text", text: "empty length" }],
              })
              const rows = yield* sessions.messages({ sessionID: chat.id })
              const assistant = rows.find((m) => m.info.role === "assistant")
              expect(
                assistant?.parts.some(
                  (p) => p.type === "text" && p.text === KiloSessionProcessor.OUTPUT_LENGTH_WARNING,
                ),
              ).toBe(true)
            } finally {
              restore.restore()
            }
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
    45_000,
  )

  it.instance(
    "HL-2 switches from chat to code on next user message",
    () =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            const restore = installBatchMock({
              statuses: [
                { status: "completed" as const, results: [{ custom_id: "x", response: { status_code: 200, body: { choices: [{ finish_reason: "stop", message: { content: "chat ok" } }] } } }] },
              ],
            })
            try {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const chat = yield* sessions.create({ title: "agent switch" })
              yield* prompt.prompt({
                sessionID: chat.id,
                agent: "chat",
                model: openRouterBatchModel,
                parts: [{ type: "text", text: "chat turn" }],
              })
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const rows = yield* sessions.messages({ sessionID: chat.id })
                  if (rows.some((m) => textPart(m, "chat ok"))) return true as const
                }),
                "chat turn not done",
              )
              yield* llm.text("code reply")
              yield* prompt.prompt({
                sessionID: chat.id,
                agent: "code",
                model: testSyncModel,
                parts: [{ type: "text", text: "code turn" }],
              })
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const rows = yield* sessions.messages({ sessionID: chat.id })
                  if (rows.some((m) => textPart(m, "code reply"))) return true as const
                }),
                "code turn not done",
              )
            } finally {
              restore.restore()
            }
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
    60_000,
  )

  it.instance(
    "HL-8 non-batch model never hits OpenRouter batch API",
    () =>
      provideTmpdirServer(
        ({ llm }) =>
          Effect.gen(function* () {
            const restore = installBatchMock(completed)
            try {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const chat = yield* sessions.create({ title: "sync only" })
              yield* llm.text("sync path")
              yield* prompt.prompt({
                sessionID: chat.id,
                agent: "code",
                model: testSyncModel,
                parts: [{ type: "text", text: "sync" }],
              })
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const rows = yield* sessions.messages({ sessionID: chat.id })
                  if (rows.some((m) => textPart(m, "sync path"))) return true as const
                }),
                "sync assistant missing",
              )
              expect(restore.mock.posts.length).toBe(0)
            } finally {
              restore.restore()
            }
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
  )
})
