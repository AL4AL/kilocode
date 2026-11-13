import { describe, expect, test } from "bun:test"
import * as Stream from "effect/Stream"
import { Effect } from "effect"
import { OpenRouterBatchTransport, resolveOpenRouterKey } from "@/kilocode/openrouter/batch-transport"
import { createBatchFetch } from "../../lib/openrouter-batch-server"
import type { Provider } from "@/provider/provider"

const model = {
  providerID: "openrouter",
  api: { id: "anthropic/claude-haiku-5.5-batch" },
  openrouterBatch: true,
} as Provider.Model

describe("batch transport stream", () => {
  test("completes with assistant text", async () => {
    process.env.KILO_OPENROUTER_BATCH_POLL_MS = "1"
    const mock = createBatchFetch({
      statuses: [
        { status: "in_progress", results: null },
        {
          status: "completed",
          results: [
            {
              custom_id: "kilo-user-1",
              response: {
                status_code: 200,
                body: { choices: [{ finish_reason: "stop", message: { content: "batch ok" } }] },
              },
            },
          ],
        },
      ],
    })

    const stream = OpenRouterBatchTransport.stream({
      sessionID: "ses_test" as never,
      userMessageID: "user-1" as never,
      model,
      auth: { type: "api", key: "sk-test" },
      prepared: {
        system: [],
        messages: [{ role: "user", content: "hi" }],
        tools: {},
        params: { maxOutputTokens: 1024, options: {} },
        messageTransformOptions: {},
        headers: {},
      },
      abort: new AbortController().signal,
      fetch: mock.fetch,
    })

    const events = await Effect.runPromise(Stream.runCollect(stream))
    const text = [...events].filter((e) => e.type === "text-delta").map((e) => e.text).join("")
    expect(text).toBe("batch ok")
    expect(mock.posts.length).toBe(1)
    const body = (mock.posts[0] as { requests?: Array<{ body?: { max_tokens?: number } }> }).requests?.[0]?.body
    expect(body?.max_tokens).toBe(1024)
  })

  test("HL-7 follow-up step issues a second batch POST", async () => {
    process.env.KILO_OPENROUTER_BATCH_POLL_MS = "1"
    process.env.OPENROUTER_API_KEY = "sk-test"
    const mock = createBatchFetch({
      statuses: [
        {
          status: "completed",
          results: [
            {
              custom_id: "kilo-user-1",
              response: {
                status_code: 200,
                body: { choices: [{ finish_reason: "stop", message: { content: "one" } }] },
              },
            },
          ],
        },
        {
          status: "completed",
          results: [
            {
              custom_id: "kilo-user-2",
              response: {
                status_code: 200,
                body: { choices: [{ finish_reason: "stop", message: { content: "two" } }] },
              },
            },
          ],
        },
      ],
    })
  const input = {
      sessionID: "ses_test" as never,
      model,
      auth: { type: "api" as const, key: "sk-test" },
      prepared: {
        system: [] as string[],
        messages: [{ role: "user" as const, content: "hi" }],
        tools: {},
        params: { maxOutputTokens: 1024, options: {} },
        messageTransformOptions: {},
        headers: {},
      },
      abort: new AbortController().signal,
      fetch: mock.fetch,
    }
    for (const id of ["user-1", "user-2"]) {
      const stream = OpenRouterBatchTransport.stream({ ...input, userMessageID: id as never })
      await Effect.runPromise(Stream.runCollect(stream))
    }
    expect(mock.posts.length).toBe(2)
  })

  test("resumes poll when store row exists for same turn", async () => {
    const { OpenRouterBatchStore } = await import("@/kilocode/openrouter/batch-store")
    OpenRouterBatchStore.upsert({
      batchId: "batch_mock_1",
      customId: "kilo-user-1",
      sessionID: "ses_test" as never,
      userMessageID: "user-1" as never,
      model: "m",
      providerID: "openrouter",
      createdAt: new Date().toISOString(),
    })
    process.env.KILO_OPENROUTER_BATCH_POLL_MS = "1"
    const mock = createBatchFetch({
      statuses: [
        {
          status: "completed",
          results: [
            {
              custom_id: "kilo-user-1",
              response: {
                status_code: 200,
                body: { choices: [{ finish_reason: "stop", message: { content: "resumed" } }] },
              },
            },
          ],
        },
      ],
    })
    const stream = OpenRouterBatchTransport.stream({
      sessionID: "ses_test" as never,
      userMessageID: "user-1" as never,
      model,
      auth: { type: "api", key: "sk-test" },
      prepared: {
        system: [],
        messages: [{ role: "user", content: "hi" }],
        tools: {},
        params: { maxOutputTokens: 1024, options: {} },
        messageTransformOptions: {},
        headers: {},
      },
      abort: new AbortController().signal,
      fetch: mock.fetch,
    })
    const events = await Effect.runPromise(Stream.runCollect(stream))
    expect(mock.posts.length).toBe(0)
    expect(events.some((e) => e.type === "text-delta" && e.text === "resumed")).toBe(true)
    OpenRouterBatchStore.clear("kilo-user-1")
  })
})

describe("resolveOpenRouterKey", () => {
  test("reads provider options when auth is missing", () => {
    expect(
      resolveOpenRouterKey({
        provider: { options: { apiKey: " sk-or-1 " } },
        env: {},
      }),
    ).toBe("sk-or-1")
  })
})
