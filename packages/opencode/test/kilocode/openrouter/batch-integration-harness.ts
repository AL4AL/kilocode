// kilocode_change - new file
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LLM } from "@/session/llm"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionStatus } from "@/session/status"
import { SessionRunState } from "@/session/run-state"
import { SessionSummary } from "@/session/summary"
import { SessionCompaction } from "@/session/compaction"
import { SessionProcessor } from "@/session/processor"
import { MessageV2 } from "@/session/message-v2"
import { Snapshot } from "@/snapshot"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import * as MCP from "@/mcp"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { TestLLMServer } from "../../lib/llm-server"
import { createBatchFetch, type Timeline } from "../../lib/openrouter-batch-server"

export const openRouterBatchModel = {
  providerID: ProviderV2.ID.make("openrouter"),
  modelID: ModelV2.ID.make("anthropic/claude-haiku-5.5-batch"),
}

export const testSyncModel = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const model = {
  name: "Haiku",
  tool_call: true,
  attachment: false,
  reasoning: false,
  temperature: true,
  limit: { context: 200_000, output: 8192 },
  cost: { input: 0, output: 0 },
}

export const batchIntegrationRoot = LayerNode.group([
  SessionPrompt.node,
  Session.node,
  SessionProjector.node,
  SessionProcessor.node,
  SessionCompaction.node,
  SessionSummary.node,
  SessionStatus.node,
  SessionRunState.node,
  MessageV2.node,
  Snapshot.node,
  LLM.node,
  Provider.node,
  Config.node,
  Plugin.node,
  Agent.node,
  MCP.node,
  BackgroundJob.node,
  Command.node,
  EventV2Bridge.node,
  Permission.node,
  Question.node,
  FSUtil.node,
  Database.node,
  CrossSpawnSpawner.node,
  ToolRegistry.node,
  Truncate.node,
  RuntimeFlags.node,
  LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] }),
])

export function openRouterProviderConfig(llmUrl: string, input?: { batchOnly?: boolean }) {
  const sync = {
    name: "Test",
    npm: "@ai-sdk/openai-compatible",
    options: { apiKey: "test-key", baseURL: llmUrl },
    models: {
      "test-model": {
        id: "test-model",
        name: "Sync",
        tool_call: true,
        limit: { context: 128_000, output: 8192 },
        cost: { input: 0, output: 0 },
      },
    },
  }
  const openrouter = {
    name: "OpenRouter",
    npm: "@openrouter/ai-sdk-provider",
    options: { apiKey: "sk-test" },
    models: {
      "anthropic/claude-haiku-5.5": { id: "anthropic/claude-haiku-5.5", ...model },
      "anthropic/claude-haiku-5.5-batch": {
        id: "anthropic/claude-haiku-5.5-batch",
        ...model,
        name: "Haiku · Batch",
        batch: true,
        openrouterBatch: true,
      },
    },
  }
  const provider = input?.batchOnly ? { openrouter } : { openrouter, test: sync }
  return {
    model: "openrouter/anthropic/claude-haiku-5.5-batch",
    enabled_providers: input?.batchOnly ? ["openrouter"] : ["openrouter", "test"],
    formatter: false,
    lsp: false,
    permission: { "*": "allow" as const },
    sandbox: { enabled: false },
    provider,
  } as Record<string, unknown>
}

export const writeOpencodeConfig = Effect.fn("batchTest.writeConfig")(function* (
  dir: string,
  llmUrl: string,
  extra?: Record<string, unknown>,
) {
  const fs = yield* FSUtil.Service
  const body = { $schema: "https://app.kilo.ai/config.json", ...openRouterProviderConfig(llmUrl), ...extra }
  yield* fs.writeWithDirs(path.join(dir, "opencode.json"), JSON.stringify(body))
})

export function installBatchMock(timeline: Timeline) {
  const mock = createBatchFetch(timeline)
  const prev = globalThis.fetch
  globalThis.fetch = ((req, init) => {
    const url = typeof req === "string" ? req : req.toString()
    if (url.includes("openrouter.ai/api/v1/batches")) return mock.fetch(req, init)
    return prev(req, init)
  }) as typeof fetch
  process.env.OPENROUTER_API_KEY = "sk-test"
  process.env.KILO_OPENROUTER_BATCH_POLL_MS = "1"
  return {
    mock,
    restore: () => {
      globalThis.fetch = prev
    },
  }
}

export function textPart(msg: MessageV2.WithParts, text: string) {
  return msg.parts.some((p) => p.type === "text" && p.text.includes(text))
}

export function batchPostBody(mock: ReturnType<typeof createBatchFetch>) {
  const body = mock.posts[0] as { requests?: Array<{ body?: { messages?: unknown[] } }> }
  return body?.requests?.[0]?.body
}
