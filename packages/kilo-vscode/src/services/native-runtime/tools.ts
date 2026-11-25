import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { NativePermission, NativeQuestion } from "./contracts"
import type { NativeChatTool } from "./openai-compatible"
import type { createNativeStore } from "./store"
import type { NativeJsonObject } from "./types"
import type { NativeEvent } from "./contracts"
import type { NativeMcpConfig, NativeMcpRequestOptions, NativeMcpTool } from "./mcp"
import { execTree } from "../../util/process"

const MAX_FILE = 1_048_576
const PERMISSION_TIMEOUT = 300_000

type Store = ReturnType<typeof createNativeStore>
type Emit = (event: NativeEvent) => void
type Reply = "once" | "always" | "reject"
type Pending = { resolve: (reply: Reply) => void; abort: () => void; timer: ReturnType<typeof setTimeout> }
type Target = { root: string; path: string; exists: boolean }
type PendingQuestion = {
  request: NativeQuestion
  resolve: (answers: string[][]) => void
  abort: () => void
  timer: ReturnType<typeof setTimeout>
}
type Mcp = {
  tools(dir: string): Promise<NativeMcpTool[]>
  call(
    dir: string,
    server: string,
    tool: string,
    args: NativeJsonObject,
    opts?: NativeMcpRequestOptions,
  ): Promise<NativeJsonObject>
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function within(root: string, path: string) {
  const value = relative(root, path)
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function code(err: unknown) {
  return err && typeof err === "object" && "code" in err ? err.code : undefined
}

async function target(dir: string, name: string, write: boolean): Promise<Target> {
  if (!name.trim()) throw new TypeError("Tool path must not be empty")
  const root = await realpath(dir)
  const path = resolve(root, name)
  if (!within(root, path)) throw new Error("Tool path must stay inside the workspace")
  const parent = await realpath(dirname(path))
  if (!within(root, parent)) throw new Error("Tool path resolves outside the workspace")
  try {
    const real = await realpath(path)
    if (!within(root, real)) throw new Error("Tool path resolves outside the workspace")
    if (!(await stat(real)).isFile()) throw new Error("Tool path must reference a file")
    return { root, path: real, exists: true }
  } catch (err) {
    if (code(err) !== "ENOENT" || !write) throw err
    return { root, path, exists: false }
  }
}

async function folder(dir: string, name: string): Promise<Target> {
  if (!name.trim()) throw new TypeError("Tool path must not be empty")
  const root = await realpath(dir)
  const path = resolve(root, name)
  if (!within(root, path)) throw new Error("Tool path must stay inside the workspace")
  const parent = await realpath(dirname(path))
  if (!within(root, parent)) throw new Error("Tool path resolves outside the workspace")
  try {
    const real = await realpath(path)
    if (!within(root, real)) throw new Error("Tool path resolves outside the workspace")
    if (!(await stat(real)).isDirectory()) throw new Error("Tool path must reference a directory")
    return { root, path: real, exists: true }
  } catch (err) {
    if (code(err) !== "ENOENT") throw err
    return { root, path, exists: false }
  }
}

function fdpath(fd: number) {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`
  if (process.platform === "darwin") return `/dev/fd/${fd}`
}

async function openDir(root: string, path: string) {
  if (process.platform === "win32") return
  const file = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  const base = fdpath(file.fd)
  try {
    const actual = await realpath(base ?? path)
    if (!within(root, actual)) throw new Error("Tool directory resolves outside the workspace")
    return { file, path: base ?? actual }
  } catch (err) {
    await file.close()
    throw err
  }
}

function input(value: NativeJsonObject, key: string) {
  const name = value[key]
  if (typeof name !== "string") throw new TypeError(`Tool input requires a string ${key}`)
  return name
}

const scopedPermissions = new Set(["run_command", "mcp_server", "mcp_tool"])

function permissionKey(tool: string, name: string, detail: NativeJsonObject) {
  const tag = scopedPermissions.has(tool) ? `:${createHash("sha256").update(JSON.stringify(detail)).digest("hex")}` : ""
  return `${tool}:${name}${tag}`
}

function reason(tool: string, name: string, detail: NativeJsonObject) {
  if (tool === "run_command") return `Run a user-approved command in ${name}`
  if (tool === "mcp_server") return `Connect to MCP server ${String(detail.server ?? "")}`
  if (tool === "mcp_tool") return `Call MCP tool ${String(detail.server ?? "")}.${String(detail.tool ?? "")}`
  return `${tool} will modify ${name}`
}

export function createWorkspaceTools(store: Store, trusted: () => boolean, emit: Emit) {
  const pending = new Map<string, Pending>()
  const questions = new Map<string, PendingQuestion>()
  const maps = new Map<string, Map<string, NativeMcpTool>>()
  let mcp: Mcp | undefined
  const defs: NativeChatTool[] = [
    {
      type: "function",
      function: {
        name: "create_directory",
        description: "Create one new directory inside the current workspace. Requires user permission.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "run_command",
        description: "Run a user-approved shell command in the workspace. Commands are not OS-sandboxed.",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "ask_user",
        description: "Ask the user a question and wait for their answer.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" }, description: { type: "string" } },
                required: ["label"],
              },
            },
            multiple: { type: "boolean" },
            custom: { type: "boolean" },
          },
          required: ["question", "options"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 file inside the current workspace.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or replace a UTF-8 file inside the current workspace. Requires user permission.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description: "Replace one exact, unique text range in a UTF-8 workspace file. Requires user permission.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
          required: ["path", "oldText", "newText"],
          additionalProperties: false,
        },
      },
    },
  ]

  async function permission(
    dir: string,
    sessionID: string,
    tool: string,
    path: Target,
    signal: AbortSignal,
    detail: NativeJsonObject = {},
  ) {
    if (!trusted()) throw new Error("Workspace trust is required before tools can access files")
    const name = relative(path.root, path.path) || "."
    const settings = object((await store.load(dir, "config")).data.config)
    const policy = object(settings?.permissions)?.[tool]
    if (policy === "deny") throw new Error(`Workspace policy denied ${tool}`)
    if (policy === "allow") return
    const rule = (await store.load(dir, "permissions")).data.rules
    const rules = object(rule)
    const key = permissionKey(tool, name, detail)
    if (rules?.[key] === "allow") return

    signal.throwIfAborted()
    const request: NativePermission = {
      id: randomUUID(),
      sessionID,
      directory: dir,
      tool,
      reason: reason(tool, name, detail),
      paths: [name],
      input: { path: name, ...detail },
    }
    const deferred = Promise.withResolvers<Reply>()
    const abort = () => deferred.resolve("reject")
    const timer = setTimeout(abort, PERMISSION_TIMEOUT)
    pending.set(request.id, { resolve: deferred.resolve, abort, timer })
    signal.addEventListener("abort", abort, { once: true })
    emit({ type: "permission.asked", request })
    const reply = await deferred.promise
    clearTimeout(timer)
    pending.delete(request.id)
    signal.removeEventListener("abort", abort)
    signal.throwIfAborted()
    if (reply === "reject") throw new Error("User denied the file modification permission")
    if (reply === "always") {
      await store.update(
        dir,
        (data) => ({ ...data, rules: { ...object(data.rules), [key]: "allow" } as NativeJsonObject }),
        "permissions",
      )
    }
  }

  async function write(dir: string, item: Target, text: string) {
    if (!trusted()) throw new Error("Workspace trust is required before tools can access files")
    if (new TextEncoder().encode(text).byteLength > MAX_FILE)
      throw new RangeError("File content exceeds the 1 MiB tool input limit")
    const dest = await target(dir, item.path, true)
    if (dest.root !== item.root || dest.path !== item.path)
      throw new Error("Tool path changed while awaiting permission")
    const mode = dest.exists ? (await stat(dest.path)).mode & 0o777 : 0o666
    const dirPath = dirname(dest.path)
    const root = await openDir(dest.root, dirPath)
    const base = root?.path ?? dirPath
    const path = join(base, basename(dest.path))
    const temp = join(base, `.kilo-${randomUUID()}.tmp`)
    try {
      if (!root) {
        const check = await target(dir, dest.path, true)
        if (check.root !== dest.root || check.path !== dest.path) throw new Error("Tool path changed before writing")
      }
      const file = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        mode,
      )
      try {
        await file.writeFile(text, "utf8")
        await file.sync()
      } finally {
        await file.close()
      }
      if (root) {
        if (!within(dest.root, await realpath(base))) throw new Error("Tool directory changed before replacement")
      } else {
        const check = await target(dir, dest.path, true)
        if (check.root !== dest.root || check.path !== dest.path)
          throw new Error("Tool path changed before replacement")
      }
      await rename(temp, path)
    } finally {
      await rm(temp, { force: true })
      await root?.file.close()
    }
  }

  async function read(dir: string, name: string) {
    const item = await target(dir, name, false)
    if (!trusted()) throw new Error("Workspace trust is required before tools can access files")
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    const file = await open(item.path, flags)
    try {
      const fd = fdpath(file.fd)
      if (fd) {
        if (!within(item.root, await realpath(fd))) throw new Error("Opened file resolves outside the workspace")
      } else {
        const [opened, real] = await Promise.all([file.stat(), realpath(item.path)])
        if (!within(item.root, real)) throw new Error("Opened file resolves outside the workspace")
        const current = await stat(real)
        if (opened.dev !== current.dev || opened.ino !== current.ino)
          throw new Error("Tool path changed while opening the file")
      }
      const bytes = new Uint8Array(MAX_FILE + 1)
      let size = 0
      while (size < bytes.length) {
        const chunk = await file.read(bytes, size, bytes.length - size, null)
        if (!chunk.bytesRead) break
        size += chunk.bytesRead
      }
      if (size > MAX_FILE) throw new RangeError("File exceeds the 1 MiB tool output limit")
      return { item, text: new TextDecoder().decode(bytes.subarray(0, size)) }
    } finally {
      await file.close()
    }
  }

  async function ask(sessionID: string, dir: string, value: NativeJsonObject, signal: AbortSignal) {
    signal.throwIfAborted()
    const text = input(value, "question")
    const raw = value.options
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10)
      throw new TypeError("Question options must contain 1 to 10 entries")
    const options = raw.map((item) => {
      const option = object(item)
      if (typeof option?.label !== "string" || !option.label.trim())
        throw new TypeError("Question options require a label")
      return { label: option.label, description: typeof option.description === "string" ? option.description : "" }
    })
    if (!text.trim() || text.length > 10_000)
      throw new TypeError("Question text must be between 1 and 10000 characters")
    const request: NativeQuestion = {
      id: randomUUID(),
      sessionID,
      directory: dir,
      question: text,
      options,
      ...(typeof value.multiple === "boolean" ? { multiple: value.multiple } : {}),
      ...(typeof value.custom === "boolean" ? { custom: value.custom } : {}),
    }
    const deferred = Promise.withResolvers<string[][]>()
    const abort = () => deferred.resolve([])
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      deferred.resolve([])
    }, PERMISSION_TIMEOUT)
    questions.set(request.id, { request, resolve: deferred.resolve, abort, timer })
    signal.addEventListener("abort", abort, { once: true })
    emit({ type: "question.asked", request })
    const answers = await deferred.promise
    clearTimeout(timer)
    questions.delete(request.id)
    signal.removeEventListener("abort", abort)
    signal.throwIfAborted()
    if (timedOut) throw new Error("User question timed out")
    return JSON.stringify(answers)
  }

  async function command(dir: string, sessionID: string, value: NativeJsonObject, signal: AbortSignal) {
    const text = input(value, "command")
    if (!text.trim() || text.length > 10_000) throw new TypeError("Command must be between 1 and 10000 characters")
    const root = await realpath(dir)
    await permission(dir, sessionID, "run_command", { root, path: root, exists: true }, signal, { command: text })
    signal.throwIfAborted()
    const shell =
      process.platform === "win32"
        ? (process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh")
    const args = process.platform === "win32" ? ["/d", "/s", "/c", text] : ["-lc", text]
    try {
      const result = await execTree(shell, args, { cwd: root, timeout: 120_000, maxBuffer: MAX_FILE, signal })
      return [result.stdout, result.stderr].filter(Boolean).join("\n") || "Command completed without output"
    } catch (err) {
      const value = object(err)
      const output = [value?.stdout, value?.stderr]
        .filter((item): item is string => typeof item === "string" && !!item)
        .join("\n")
      const code = typeof value?.code === "number" || typeof value?.code === "string" ? ` (exit ${value.code})` : ""
      throw new Error(
        `Command failed${code}${output ? `:\n${output}` : `: ${err instanceof Error ? err.message : String(err)}`}`,
        {
          cause: err,
        },
      )
    }
  }

  function pathKey(dir: string) {
    const value = resolve(dir)
    return process.platform === "win32" ? value.toLowerCase() : value
  }

  function name(tool: NativeMcpTool) {
    const key = `${tool.server}\0${tool.name}`
    return `mcp_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`
  }

  async function mcpCall(name: string, dir: string, sessionID: string, value: NativeJsonObject, signal: AbortSignal) {
    const tool = maps.get(pathKey(dir))?.get(name)
    if (!tool || !mcp) return undefined
    const root = await realpath(dir)
    await permission(dir, sessionID, "mcp_tool", { root, path: root, exists: true }, signal, {
      server: tool.server,
      tool: tool.name,
    })
    return JSON.stringify(await mcp.call(dir, tool.server, tool.name, value, { signal }))
  }

  async function createDirectory(dir: string, sessionID: string, path: string, signal: AbortSignal) {
    const item = await folder(dir, path)
    if (item.exists) return `Directory already exists: ${relative(item.root, item.path)}`
    await permission(dir, sessionID, "create_directory", item, signal)
    signal.throwIfAborted()
    const check = await folder(dir, item.path)
    if (check.root !== item.root || check.path !== item.path || check.exists) {
      throw new Error("Tool path changed while awaiting permission")
    }
    const parent = await openDir(check.root, dirname(check.path))
    try {
      if (!parent) {
        const verify = await folder(dir, check.path)
        if (verify.root !== check.root || verify.path !== check.path || verify.exists) {
          throw new Error("Tool path changed before directory creation")
        }
      }
      const target = join(parent?.path ?? dirname(check.path), basename(check.path))
      await mkdir(target)
      const created = await realpath(target)
      if (!within(check.root, created)) throw new Error("Created directory resolves outside the workspace")
      return `Created ${relative(check.root, created)}`
    } finally {
      await parent?.file.close()
    }
  }

  async function writeFileTool(
    dir: string,
    sessionID: string,
    path: string,
    value: NativeJsonObject,
    signal: AbortSignal,
  ) {
    const text = input(value, "content")
    const item = await target(dir, path, true)
    await permission(dir, sessionID, "write_file", item, signal)
    await write(dir, item, text)
    return `Wrote ${relative(item.root, item.path)}`
  }

  async function editFileTool(
    dir: string,
    sessionID: string,
    path: string,
    value: NativeJsonObject,
    signal: AbortSignal,
  ) {
    const oldText = input(value, "oldText")
    const newText = input(value, "newText")
    const item = await target(dir, path, false)
    await permission(dir, sessionID, "edit_file", item, signal)
    signal.throwIfAborted()
    const current = (await read(dir, path)).text
    const first = oldText ? current.indexOf(oldText) : -1
    if (first < 0 || current.indexOf(oldText, first + 1) >= 0) {
      throw new Error(`Expected one exact match in ${path}; found ${first < 0 ? 0 : "multiple"}`)
    }
    await write(dir, item, current.slice(0, first) + newText + current.slice(first + oldText.length))
    return `Updated ${relative(item.root, item.path)}`
  }

  async function file(name: string, dir: string, sessionID: string, value: NativeJsonObject, signal: AbortSignal) {
    const path = input(value, "path")
    if (name === "create_directory") return createDirectory(dir, sessionID, path, signal)
    if (name === "read_file") {
      const result = await read(dir, path)
      return `File: ${relative(result.item.root, result.item.path)}\n${result.text}`
    }
    if (name === "write_file") return writeFileTool(dir, sessionID, path, value, signal)
    if (name === "edit_file") return editFileTool(dir, sessionID, path, value, signal)
    throw new Error(`Unsupported native tool: ${name}`)
  }

  return {
    async definitions(dir?: string) {
      if (!dir || !mcp) return structuredClone(defs)
      const list = await mcp.tools(dir)
      const tools = new Map<string, NativeMcpTool>()
      const entries = list.map((item) => {
        const id = name(item)
        tools.set(id, item)
        return {
          type: "function" as const,
          function: {
            name: id,
            description: `${item.server}: ${item.name}${item.description ? ` - ${item.description}` : ""}`,
            parameters: structuredClone(item.inputSchema),
          },
        }
      })
      maps.set(pathKey(dir), tools)
      return [...structuredClone(defs), ...entries]
    },
    useMcp(value: Mcp) {
      mcp = value
    },
    async authorizeMcp(dir: string, server: NativeMcpConfig) {
      if (!trusted()) throw new Error("Workspace trust is required before connecting to MCP servers")
      const root = await realpath(dir)
      const detail: NativeJsonObject =
        server.transport === "stdio"
          ? {
              server: server.name,
              transport: server.transport,
              command: server.command,
              args: server.args ?? [],
              cwd: server.cwd ?? ".",
            }
          : { server: server.name, transport: server.transport, url: server.url }
      await permission(
        dir,
        "mcp",
        "mcp_server",
        { root, path: root, exists: true },
        new AbortController().signal,
        detail,
      )
      return true
    },
    async execute(name: string, dir: string, sessionID: string, value: NativeJsonObject, signal: AbortSignal) {
      if (name === "ask_user") return ask(sessionID, dir, value, signal)
      if (!trusted()) throw new Error("Workspace trust is required before tools can access files")
      if (name === "run_command") return command(dir, sessionID, value, signal)
      const result = await mcpCall(name, dir, sessionID, value, signal)
      if (result != null) return result
      return file(name, dir, sessionID, value, signal)
    },
    replyPermission(id: string, reply: Reply) {
      if (reply !== "once" && reply !== "always" && reply !== "reject") return false
      const item = pending.get(id)
      if (!item) return false
      clearTimeout(item.timer)
      pending.delete(id)
      item.resolve(reply)
      emit({ type: "permission.replied", requestID: id, reply })
      return true
    },
    replyQuestion(id: string, answers: string[][]) {
      const item = questions.get(id)
      if (!item || !Array.isArray(answers) || answers.length !== 1) return false
      const picks = answers[0]
      if (
        !Array.isArray(picks) ||
        picks.length > 10 ||
        picks.some((value) => typeof value !== "string" || value.length > 10_000)
      ) {
        return false
      }
      if (!item.request.multiple && picks.length > 1) return false
      if (picks.some((pick) => !item.request.options.some((option) => option.label === pick) && !item.request.custom)) {
        return false
      }
      clearTimeout(item.timer)
      questions.delete(id)
      item.resolve(answers)
      emit({ type: "question.replied", requestID: id, answers })
      return true
    },
    dispose() {
      for (const [id, item] of pending) {
        clearTimeout(item.timer)
        item.abort()
        pending.delete(id)
      }
      for (const [id, item] of questions) {
        clearTimeout(item.timer)
        item.abort()
        questions.delete(id)
      }
    },
  }
}
