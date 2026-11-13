import { describe, expect, setDefaultTimeout } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { provideTmpdirServer } from "../../fixture/fixture"
import { pollWithTimeout, testEffect } from "../../lib/effect"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { RuntimeFlags } from "@/effect/runtime-flags"
import {
  batchIntegrationRoot,
  installBatchMock,
  openRouterBatchModel,
  openRouterProviderConfig,
  textPart,
} from "./batch-integration-harness"
import type { Timeline } from "../../lib/openrouter-batch-server"

setDefaultTimeout(90_000)

function invalidThenText(): Timeline {
  const args = JSON.stringify({ tool: "nope", error: "hl7" })
  return {
    stagesPerBatch: 2,
    statuses: [
      { status: "in_progress", results: null, delayMs: 5 },
      {
        status: "completed",
        results: [
          {
            custom_id: "x",
            response: {
              status_code: 200,
              body: {
                choices: [
                  {
                    finish_reason: "tool_calls",
                    message: {
                      tool_calls: [{ id: "call_invalid", function: { name: "invalid", arguments: args } }],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      { status: "in_progress", results: null, delayMs: 5 },
      {
        status: "completed",
        results: [
          {
            custom_id: "x",
            response: {
              status_code: 200,
              body: {
                choices: [{ finish_reason: "stop", message: { content: "after tool" } }],
              },
            },
          },
        ],
      },
    ],
  }
}

const it = testEffect(
  LayerNode.compile(batchIntegrationRoot, [[RuntimeFlags.node, RuntimeFlags.layer({ client: "test" })]]),
)

describe("batch tool loop integration", () => {
  it.instance(
    "HL-7 batch completion with tool_calls registers a tool part on the assistant turn",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const restore = installBatchMock({
              statuses: [
                {
                  status: "completed",
                  results: [
                    {
                      custom_id: "x",
                      response: {
                        status_code: 200,
                        body: {
                          choices: [
                            {
                              finish_reason: "tool_calls",
                              message: {
                                tool_calls: [
                                  {
                                    id: "call_read",
                                    function: {
                                      name: "read",
                                      arguments: JSON.stringify({ filePath: "/etc/hosts" }),
                                    },
                                  },
                                ],
                              },
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
              const chat = yield* sessions.create({ title: "tool loop" })
              const run = yield* prompt
                .prompt({
                  sessionID: chat.id,
                  agent: "build",
                  model: openRouterBatchModel,
                  parts: [{ type: "text", text: "read hosts" }],
                })
                .pipe(Effect.forkChild({ startImmediately: true }))
              yield* pollWithTimeout(
                Effect.gen(function* () {
                  const rows = yield* sessions.messages({ sessionID: chat.id })
                  return rows.some((m) => m.parts.some((p) => p.type === "tool" && p.tool === "read"))
                    ? true
                    : undefined
                }),
                "tool part missing after batch tool_calls",
              )
              expect(restore.mock.posts.length).toBe(1)
              yield* Fiber.interrupt(run).pipe(Effect.ignore)
            } finally {
              restore.restore()
            }
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
    45_000,
  )

  it.instance(
    "HL-7 invalid tool completes and triggers a second batch POST",
    () =>
      provideTmpdirServer(
        () =>
          Effect.gen(function* () {
            const restore = installBatchMock(invalidThenText())
            try {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const chat = yield* sessions.create({ title: "tool loop e2e" })
              yield* prompt.prompt({
                sessionID: chat.id,
                agent: "build",
                model: openRouterBatchModel,
                parts: [{ type: "text", text: "run invalid tool then reply" }],
              })
              expect(restore.mock.posts.length).toBe(2)
              const rows = yield* sessions.messages({ sessionID: chat.id })
              expect(rows.some((m) => m.parts.some((p) => p.type === "tool" && p.tool === "invalid"))).toBe(true)
              expect(rows.some((m) => textPart(m, "after tool"))).toBe(true)
            } finally {
              restore.restore()
            }
          }),
        { git: true, config: (url) => openRouterProviderConfig(url) },
      ),
    75_000,
  )
})
