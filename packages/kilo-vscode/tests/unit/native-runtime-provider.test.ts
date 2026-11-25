import { describe, expect, it } from "bun:test"
import { parseSse } from "../../src/services/native-runtime/sse"
import { streamOpenAI, type NativeGenerationEvent } from "../../src/services/native-runtime/openai-compatible"
import { createProviderRegistry, type NativeSecretStorage } from "../../src/services/native-runtime/providers"
import type { NativeEvent } from "../../src/services/native-runtime/contracts"

const enc = new TextEncoder()

function serve(body: (request: Request) => Response | Promise<Response>) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: body })
}

function stream(text: string) {
  const bytes = enc.encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 11) controller.enqueue(bytes.slice(index, index + 11))
      controller.close()
    },
  })
}

async function collect(iter: AsyncGenerator<NativeGenerationEvent>) {
  const result: NativeGenerationEvent[] = []
  for await (const event of iter) result.push(event)
  return result
}

describe("native provider streaming", () => {
  it("parses split UTF-8, CRLF, multiline data, and final unterminated data", async () => {
    const bytes = enc.encode(
      ": heartbeat\r\nid: frame-1\r\nevent: delta\r\ndata: caf\u00e9\r\ndata: second\r\nretry: 50\r\n\r\ndata: final",
    )
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3))
        controller.close()
      },
    })
    const frames = []
    for await (const frame of parseSse(input)) frames.push(frame)

    expect(frames).toEqual([
      { data: "café\nsecond", event: "delta", id: "frame-1", retry: 50 },
      { data: "final", id: "frame-1", retry: 50 },
    ])
  })

  it("rejects oversized SSE lines before buffering an unbounded frame", async () => {
    const text = `data: ${"x".repeat(1_048_576)}\n\n`
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode(text))
        controller.close()
      },
    })
    const task = (async () => {
      for await (const _ of parseSse(input)) undefined
    })()
    await expect(task).rejects.toThrow("1 MiB limit")
  })

  it("normalizes text, reasoning, tool arguments, usage, and completion from a real HTTP stream", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"Think"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read","arguments":"{\\\"path\\\":"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\\"a.ts\\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":2}}}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("")
    const requests: Array<{ path: string; auth: string | null; body: unknown }> = []
    const server = serve(async (request) => {
      requests.push({
        path: new URL(request.url).pathname,
        auth: request.headers.get("authorization"),
        body: await request.json(),
      })
      return new Response(stream(body), { headers: { "content-type": "text/event-stream" } })
    })

    try {
      const events = await collect(
        streamOpenAI({
          endpoint: server.url.href,
          apiKey: "secret",
          model: "test-model",
          messages: [{ role: "user", content: "hello" }],
          includeUsage: true,
          retries: 0,
        }),
      )
      expect(events).toEqual([
        { type: "text.delta", text: "Hi" },
        { type: "reasoning.delta", text: "Think" },
        { type: "tool.delta", index: 0, callID: "call-1", name: "read", arguments: '{"path":' },
        { type: "tool.delta", index: 0, arguments: '"a.ts"}' },
        { type: "usage", usage: { input: 11, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 0 } },
        { type: "done", finishReason: "tool_calls" },
      ])
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ path: "/v1/chat/completions", auth: "Bearer secret" })
      expect(requests[0].body).toMatchObject({
        model: "test-model",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hello" }],
      })
    } finally {
      server.stop(true)
    }
  })

  it("uses OpenAI Responses events and function-call output history", async () => {
    const values = new Map<string, string>()
    const secrets: NativeSecretStorage = {
      get: async (key) => values.get(key),
      store: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key),
    }
    let path = ""
    let auth: string | null = null
    let tenant: string | null = null
    let body: unknown
    const frames = [
      { type: "response.output_text.delta", delta: "Done" },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "item-1", call_id: "call-1", name: "read_file", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "item-1", delta: '{"path":"a.ts"}' },
      {
        type: "response.completed",
        response: {
          usage: {
            input_tokens: 15,
            output_tokens: 8,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
        },
      },
    ]
    const text = frames
      .map((item) => `data: ${JSON.stringify(item)}\n\n`)
      .join("")
      .concat("data: [DONE]\n\n")
    const server = serve(async (request) => {
      path = new URL(request.url).pathname
      auth = request.headers.get("authorization")
      tenant = request.headers.get("x-tenant-id")
      body = await request.json()
      return new Response(stream(text), { headers: { "content-type": "text/event-stream" } })
    })
    const registry = createProviderRegistry(secrets)
    registry.register({
      id: "openai",
      name: "OpenAI",
      auth: "secret",
      connected: false,
      protocol: "openai-responses",
      endpoint: server.url.href,
      headers: { "x-tenant-id": "tenant-1" },
      models: [
        {
          id: "gpt-test",
          providerID: "openai",
          name: "GPT Test",
          contextWindow: 8192,
          maxOutputTokens: 1024,
          input: ["text"],
          output: ["text"],
          capabilities: { streaming: true, tools: true, reasoning: true, structuredOutput: true },
          options: {},
        },
      ],
    })

    try {
      await registry.connect("openai", "openai-secret")
      const events = await collect(
        registry.stream(
          "openai",
          "gpt-test",
          [
            { role: "system", content: "Be precise" },
            { role: "user", content: "Read this file" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call-old", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
              ],
            },
            { role: "tool", content: "file text", tool_call_id: "call-old" },
          ],
          {
            tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
          },
        ),
      )

      expect(events).toEqual([
        { type: "text.delta", text: "Done" },
        { type: "tool.delta", index: 0, callID: "call-1", name: "read_file", arguments: "" },
        { type: "tool.delta", index: 0, arguments: '{"path":"a.ts"}' },
        { type: "usage", usage: { input: 15, output: 8, reasoning: 2, cacheRead: 4, cacheWrite: 0 } },
        { type: "done", finishReason: "completed" },
      ])
      expect(path).toBe("/v1/responses")
      expect(auth).toBe("Bearer openai-secret")
      expect(tenant).toBe("tenant-1")
      expect(body).toMatchObject({
        model: "gpt-test",
        instructions: "Be precise",
        input: [
          { role: "user", content: "Read this file" },
          { type: "function_call", call_id: "call-old", name: "read_file", arguments: '{"path":"a.ts"}' },
          { type: "function_call_output", call_id: "call-old", output: "file text" },
        ],
        tools: [{ type: "function", name: "read_file" }],
      })
    } finally {
      registry.dispose()
      server.stop(true)
    }
  })

  it("retries transient HTTP responses and honors a zero retry-after", async () => {
    let count = 0
    const server = serve(() => {
      count++
      if (count === 1) return new Response("temporarily unavailable", { status: 503, headers: { "retry-after": "0" } })
      return new Response(stream("data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })
    })

    try {
      expect(await collect(streamOpenAI({ endpoint: server.url.href, model: "m", messages: [], retries: 1 }))).toEqual([
        { type: "done" },
      ])
      expect(count).toBe(2)
    } finally {
      server.stop(true)
    }
  })

  it("does not issue a request when the caller has already cancelled", async () => {
    let count = 0
    const server = serve(() => {
      count++
      return new Response(stream("data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })
    })
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))

    try {
      const task = collect(
        streamOpenAI({ endpoint: server.url.href, model: "m", messages: [], signal: controller.signal }),
      )
      await expect(task).rejects.toThrow("cancelled")
      expect(count).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  it("refuses to send credentials to non-local HTTP endpoints", async () => {
    const task = collect(
      streamOpenAI({ endpoint: "http://192.0.2.1", apiKey: "secret", model: "m", messages: [], retries: 0 }),
    )
    await expect(task).rejects.toThrow("require HTTPS")
  })

  it("refuses credentials embedded in provider endpoint query parameters", async () => {
    const task = collect(
      streamOpenAI({
        endpoint: "https://provider.example/v1?api_key=secret",
        apiKey: "secret",
        model: "m",
        messages: [],
      }),
    )
    await expect(task).rejects.toThrow("endpoint query parameters")
  })

  it("rejects Google redirects before forwarding the API key", async () => {
    let hits = 0
    const target = serve(() => {
      hits++
      return new Response("unexpected")
    })
    const server = serve(() => Response.redirect(target.url))
    const values = new Map<string, string>([["kilocode.native-runtime.provider.google", "google-secret"]])
    const registry = createProviderRegistry({
      get: async (key) => values.get(key),
      store: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key),
    })
    registry.register({
      id: "google",
      name: "Google",
      auth: "secret",
      connected: false,
      protocol: "google",
      endpoint: server.url.href,
      models: [
        {
          id: "gemini-test",
          providerID: "google",
          name: "Gemini Test",
          contextWindow: 8192,
          maxOutputTokens: 1024,
          input: ["text"],
          output: ["text"],
          capabilities: { streaming: true, tools: false, reasoning: false, structuredOutput: false },
          options: {},
        },
      ],
    })

    try {
      await expect(collect(registry.stream("google", "gemini-test", [], { retries: 0 }))).rejects.toThrow()
      expect(hits).toBe(0)
    } finally {
      registry.dispose()
      server.stop(true)
      target.stop(true)
    }
  })

  it("keeps provider credentials in secret storage and uses them for generation", async () => {
    const values = new Map<string, string>()
    const secrets: NativeSecretStorage = {
      get: async (key) => values.get(key),
      store: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key),
    }
    let auth: string | null = null
    const server = serve((request) => {
      auth = request.headers.get("authorization")
      return new Response(stream("data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })
    })
    const registry = createProviderRegistry(secrets)
    registry.register({
      id: "test-provider",
      name: "Test Provider",
      auth: "secret",
      connected: false,
      protocol: "openai-compatible",
      endpoint: server.url.href,
      models: [
        {
          id: "test-model",
          providerID: "test-provider",
          name: "Test Model",
          contextWindow: 4096,
          maxOutputTokens: 1024,
          input: ["text"],
          output: ["text"],
          capabilities: { streaming: true, tools: true, reasoning: true, structuredOutput: true },
          options: {},
        },
      ],
    })

    try {
      expect((await registry.list()).at(0)?.connected).toBe(false)
      await registry.connect("test-provider", "secret-value")
      expect((await registry.list()).at(0)?.connected).toBe(true)
      expect(await collect(registry.stream("test-provider", "test-model", [{ role: "user", content: "hi" }]))).toEqual([
        { type: "done" },
      ])
      expect(auth).toBe("Bearer secret-value")
      await registry.disconnect("test-provider")
      expect((await registry.list()).at(0)?.connected).toBe(false)
      expect(values.size).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  it("loads the Kilo Gateway catalog and streams its anonymous free model", async () => {
    const values = new Map<string, string>()
    const secrets: NativeSecretStorage = {
      get: async (key) => values.get(key),
      store: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key),
    }
    let auth: string | null = null
    let editor: string | null = null
    let organization: string | null = null
    let task: string | null = null
    let project: string | null = null
    let body: unknown
    const server = serve(async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/models") {
        auth = request.headers.get("authorization")
        organization = request.headers.get("x-kilocode-organizationid")
        task = request.headers.get("x-kilocode-taskid")
        project = request.headers.get("x-kilocode-projectid")
        return Response.json({
          data: [
            {
              id: "openai/gpt-test",
              name: "GPT Test",
              context_length: 8192,
              max_completion_tokens: 1024,
              supported_parameters: ["tools", "reasoning"],
              architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
              isFree: true,
            },
          ],
        })
      }
      if (request.method === "POST" && url.pathname === "/api/device-auth/codes") {
        return Response.json({ code: "kilo-code", verificationUrl: "https://kilo.ai/verify", expiresIn: 60 })
      }
      if (request.method === "GET" && url.pathname === "/api/device-auth/codes/kilo-code") {
        return Response.json({ status: "approved", token: "kilo-token" })
      }
      auth = request.headers.get("authorization")
      editor = request.headers.get("x-kilocode-editorname")
      organization = request.headers.get("x-kilocode-organizationid")
      task = request.headers.get("x-kilocode-taskid")
      project = request.headers.get("x-kilocode-projectid")
      body = await request.json()
      return new Response(stream("data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })
    })
    const registry = createProviderRegistry(secrets)

    try {
      const providers = await registry.registerKilo({
        endpoint: server.url.href,
        authEndpoint: server.url.href,
        catalogURL: server.url.href,
        organizationID: "org-1",
      })
      const model = providers.find((item) => item.id === "kilo")?.models[0]
      expect(model).toMatchObject({
        id: "openai/gpt-test",
        providerID: "kilo",
        contextWindow: 8192,
        maxOutputTokens: 1024,
        capabilities: { tools: true, reasoning: true },
        options: { isFree: true },
      })
      expect(await collect(registry.stream("kilo", "openai/gpt-test", [{ role: "user", content: "hello" }]))).toEqual([
        { type: "done" },
      ])
      expect(auth).toBe("Bearer anonymous")
      expect(editor).toBe("Kilo VS Code Extension")
      expect(body).toMatchObject({ model: "openai/gpt-test", stream: true })

      const connected = await registry.connectDevice("kilo")
      expect(connected.find((item) => item.id === "kilo")?.connected).toBe(true)
      await collect(
        registry.stream("kilo", "openai/gpt-test", [{ role: "user", content: "hello" }], {
          metadata: { taskId: "task-1", projectId: "project-1" },
        }),
      )
      expect(auth).toBe("Bearer kilo-token")
      expect(organization).toBe("org-1")
      expect(task).toBe("task-1")
      expect(project).toBe("project-1")
    } finally {
      registry.dispose()
      server.stop(true)
    }
  })

  it("streams Anthropic text, thinking, tool inputs, usage, and maps tool-result messages", async () => {
    const values = new Map<string, string>()
    const secrets: NativeSecretStorage = {
      get: async (key) => values.get(key),
      store: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key),
    }
    let auth: string | null = null
    let path = ""
    let tenant: string | null = null
    let body: unknown
    const data = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer" } },
      { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Reason" } },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "call-1", name: "read_file", input: {} },
      },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ]
    const text = data.map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join("")
    const server = serve(async (request) => {
      auth = request.headers.get("x-api-key")
      path = new URL(request.url).pathname
      tenant = request.headers.get("x-tenant-id")
      body = await request.json()
      return new Response(stream(text), { headers: { "content-type": "text/event-stream" } })
    })
    const registry = createProviderRegistry(secrets)
    registry.register({
      id: "anthropic",
      name: "Anthropic",
      auth: "secret",
      connected: false,
      protocol: "anthropic",
      endpoint: server.url.href,
      headers: { "x-tenant-id": "tenant-1" },
      models: [
        {
          id: "claude-test",
          providerID: "anthropic",
          name: "Claude Test",
          contextWindow: 8192,
          maxOutputTokens: 1024,
          input: ["text"],
          output: ["text"],
          capabilities: { streaming: true, tools: true, reasoning: true, structuredOutput: false },
          options: {},
        },
      ],
    })

    try {
      await registry.connect("anthropic", "anthropic-secret")
      const events = await collect(
        registry.stream(
          "anthropic",
          "claude-test",
          [
            { role: "system", content: "System prompt" },
            { role: "user", content: "Question" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call-prev", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
              ],
            },
            { role: "tool", content: "file contents", tool_call_id: "call-prev" },
          ],
          {
            tools: [
              { type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
            ],
          },
        ),
      )

      expect(events).toEqual([
        { type: "usage", usage: { input: 12, output: 0, reasoning: 0, cacheRead: 3, cacheWrite: 2 } },
        { type: "text.delta", text: "Answer" },
        { type: "reasoning.delta", text: "Reason" },
        { type: "tool.delta", index: 2, callID: "call-1", name: "read_file", arguments: "" },
        { type: "tool.delta", index: 2, arguments: '{"path":"a.ts"}' },
        { type: "usage", usage: { input: 12, output: 4, reasoning: 0, cacheRead: 3, cacheWrite: 2 } },
        { type: "done", finishReason: "tool_use" },
      ])
      expect(auth).toBe("anthropic-secret")
      expect(tenant).toBe("tenant-1")
      expect(path).toBe("/v1/messages")
      expect(body).toMatchObject({
        model: "claude-test",
        system: "System prompt",
        tools: [{ name: "read_file", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "Question" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "call-prev", input: { path: "a.ts" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call-prev", content: "file contents" }] },
        ],
      })
    } finally {
      server.stop(true)
    }
  })

  it("streams Gemini text, reasoning, function calls, and maps function results", async () => {
    const values = new Map<string, string>()
    const secrets: NativeSecretStorage = {
      get: async (key) => values.get(key),
      store: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key),
    }
    let auth: string | null = null
    let path = ""
    let query = ""
    let tenant: string | null = null
    let body: unknown
    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                { text: "Answer" },
                { text: "Reason", thought: true },
                { functionCall: { id: "google-call", name: "read_file", args: { path: "a.ts" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          thoughtsTokenCount: 2,
          cachedContentTokenCount: 3,
        },
      },
    ]
    const server = serve(async (request) => {
      const url = new URL(request.url)
      path = url.pathname
      query = url.search
      auth = request.headers.get("x-goog-api-key")
      tenant = request.headers.get("x-tenant-id")
      body = await request.json()
      const text = chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")
      return new Response(stream(text), { headers: { "content-type": "text/event-stream" } })
    })
    const registry = createProviderRegistry(secrets)
    registry.register({
      id: "google",
      name: "Google",
      auth: "secret",
      connected: false,
      protocol: "google",
      endpoint: `${server.url.href}v1beta`,
      headers: { "x-tenant-id": "tenant-1" },
      models: [
        {
          id: "gemini-test",
          providerID: "google",
          name: "Gemini Test",
          contextWindow: 8192,
          maxOutputTokens: 1024,
          input: ["text"],
          output: ["text"],
          capabilities: { streaming: true, tools: true, reasoning: true, structuredOutput: false },
          options: {},
        },
      ],
    })

    try {
      await registry.connect("google", "google-secret")
      const events = await collect(
        registry.stream(
          "google",
          "gemini-test",
          [
            { role: "system", content: "System prompt" },
            { role: "user", content: "Question" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call-prev", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
              ],
            },
            { role: "tool", content: "file contents", tool_call_id: "call-prev" },
          ],
          {
            tools: [
              { type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
            ],
          },
        ),
      )

      expect(events).toEqual([
        { type: "text.delta", text: "Answer" },
        { type: "reasoning.delta", text: "Reason" },
        { type: "tool.delta", index: 2, callID: "google-call", name: "read_file", arguments: '{"path":"a.ts"}' },
        { type: "usage", usage: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 0 } },
        { type: "done", finishReason: "STOP" },
      ])
      expect(auth).toBe("google-secret")
      expect(tenant).toBe("tenant-1")
      expect(path).toBe("/v1beta/models/gemini-test:streamGenerateContent")
      expect(query).toBe("?alt=sse")
      expect(body).toMatchObject({
        systemInstruction: { parts: [{ text: "System prompt" }] },
        tools: [{ functionDeclarations: [{ name: "read_file", parameters: { type: "object" } }] }],
        contents: [
          { role: "user", parts: [{ text: "Question" }] },
          { role: "model", parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } } }] },
          {
            role: "user",
            parts: [{ functionResponse: { name: "read_file", response: { content: "file contents" } } }],
          },
        ],
      })
    } finally {
      server.stop(true)
    }
  })

  it("completes Kilo-style device authorization and keeps the returned token in secret storage", async () => {
    const values = new Map<string, string>()
    const secrets: NativeSecretStorage = {
      get: async (key) => values.get(key),
      store: async (key, value) => void values.set(key, value),
      delete: async (key) => void values.delete(key),
    }
    const events: NativeEvent[] = []
    let auth: string | null = null
    const server = serve(async (request) => {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/api/device-auth/codes") {
        return Response.json({ code: "device-code", verificationUrl: "https://kilo.ai/verify", expiresIn: 60 })
      }
      if (request.method === "GET" && url.pathname === "/api/device-auth/codes/device-code") {
        return Response.json({ status: "approved", token: "device-token", userEmail: "user@example.com" })
      }
      auth = request.headers.get("authorization")
      return new Response(stream("data: [DONE]\n\n"), { headers: { "content-type": "text/event-stream" } })
    })
    const registry = createProviderRegistry(secrets, (event) => events.push(event))
    registry.register({
      id: "device-provider",
      name: "Device Provider",
      auth: "device",
      connected: false,
      protocol: "openai-compatible",
      endpoint: server.url.href,
      authEndpoint: server.url.href,
      models: [
        {
          id: "device-model",
          providerID: "device-provider",
          name: "Device Model",
          contextWindow: 4096,
          maxOutputTokens: 512,
          input: ["text"],
          output: ["text"],
          capabilities: { streaming: true, tools: false, reasoning: false, structuredOutput: false },
          options: {},
        },
      ],
    })

    try {
      expect((await registry.connectDevice("device-provider")).at(0)?.connected).toBe(true)
      expect(events).toContainEqual({
        type: "provider.auth.device",
        providerID: "device-provider",
        code: "device-code",
        verificationURL: "https://kilo.ai/verify",
        expiresIn: 60,
      })
      expect(events).toContainEqual({ type: "provider.auth.status", providerID: "device-provider", status: "approved" })
      expect(
        await collect(registry.stream("device-provider", "device-model", [{ role: "user", content: "hello" }])),
      ).toEqual([{ type: "done" }])
      expect(auth).toBe("Bearer device-token")
    } finally {
      registry.dispose()
      server.stop(true)
    }
  })

  it("does not restore a device token after disconnect wins the storage race", async () => {
    const values = new Map<string, string>()
    const started = Promise.withResolvers<void>()
    const write = Promise.withResolvers<void>()
    const secrets: NativeSecretStorage = {
      get: async (key) => values.get(key),
      store: async (key, value) => {
        started.resolve()
        await write.promise
        values.set(key, value)
      },
      delete: async (key) => void values.delete(key),
    }
    const server = serve((request) => {
      const url = new URL(request.url)
      if (request.method === "POST" && url.pathname === "/api/device-auth/codes") {
        return Response.json({ code: "device-code", verificationUrl: "https://kilo.ai/verify", expiresIn: 60 })
      }
      return Response.json({ status: "approved", token: "device-token" })
    })
    const registry = createProviderRegistry(secrets)
    registry.register({
      id: "device-provider",
      name: "Device Provider",
      auth: "device",
      connected: false,
      protocol: "openai-compatible",
      endpoint: server.url.href,
      authEndpoint: server.url.href,
      models: [
        {
          id: "device-model",
          providerID: "device-provider",
          name: "Device Model",
          contextWindow: 4096,
          maxOutputTokens: 512,
          input: ["text"],
          output: ["text"],
          capabilities: { streaming: true, tools: false, reasoning: false, structuredOutput: false },
          options: {},
        },
      ],
    })

    try {
      const connecting = registry.connectDevice("device-provider")
      const failure = connecting.then(
        () => undefined,
        (err: unknown) => err,
      )
      await started.promise
      const disconnected = registry.disconnect("device-provider")
      write.resolve()
      await disconnected
      expect(await failure).toMatchObject({ message: "Device authorization cancelled" })
      expect(values.size).toBe(0)
      expect((await registry.list()).at(0)?.connected).toBe(false)
    } finally {
      registry.dispose()
      server.stop(true)
    }
  })
})
