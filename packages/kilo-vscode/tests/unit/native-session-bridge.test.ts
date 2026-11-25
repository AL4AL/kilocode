import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createNativeSessionBridge } from "../../src/kilo-provider/native-session-bridge"
import { createNativeRuntime } from "../../src/services/native-runtime/runtime"
import type { NativeSecretStorage } from "../../src/services/native-runtime/providers"

const dirs: string[] = []
const enc = new TextEncoder()

async function root() {
  const dir = await mkdtemp(join(tmpdir(), "kilo-native-bridge-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function stream(value: string) {
  const bytes = enc.encode(value)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 17) controller.enqueue(bytes.slice(index, index + 17))
      controller.close()
    },
  })
}

describe("native session webview bridge", () => {
  it("preserves session/message contracts and streams cumulative part deltas by directory", async () => {
    const text = [
      { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { choices: [{ delta: { content: " world" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]
      .map((value) => `data: ${JSON.stringify(value)}\n\n`)
      .join("")
      .concat("data: [DONE]\n\n")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(stream(text), { headers: { "content-type": "text/event-stream" } }),
    })
    const dir = await root()
    const workspace = resolve(dir, "workspace")
    const foreign = resolve(dir, "foreign")
    await mkdir(workspace)
    const secrets: NativeSecretStorage = {
      get: async () => "secret",
      store: async () => undefined,
      delete: async () => undefined,
    }
    const runtime = createNativeRuntime({ root: dir, secrets, trusted: () => true })
    runtime.providers.register({
      id: "fixture",
      name: "Fixture",
      auth: "secret",
      connected: true,
      protocol: "openai-compatible",
      endpoint: server.url.href,
      models: [
        {
          id: "model",
          providerID: "fixture",
          name: "Fixture Model",
          contextWindow: 4096,
          maxOutputTokens: 512,
          input: ["text"],
          output: ["text"],
          capabilities: { streaming: true, tools: false, reasoning: false, structuredOutput: false },
          options: {},
        },
      ],
    })
    const messages: Array<Record<string, unknown>> = []
    const permission = Promise.withResolvers<string>()
    const question = Promise.withResolvers<string>()
    const bridge = createNativeSessionBridge(runtime, workspace, (value) => {
      const item = value as Record<string, unknown>
      messages.push(item)
      if (item.type === "permissionRequest") permission.resolve(String((item.permission as { id: string }).id))
      if (item.type === "questionRequest") question.resolve(String((item.question as { id: string }).id))
    })

    try {
      await runtime.sessions.create(foreign, { providerID: "fixture", modelID: "model" })
      const session = await bridge.create({ providerID: "fixture", modelID: "model" })
      const assistant = await bridge.prompt(session.id, "Say hello")
      const parts = assistant.parts.filter((part) => part.type === "text")

      expect(messages.filter((item) => item.type === "sessionCreated")).toHaveLength(1)
      const roles = messages
        .filter((item) => item.type === "messageCreated")
        .map((item) => item.message as { id: string; role: string })
      expect([...new Map(roles.map((item) => [item.id, item.role])).values()]).toEqual(["user", "assistant"])
      expect(
        messages.filter((item) => item.type === "partUpdated").map((item) => (item.part as { text: string }).text),
      ).toEqual(["Hello", "Hello world"])
      expect(messages.filter((item) => item.type === "sessionStatus").map((item) => item.status)).toEqual([
        "busy",
        "idle",
      ])
      expect(messages.at(-1)?.type).toBe("sessionTurnClosed")
      expect(parts).toContainEqual(expect.objectContaining({ text: "Hello world" }))
      expect((await bridge.messages(session.id)).map((item) => item.role)).toEqual(["user", "assistant"])

      const write = runtime.tools.execute(
        "write_file",
        workspace,
        session.id,
        { path: "approved.txt", content: "approved" },
        new AbortController().signal,
      )
      const id = await permission.promise
      expect(messages.find((item) => item.type === "permissionRequest")?.permission).toMatchObject({ id })
      expect(bridge.replyPermission(id, "once")).toBe(true)
      expect(await write).toBe("Wrote approved.txt")
      expect(await readFile(join(workspace, "approved.txt"), "utf8")).toBe("approved")
      expect(messages.some((item) => item.type === "permissionResolved")).toBe(true)

      const answer = runtime.tools.execute(
        "ask_user",
        workspace,
        session.id,
        { question: "Continue?", options: [{ label: "Yes" }] },
        new AbortController().signal,
      )
      const questionID = await question.promise
      expect(messages.find((item) => item.type === "questionRequest")?.question).toMatchObject({ id: questionID })
      expect(bridge.replyQuestion(questionID, [["Yes"]])).toBe(true)
      expect(await answer).toBe('[["Yes"]]')
      expect(messages.some((item) => item.type === "questionResolved")).toBe(true)
    } finally {
      bridge.dispose()
      runtime.dispose()
      server.stop(true)
    }
  })
})
