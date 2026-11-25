import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createNativeRuntime } from "../../src/services/native-runtime/runtime"
import type { NativeSecretStorage } from "../../src/services/native-runtime/providers"
import type { NativeJsonObject } from "../../src/services/native-runtime/types"

const dirs: string[] = []
const enc = new TextEncoder()

async function root() {
  const path = await mkdtemp(join(tmpdir(), "kilo-native-sessions-"))
  dirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function stream(body: string) {
  const bytes = enc.encode(body)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function secrets(): NativeSecretStorage {
  const values = new Map<string, string>()
  return {
    get: async (key) => values.get(key),
    store: async (key, value) => void values.set(key, value),
    delete: async (key) => void values.delete(key),
  }
}

function config(endpoint: string) {
  return {
    id: "fixture",
    name: "Fixture",
    auth: "secret" as const,
    connected: false,
    protocol: "openai-compatible" as const,
    endpoint,
    models: [
      {
        id: "model",
        providerID: "fixture",
        name: "Fixture Model",
        contextWindow: 4096,
        maxOutputTokens: 512,
        input: ["text"] as Array<"text">,
        output: ["text"] as Array<"text">,
        capabilities: { streaming: true, tools: true, reasoning: true, structuredOutput: true },
        options: {},
      },
    ],
  }
}

function runtime(root: string, endpoint: string, secret: NativeSecretStorage) {
  const value = createNativeRuntime({ root, secrets: secret, trusted: () => true })
  value.providers.register(config(endpoint))
  return value
}

describe("native session runtime", () => {
  it("creates, streams, persists, and reopens directory-scoped sessions", async () => {
    const body = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: { reasoning_content: "Checking" }, finish_reason: null }] },
      { choices: [{ delta: { content: " there" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join("")
      .concat("data: [DONE]\n\n")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(stream(body), { headers: { "content-type": "text/event-stream" } }),
    })
    const path = await root()
    const dir = resolve(path, "workspace")
    const branch = resolve(path, "worktree")
    const secret = secrets()
    const value = runtime(path, server.url.href, secret)
    const events: string[] = []
    let textID: string | undefined
    value.onEvent((event) => {
      events.push(event.type)
      if (event.type === "message.text.delta") textID = event.partID
    })

    try {
      await value.providers.connect("fixture", "secret")
      const session = await value.sessions.create(dir, { providerID: "fixture", modelID: "model" })
      const assistant = await value.sessions.prompt(dir, session.id, "Say hello")
      const messages = await value.sessions.messages(dir, session.id)
      const other = await value.sessions.create(branch, { providerID: "fixture", modelID: "model" })

      expect(
        assistant.parts
          .filter((part) => part.type === "text")
          .map((part) => part.type === "text" && part.text)
          .join(""),
      ).toBe("Hello there")
      expect(assistant.parts.some((part) => part.type === "reasoning" && part.text === "Checking")).toBe(true)
      expect(assistant.parts.find((part) => part.type === "text")?.id).toBe(textID)
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"])
      expect((await value.sessions.list(dir)).map((item) => item.id)).toEqual([session.id])
      expect((await value.sessions.list(branch)).map((item) => item.id)).toEqual([other.id])
      expect(events).toContain("message.text.delta")
      expect(events).toContain("session.turn.close")

      const next = createNativeRuntime({ root: path, secrets: secret, trusted: () => true })
      expect(await next.sessions.get(dir, session.id)).toMatchObject({ id: session.id, status: "idle" })
      expect((await next.sessions.messages(dir, session.id)).at(-1)?.parts).toEqual(assistant.parts)
      next.dispose()
    } finally {
      value.dispose()
      server.stop(true)
    }
  })

  it("prevents duplicate cross-window turns and aborts an active stream", async () => {
    const response = JSON.stringify({ choices: [{ delta: { content: "partial" }, finish_reason: null }] })
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(enc.encode(`data: ${response}\n\n`))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    })
    const path = await root()
    const dir = resolve(path, "workspace")
    const secret = secrets()
    const first = runtime(path, server.url.href, secret)
    const second = createNativeRuntime({ root: path, secrets: secret, trusted: () => true })
    await first.providers.connect("fixture", "secret")
    const session = await first.sessions.create(dir, { providerID: "fixture", modelID: "model" })
    const delta = Promise.withResolvers<void>()
    first.onEvent((event) => {
      if (event.type === "message.text.delta") delta.resolve()
    })

    try {
      const response = first.sessions.prompt(dir, session.id, "Wait")
      const settled = response.then(
        () => undefined,
        (err: unknown) => err,
      )
      await delta.promise
      await expect(second.sessions.prompt(dir, session.id, "Duplicate")).rejects.toThrow("already running")
      expect(await first.sessions.abort(dir, session.id)).toBe(true)
      expect(await settled).toMatchObject({ message: "Session response aborted" })
      expect((await first.sessions.get(dir, session.id)).status).toBe("idle")
      expect((await first.sessions.messages(dir, session.id)).at(-1)?.parts.at(-1)).toMatchObject({ type: "error" })
    } finally {
      first.dispose()
      second.dispose()
      server.stop(true)
    }
  })

  it("executes an approved model tool and feeds its result into the next turn", async () => {
    const calls: Array<{ tools?: unknown; messages?: unknown }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { tools?: unknown; messages?: unknown }
        calls.push(body)
        const response =
          calls.length === 1
            ? [
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call-write",
                            function: {
                              name: "write_file",
                              arguments: JSON.stringify({ path: "answer.txt", content: "approved\n" }),
                            },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                },
                { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
              ]
            : [
                { choices: [{ delta: { content: "Done" }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: "stop" }] },
              ]
        const text = response
          .map((value) => `data: ${JSON.stringify(value)}\n\n`)
          .join("")
          .concat("data: [DONE]\n\n")
        return new Response(stream(text), { headers: { "content-type": "text/event-stream" } })
      },
    })
    const path = await root()
    const dir = resolve(path, "workspace")
    await mkdir(dir)
    const secret = secrets()
    const value = runtime(path, server.url.href, secret)
    let permissions = 0
    const tools: string[] = []
    value.onEvent((event) => {
      if (event.type === "permission.asked") {
        permissions++
        value.tools.replyPermission(event.request.id, "once")
      }
      if (event.type === "tool.started" || event.type === "tool.updated") tools.push(event.type)
    })

    try {
      await value.providers.connect("fixture", "secret")
      const session = await value.sessions.create(dir, { providerID: "fixture", modelID: "model" })
      const final = await value.sessions.prompt(dir, session.id, "Create the file")
      const history = await value.sessions.messages(dir, session.id)

      expect(await Bun.file(join(dir, "answer.txt")).text()).toBe("approved\n")
      expect(final.parts).toContainEqual(expect.objectContaining({ type: "text", text: "Done" }))
      expect(history.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"])
      expect(permissions).toBe(1)
      expect(tools).toEqual(["tool.started", "tool.updated"])
      expect(calls[0]?.tools).toHaveLength(6)
      expect(calls[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call-write",
          content: expect.stringContaining("Wrote answer.txt"),
        }),
      )
    } finally {
      value.dispose()
      server.stop(true)
    }
  })

  it("clears persisted busy state when its owning extension host is gone", async () => {
    const path = await root()
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") })
    const value = runtime(path, server.url.href, secrets())
    const dir = resolve(path, "workspace")
    await mkdir(dir)

    try {
      const session = await value.sessions.create(dir, { providerID: "fixture", modelID: "model" })
      await value.store.update(
        dir,
        (data) => ({
          ...data,
          session: { ...(data.session as NativeJsonObject), status: "busy" },
          runner: { pid: 2_147_483_647, token: "stale" },
        }),
        `session:${session.id}`,
      )

      expect((await value.sessions.get(dir, session.id)).status).toBe("idle")
      expect((await value.store.load(dir, `session:${session.id}`)).data.runner).toBeUndefined()
    } finally {
      value.dispose()
      server.stop(true)
    }
  })
})
