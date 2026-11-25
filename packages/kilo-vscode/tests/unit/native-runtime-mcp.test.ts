import { afterEach, describe, expect, it } from "bun:test"
import { createServer, type Server } from "node:http"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createNativeMcpManager,
  validateNativeMcpServer,
  type NativeMcpConfig,
} from "../../src/services/native-runtime/mcp"
import { createNativeRuntime } from "../../src/services/native-runtime/runtime"
import type { NativeSecretStorage } from "../../src/services/native-runtime/providers"

const dirs: string[] = []
const servers: Server[] = []

async function root() {
  const dir = await mkdtemp(join(tmpdir(), "kilo-native-mcp-"))
  dirs.push(dir)
  return dir
}

function secrets(data: Record<string, string> = {}): NativeSecretStorage {
  return {
    get: async (key) => data[key],
    store: async (key, value) => void (data[key] = value),
    delete: async (key) => void delete data[key],
  }
}

async function http(code: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const server = createServer(code)
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("HTTP fixture failed to bind")
  return { server, url: `http://127.0.0.1:${addr.port}/mcp` }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const fixture = `
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") return;
  if (msg.method === "tools/list" && process.env.MCP_WAIT === "1") return;
  const result = msg.method === "initialize"
    ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : msg.method === "tools/list"
      ? { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object" } }] }
      : msg.method === "tools/call"
        ? { content: [{ type: "text", text: process.env.MCP_TOKEN + ":" + msg.params.arguments.value }] }
        : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
});
`

describe("native MCP manager", () => {
  it("validates configs without accepting package runners or embedded credentials", () => {
    expect(
      validateNativeMcpServer({ name: "bad", transport: "stdio", command: "npx", args: ["-y", "plugin"] }),
    ).toContain("Package-manager runners are not supported; MCP packages are never installed or executed")
    expect(
      validateNativeMcpServer({ name: "remote", transport: "http", url: "https://user:pass@example.test/mcp" }),
    ).toContain("MCP credentials must not be embedded in the URL")
    expect(
      validateNativeMcpServer({
        name: "query-secret",
        transport: "http",
        url: "https://example.test/mcp?access_token=hidden",
      }),
    ).toContain("MCP credentials must use SecretStorage references, not URL query parameters")
    expect(validateNativeMcpServer({ name: "ok", transport: "http", url: "https://example.test/mcp" })).toEqual([])
    expect(
      validateNativeMcpServer({
        name: "raw-secret",
        transport: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer do-not-store" },
      }),
    ).toContain("Sensitive header Authorization must use secretHeaders")
  })

  it("discovers and calls tools through a real stdio JSON-RPC process", async () => {
    const dir = await root()
    const config: NativeMcpConfig = {
      name: "fixture",
      transport: "stdio",
      command: process.execPath,
      args: ["-e", fixture],
      secretEnv: { MCP_TOKEN: "fixture-secret" },
    }
    let approved = 0
    const manager = createNativeMcpManager({
      directory: dir,
      servers: [config],
      secrets: secrets({ "fixture-secret": "hidden-value" }),
      authorize: async (scope, server) => {
        approved++
        expect(scope).toBe(dir)
        expect(server.name).toBe("fixture")
        return true
      },
    })

    try {
      expect(await manager.discover()).toEqual([
        { server: "fixture", name: "echo", description: "Echo input", inputSchema: { type: "object" } },
      ])
      expect(await manager.call("fixture", "echo", { value: "hello" })).toEqual({
        content: [{ type: "text", text: "hidden-value:hello" }],
      })
      expect(approved).toBe(1)
      expect(JSON.stringify(manager.list())).not.toContain("hidden-value")
      expect(manager.list()[0]?.status).toBe("connected")
    } finally {
      await manager.dispose()
    }
  })

  it("does not start a local process until the authorization callback approves it", async () => {
    const dir = await root()
    const mark = join(dir, "started")
    const code = `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "started"); process.stdin.resume()`
    const manager = createNativeMcpManager({
      directory: dir,
      servers: [{ name: "denied", transport: "stdio", command: process.execPath, args: ["-e", code] }],
      secrets: secrets(),
      authorize: () => false,
    })

    try {
      await expect(manager.discover()).rejects.toThrow("was not authorized")
      await expect(readFile(mark, "utf8")).rejects.toThrow()
      expect(manager.list()[0]?.status).toBe("error")
    } finally {
      await manager.dispose()
    }
  })

  it("uses Streamable HTTP JSON-RPC, session headers, and secret header references", async () => {
    const seen: Array<{ method: string; session: string | undefined; auth: string | undefined }> = []
    let authorized = 0
    const fixture = await http(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number
        method: string
        params?: { arguments?: { value?: string } }
      }
      seen.push({ method: msg.method, session: req.headers["mcp-session-id"], auth: req.headers.authorization })
      if (msg.method === "notifications/initialized") {
        res.writeHead(202, { "mcp-session-id": "session-1" }).end()
        return
      }
      const result =
        msg.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "http-fixture", version: "1" },
            }
          : msg.method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: msg.params?.arguments?.value ?? "" }] }
      res
        .writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }))
    })
    const manager = createNativeMcpManager({
      directory: await root(),
      servers: [
        { name: "remote", transport: "http", url: fixture.url, secretHeaders: { Authorization: "remote-token" } },
      ],
      secrets: secrets({ "remote-token": "Bearer fixture-token" }),
      authorize: () => {
        authorized++
        return true
      },
    })

    try {
      expect(await manager.discover()).toEqual([{ server: "remote", name: "echo", inputSchema: { type: "object" } }])
      expect(await manager.call("remote", "echo", { value: "http-ok" })).toEqual({
        content: [{ type: "text", text: "http-ok" }],
      })
      expect(seen.map((item) => item.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ])
      expect(seen.slice(1).every((item) => item.session === "session-1")).toBe(true)
      expect(seen.every((item) => item.auth === "Bearer fixture-token")).toBe(true)
      expect(authorized).toBe(1)
    } finally {
      await manager.dispose()
    }
  })

  it("rejects MCP redirects before credentials can reach another origin", async () => {
    let hits = 0
    const target = await http((_req, res) => {
      hits++
      res.end("unexpected")
    })
    const source = await http((_req, res) => {
      res.writeHead(307, { Location: target.url })
      res.end()
    })
    const dir = await root()
    const manager = createNativeMcpManager({
      directory: dir,
      servers: [
        {
          name: "redirect",
          transport: "http",
          url: source.url,
          secretHeaders: { Authorization: "mcp-token" },
        },
      ],
      secrets: secrets({ "mcp-token": "hidden" }),
      authorize: () => true,
    })

    try {
      await expect(manager.discover()).rejects.toThrow()
      expect(hits).toBe(0)
    } finally {
      await manager.dispose()
    }
  })

  it("honors request timeouts and cancellation against a real stdio server", async () => {
    const dir = await root()
    const manager = createNativeMcpManager({
      directory: dir,
      servers: [
        {
          name: "waiter",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", fixture],
          env: { MCP_WAIT: "1" },
        },
      ],
      secrets: secrets(),
      authorize: () => true,
    })

    try {
      await expect(manager.discover({ timeoutMs: 35 })).rejects.toThrow("timed out")
      await manager.configure([
        {
          name: "waiter",
          transport: "stdio",
          command: process.execPath,
          args: ["-e", fixture],
          env: { MCP_WAIT: "1" },
        },
      ])
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(new Error("test cancelled")), 35)
      await expect(manager.discover({ signal: ctl.signal })).rejects.toThrow("test cancelled")
      clearTimeout(timer)
    } finally {
      await manager.dispose()
    }
  })

  it("routes discovered MCP tools through the native session tool boundary", async () => {
    const dir = await root()
    const code = `
      const readline = require("node:readline");
      const input = readline.createInterface({ input: process.stdin });
      input.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") return;
        const result = msg.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          : msg.method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }] }
            : { content: [{ type: "text", text: "echo:" + msg.params.arguments.value }] };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
      });
    `
    const value = createNativeRuntime({ root: dir, secrets: secrets(), trusted: () => true })
    const requests: string[] = []
    value.onEvent((event) => {
      if (event.type !== "permission.asked") return
      requests.push(event.request.tool)
      value.tools.replyPermission(event.request.id, "once")
    })

    try {
      await value.mcp.configure(dir, [
        { name: "local", transport: "stdio", command: process.execPath, args: ["-e", code] },
      ])
      expect(await value.mcp.discover(dir)).toEqual([
        {
          server: "local",
          name: "echo",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      ])
      const definitions = await value.tools.definitions(dir)
      const tool = definitions.find((item) => item.function.description?.startsWith("local: echo"))
      expect(tool).toBeDefined()
      expect(
        await value.tools.execute(tool!.function.name, dir, "session", { value: "ok" }, new AbortController().signal),
      ).toBe('{"content":[{"type":"text","text":"echo:ok"}]}')
      expect(requests).toEqual(["mcp_server", "mcp_tool"])
    } finally {
      await value.mcp.dispose()
      value.dispose()
    }
  })
})
