import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { fromResult } from "@/kilocode/openrouter/batch-completion"
import { OpenRouterBatchBackfill } from "@/kilocode/openrouter/batch-backfill"
import { OpenRouterBatchStore } from "@/kilocode/openrouter/batch-store"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import type { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Snapshot } from "@/snapshot"
import { SyncEvent } from "@/sync"
import { Database } from "@opencode-ai/core/database/database"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirProject } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const model = {
  id: ModelV2.ID.make("anthropic/claude-haiku-5.5-batch"),
  providerID: ProviderV2.ID.make("openrouter"),
  api: { id: "anthropic/claude-haiku-5.5-batch", npm: "@openrouter/ai-sdk-provider" },
  openrouterBatch: true,
  limit: { context: 200_000, output: 8192 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
} as Provider.Model

const root = LayerNode.group([
  Session.node,
  SessionProjector.node,
  MessageV2.node,
  Snapshot.node,
  Config.node,
  SessionSummary.node,
  SessionStatus.node,
  EventV2Bridge.node,
  Database.node,
  CrossSpawnSpawner.node,
  RuntimeFlags.node,
])

const env = LayerNode.compile(root, [[RuntimeFlags.node, RuntimeFlags.layer()]]).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, Bus.layer, SyncEvent.defaultLayer)),
)

const it = testEffect(env)

describe("batch backfill", () => {
  it.effect("writes assistant text after serve restart", () =>
    provideTmpdirProject((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "batch" })
        const user = yield* sessions.updateMessage({
          id: MessageID.make("msg_user_batch"),
          role: "user",
          sessionID: chat.id,
          agent: "chat",
          model: { providerID: model.providerID, modelID: model.id },
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: chat.id,
          agent: "chat",
          mode: "chat",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
        })
        OpenRouterBatchStore.upsert({
          batchId: "batch_resume",
          customId: `kilo-${user.id}`,
          sessionID: chat.id,
          userMessageID: user.id,
          model: model.api.id,
          providerID: model.providerID,
          createdAt: new Date().toISOString(),
        })
        const events = fromResult({
          custom_id: `kilo-${user.id}`,
          response: {
            status_code: 200,
            body: {
              choices: [{ finish_reason: "stop", message: { content: "resumed hello" } }],
              usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7, cost: 0.0001 },
            },
          },
        })
        const ok = yield* OpenRouterBatchBackfill.apply({
          sessionID: chat.id,
          userMessageID: user.id,
          model,
          events,
        })
        expect(ok).toBe(true)
        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const row = msgs.find((m) => m.info.id === assistant.id)
        const text = row?.parts.find((p) => p.type === "text")
        expect(text?.type === "text" && text.text).toBe("resumed hello")
        const info = row?.info
        expect(info?.role === "assistant" && info.time.completed).toBeDefined()
        expect(OpenRouterBatchStore.byCustom(`kilo-${user.id}`)).toBeUndefined()
      }),
    ),
  )

  it.effect("backfills tool-call parts from batch events", () =>
    provideTmpdirProject((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "batch tool" })
        const user = yield* sessions.updateMessage({
          id: MessageID.make("msg_user_tool"),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: { providerID: model.providerID, modelID: model.id },
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: chat.id,
          agent: "build",
          mode: "build",
          path: { cwd: dir, root: dir },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: model.id,
          providerID: model.providerID,
          time: { created: Date.now() },
        })
        const events = fromResult({
          custom_id: `kilo-${user.id}`,
          response: {
            status_code: 200,
            body: {
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    tool_calls: [{ id: "tc1", function: { name: "read", arguments: "{}" } }],
                  },
                },
              ],
            },
          },
        })
        const ok = yield* OpenRouterBatchBackfill.apply({
          sessionID: chat.id,
          userMessageID: user.id,
          model,
          events,
        })
        expect(ok).toBe(true)
        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const row = msgs.find((m) => m.info.id === assistant.id)
        expect(row?.parts.some((p) => p.type === "tool" && p.tool === "read")).toBe(true)
      }),
    ),
  )
})
