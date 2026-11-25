import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { NativeProviderError, type NativeChatMessage, type NativeGenerationEvent } from "./openai-compatible"
import type { NativeEvent, NativeMessage, NativePart, NativeSession } from "./contracts"
import type { createNativeStore } from "./store"
import type { createProviderRegistry } from "./providers"
import type { createWorkspaceTools } from "./tools"
import type { createNativeConfig } from "./configuration"
import type { NativeJsonObject } from "./types"

const MAX_RESPONSE = 1_048_576
const SAVE_INTERVAL = 1_500
const DEFAULT_TURNS = 8

type Store = ReturnType<typeof createNativeStore>
type Providers = ReturnType<typeof createProviderRegistry>
type Tools = ReturnType<typeof createWorkspaceTools>
type Config = ReturnType<typeof createNativeConfig>
type State = { session: NativeSession; ids: string[]; runner?: { pid: number; token: string } }
type Emit = (event: NativeEvent) => void
type Save = (dir: string, id: string, msg: NativeMessage) => Promise<void>
type Output = {
  text: string
  reasoning: string
  tokens?: NativeMessage["usage"]
  calls: Map<number, { callID?: string; name: string; args: string }>
  textID: string
  reasoningID: string
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function json(value: object): NativeJsonObject {
  const data: unknown = JSON.parse(JSON.stringify(value))
  const result = object(data)
  if (!result) throw new TypeError("Native runtime state must be a JSON object")
  return result as NativeJsonObject
}

function parseSession(value: unknown): NativeSession {
  const session = object(value)
  const model = object(session?.model)
  const time = object(session?.time)
  if (
    typeof session?.id !== "string" ||
    typeof session.directory !== "string" ||
    typeof session.projectID !== "string" ||
    typeof session.title !== "string" ||
    typeof session.agent !== "string" ||
    typeof model?.providerID !== "string" ||
    typeof model.modelID !== "string" ||
    !time ||
    typeof time.created !== "number" ||
    typeof time.updated !== "number" ||
    !["idle", "busy", "retry", "offline"].includes(String(session.status))
  ) {
    throw new Error("Native session state is missing or invalid")
  }
  return session as unknown as NativeSession
}

function state(data: NativeJsonObject): State {
  const session = parseSession(data.session)
  const ids = Array.isArray(data.messageIDs) ? data.messageIDs.filter((id): id is string => typeof id === "string") : []
  const runner = object(data.runner)
  return {
    session,
    ids,
    ...(Number.isSafeInteger(runner?.pid) && typeof runner?.token === "string"
      ? { runner: { pid: runner.pid as number, token: runner.token } }
      : {}),
  }
}

function message(value: unknown): NativeMessage {
  const msg = object(value)
  if (
    typeof msg?.id !== "string" ||
    typeof msg.sessionID !== "string" ||
    (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "tool") ||
    !Array.isArray(msg.parts) ||
    !object(msg.time)
  ) {
    throw new Error("Native message state is missing or invalid")
  }
  return msg as unknown as NativeMessage
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && typeof err === "object" && "code" in err && err.code === "EPERM"
  }
}

function scope(dir: string) {
  const path = resolve(dir)
  return process.platform === "win32" ? path.toLowerCase() : path
}

function parseTool(
  event: Extract<NativeGenerationEvent, { type: "tool.delta" }>,
  call: { callID?: string; name: string; args: string },
) {
  call.callID = event.callID ?? call.callID
  call.name += event.name ?? ""
  if (call.args.length + event.arguments.length > 65_536)
    throw new NativeProviderError("Provider tool arguments exceeded 64 KiB", false)
  call.args += event.arguments
}

function content(msg: NativeMessage) {
  return msg.parts
    .filter((part): part is Extract<NativePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function encode(msgs: NativeMessage[]): NativeChatMessage[] {
  const calls = new Set(
    msgs.flatMap((msg) =>
      msg.role === "assistant"
        ? msg.parts
            .filter((part): part is Extract<NativePart, { type: "tool" }> => part.type === "tool")
            .map((part) => part.callID)
        : [],
    ),
  )
  const replies = new Set(
    msgs
      .filter((msg) => msg.role === "tool")
      .map((msg) => msg.toolCallID)
      .filter((id): id is string => !!id),
  )
  const linked = new Set([...calls].filter((id) => replies.has(id)))
  const output: NativeChatMessage[] = []
  for (const msg of msgs) {
    const text = content(msg)
    if (msg.role === "tool") {
      if (!msg.toolCallID || !linked.has(msg.toolCallID)) continue
      output.push({ role: "tool", content: text, tool_call_id: msg.toolCallID })
      continue
    }
    const tools =
      msg.role === "assistant"
        ? msg.parts.filter(
            (part): part is Extract<NativePart, { type: "tool" }> => part.type === "tool" && linked.has(part.callID),
          )
        : []
    if (!text && !tools.length) continue
    output.push({
      role: msg.role,
      content: text || null,
      ...(tools.length
        ? {
            tool_calls: tools.map((part) => ({
              id: part.callID,
              type: "function" as const,
              function: { name: part.name, arguments: JSON.stringify(part.input) },
            })),
          }
        : {}),
    })
  }
  return output
}

function chat(msgs: NativeMessage[], limit: number): NativeChatMessage[] {
  const groups: NativeMessage[][] = []
  for (const msg of msgs) {
    if (msg.role === "user" && groups.length && groups.at(-1)?.length) groups.push([])
    if (!groups.length) groups.push([])
    groups.at(-1)?.push(msg)
  }

  const output: NativeChatMessage[] = []
  let size = 0
  for (const group of groups.toReversed()) {
    const batch = encode(group)
    const count = batch.reduce((total, msg) => {
      const text = typeof msg.content === "string" ? msg.content.length : 0
      const tools =
        msg.role === "assistant"
          ? (msg.tool_calls ?? []).reduce(
              (length, call) => length + call.function.name.length + call.function.arguments.length,
              0,
            )
          : 0
      return total + text + tools
    }, 0)
    if (!batch.length) continue
    if (size + count > limit) {
      if (!output.length) throw new RangeError("Current turn exceeds the selected model context limit")
      break
    }
    output.unshift(...batch)
    size += count
  }
  return output
}

function parts(
  text: string,
  reasoning: string,
  calls: Map<number, { callID?: string; name: string; args: string }>,
  textID: string,
  reasoningID: string,
): NativePart[] {
  const result: NativePart[] = []
  if (text) result.push({ id: textID, type: "text", text })
  if (reasoning) result.push({ id: reasoningID, type: "reasoning", text: reasoning })
  for (const call of calls.values()) {
    const parsed: unknown = call.args ? parseJson(call.args) : {}
    const input = object(parsed)
    result.push({
      id: randomUUID(),
      type: "tool",
      callID: call.callID ?? randomUUID(),
      name: call.name || "unknown",
      input: (input as NativeJsonObject | undefined) ?? {},
      status: input ? "pending" : "error",
      ...(!input ? { error: `Tool ${call.name || "unknown"} returned invalid arguments` } : {}),
    })
  }
  return result
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function snapshot(msg: NativeMessage, out: Output) {
  return {
    ...msg,
    parts: [
      ...(out.text ? [{ id: out.textID, type: "text" as const, text: out.text }] : []),
      ...(out.reasoning ? [{ id: out.reasoningID, type: "reasoning" as const, text: out.reasoning }] : []),
    ],
    ...(out.tokens ? { usage: out.tokens } : {}),
  }
}

function apply(event: NativeGenerationEvent, out: Output, id: string, msg: string, emit: Emit) {
  switch (event.type) {
    case "text.delta":
      if (out.text.length + out.reasoning.length + event.text.length > MAX_RESPONSE) {
        throw new RangeError("Provider response exceeded the 1 MiB safety limit")
      }
      out.text += event.text
      emit({ type: "message.text.delta", sessionID: id, messageID: msg, partID: out.textID, text: event.text })
      return
    case "reasoning.delta":
      if (out.text.length + out.reasoning.length + event.text.length > MAX_RESPONSE) {
        throw new RangeError("Provider response exceeded the 1 MiB safety limit")
      }
      out.reasoning += event.text
      emit({
        type: "message.reasoning.delta",
        sessionID: id,
        messageID: msg,
        partID: out.reasoningID,
        text: event.text,
      })
      return
    case "tool.delta": {
      if (!out.calls.has(event.index) && out.calls.size >= 16)
        throw new NativeProviderError("Provider exceeded the 16 tool-call limit", false)
      const call = out.calls.get(event.index) ?? { name: "", args: "" }
      parseTool(event, call)
      out.calls.set(event.index, call)
      emit({
        type: "tool.input.delta",
        sessionID: id,
        messageID: msg,
        index: event.index,
        ...(call.callID ? { callID: call.callID } : {}),
        ...(call.name ? { name: call.name } : {}),
        text: event.arguments,
      })
      return
    }
    case "usage":
      out.tokens = {
        input: event.usage.input,
        output: event.usage.output,
        reasoning: event.usage.reasoning,
        cacheRead: event.usage.cacheRead,
        cacheWrite: event.usage.cacheWrite,
      }
      return
    case "done":
      return
  }
}

async function generate(
  providers: Providers,
  tools: Tools,
  session: NativeSession,
  request: NativeChatMessage[],
  signal: AbortSignal,
  dir: string,
  id: string,
  msg: NativeMessage,
  out: Output,
  save: Save,
  emit: Emit,
) {
  let saved = Date.now()
  const model = (await providers.list())
    .find((item) => item.id === session.model.providerID)
    ?.models.find((item) => item.id === session.model.modelID)
  if (!model) throw new NativeProviderError(`Model ${session.model.modelID} is not available`, false)
  const defs = model.capabilities.tools ? await tools.definitions(session.directory) : []
  for await (const event of providers.stream(session.model.providerID, session.model.modelID, request, {
    signal,
    tools: defs,
    metadata: { taskId: session.id, projectId: session.projectID },
  })) {
    apply(event, out, id, msg.id, emit)
    if (Date.now() - saved < SAVE_INTERVAL) continue
    const current = snapshot(msg, out)
    await save(dir, id, current)
    emit({ type: "message.updated", message: current })
    saved = Date.now()
  }
}

async function runTools(
  tools: Tools,
  session: NativeSession,
  msg: NativeMessage,
  signal: AbortSignal,
  save: Save,
  append: (dir: string, id: string, msg: NativeMessage) => Promise<void>,
  emit: Emit,
) {
  const calls = msg.parts.filter((part): part is Extract<NativePart, { type: "tool" }> => part.type === "tool")
  for (const part of calls) {
    const running = { ...part, status: "running" as const }
    msg.parts = msg.parts.map((item) => (item.type === "tool" && item.callID === part.callID ? running : item))
    await save(session.directory, session.id, msg)
    emit({ type: "tool.started", sessionID: session.id, messageID: msg.id, part: running })
    let output = ""
    let failure: string | undefined
    try {
      output = await tools.execute(part.name, session.directory, session.id, part.input, signal)
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
      output = `Error: ${failure}`
    }
    output = output.length > 4096 ? `${output.slice(0, 4096)}\n[Tool output truncated]` : output
    const done: Extract<NativePart, { type: "tool" }> = {
      ...running,
      status: failure ? "error" : "completed",
      ...(failure ? { error: failure } : { output }),
    }
    msg.parts = msg.parts.map((item) => (item.type === "tool" && item.callID === part.callID ? done : item))
    await save(session.directory, session.id, msg)
    emit({ type: "tool.updated", sessionID: session.id, messageID: msg.id, part: done })

    const result: NativeMessage = {
      id: randomUUID(),
      sessionID: session.id,
      role: "tool",
      parentID: msg.id,
      toolCallID: part.callID,
      time: { created: Date.now(), completed: Date.now() },
      parts: [{ id: randomUUID(), type: "text", text: output }],
    }
    await save(session.directory, session.id, result)
    await append(session.directory, session.id, result)
    emit({ type: "message.created", message: result })
    if (signal.aborted) throw signal.reason
  }
}

async function turn(
  providers: Providers,
  tools: Tools,
  session: NativeSession,
  config: Config,
  signal: AbortSignal,
  messages: (dir: string, id: string, limit?: number) => Promise<NativeMessage[]>,
  save: Save,
  append: (dir: string, id: string, msg: NativeMessage) => Promise<void>,
  emit: Emit,
) {
  const history = await messages(session.directory, session.id, 40)
  const catalog = await providers.list()
  const model = catalog
    .find((item) => item.id === session.model.providerID)
    ?.models.find((item) => item.id === session.model.modelID)
  if (!model) throw new NativeProviderError(`Model ${session.model.modelID} is not available`, false)
  const request = chat(history, Math.max(1, Math.min(model.contextWindow * 3, 2_000_000)))
  const system = session.system ?? (await config.get(session.directory))?.system
  if (system) request.unshift({ role: "system", content: system })
  const parent = history.at(-1)
  const msg: NativeMessage = {
    id: randomUUID(),
    sessionID: session.id,
    role: "assistant",
    ...(parent ? { parentID: parent.id } : {}),
    time: { created: Date.now() },
    parts: [],
  }
  const out: Output = { text: "", reasoning: "", calls: new Map(), textID: randomUUID(), reasoningID: randomUUID() }
  let tracked = false
  try {
    await save(session.directory, session.id, msg)
    await append(session.directory, session.id, msg)
    tracked = true
    emit({ type: "message.created", message: msg })
    await generate(providers, tools, session, request, signal, session.directory, session.id, msg, out, save, emit)
    msg.time.completed = Date.now()
    msg.parts = parts(out.text, out.reasoning, out.calls, out.textID, out.reasoningID)
    msg.usage = out.tokens
    await save(session.directory, session.id, msg)
    emit({ type: "message.updated", message: msg })
    await runTools(tools, session, msg, signal, save, append, emit)
    return { message: msg, more: msg.parts.some((part) => part.type === "tool") }
  } catch (err) {
    if (tracked) {
      const error = signal.aborted ? (signal.reason as Error) : err instanceof Error ? err : new Error(String(err))
      msg.time.completed = Date.now()
      msg.parts = [
        ...(msg.parts.length ? msg.parts : parts(out.text, out.reasoning, out.calls, out.textID, out.reasoningID)),
        {
          id: randomUUID(),
          type: "error",
          name: error.name,
          message: error.message,
          retryable: err instanceof NativeProviderError && err.retryable,
        },
      ]
      msg.usage = out.tokens
      await save(session.directory, session.id, msg)
      emit({ type: "message.updated", message: msg })
    }
    throw err
  }
}

export function createSessionEngine(store: Store, providers: Providers, tools: Tools, config: Config, emit: Emit) {
  const active = new Map<string, AbortController>()

  async function get(dir: string, id: string) {
    let doc = await store.load(dir, `session:${id}`)
    const data = doc.data
    if (data.deleted === true) throw new Error(`Session not found: ${id}`)
    let current = state(data)
    if (current.session.status === "busy" && (!current.runner || !alive(current.runner.pid))) {
      doc = await store.update(
        dir,
        (value) => {
          const prev = state(value)
          if (prev.session.status !== "busy" || (prev.runner && alive(prev.runner.pid))) return value
          const next: NativeJsonObject = {
            ...value,
            session: json({ ...prev.session, status: "idle", time: { ...prev.session.time, updated: Date.now() } }),
          }
          delete next.runner
          return next
        },
        `session:${id}`,
      )
      current = state(doc.data)
      if (current.session.status === "idle") {
        emit({ type: "session.updated", session: current.session })
        emit({ type: "session.status", sessionID: id, status: "idle" })
      }
    }
    return current
  }

  async function save(dir: string, id: string, msg: NativeMessage) {
    await store.update(dir, (data) => ({ ...data, message: json(msg) }), `message:${id}:${msg.id}`)
  }

  async function append(dir: string, id: string, msg: NativeMessage) {
    await store.update(
      dir,
      (data) => {
        if (data.deleted === true) throw new Error(`Session not found: ${id}`)
        const prev = state(data)
        if (prev.ids.includes(msg.id)) return data
        const session = { ...prev.session, time: { ...prev.session.time, updated: Date.now() } }
        return { ...data, session: json(session), messageIDs: [...prev.ids, msg.id] }
      },
      `session:${id}`,
    )
  }

  async function status(dir: string, id: string, value: NativeSession["status"], token?: string) {
    const doc = await store.update(
      dir,
      (data) => {
        if (data.deleted === true) throw new Error(`Session not found: ${id}`)
        const prev = state(data)
        if (token && prev.runner?.token !== token) return data
        const next: NativeJsonObject = {
          ...data,
          session: json({ ...prev.session, status: value, time: { ...prev.session.time, updated: Date.now() } }),
        }
        if (value !== "busy") delete next.runner
        return next
      },
      `session:${id}`,
    )
    const info = state(doc.data).session
    emit({ type: "session.updated", session: info })
    emit({ type: "session.status", sessionID: id, status: info.status })
  }

  async function claim(dir: string, id: string, token: string) {
    const doc = await store.update(
      dir,
      (data) => {
        if (data.deleted === true) throw new Error(`Session not found: ${id}`)
        const prev = state(data)
        if (prev.session.status === "busy" && prev.runner && alive(prev.runner.pid)) {
          throw new Error(`Session is already running: ${id}`)
        }
        return {
          ...data,
          session: json({ ...prev.session, status: "busy", time: { ...prev.session.time, updated: Date.now() } }),
          runner: { pid: process.pid, token },
        }
      },
      `session:${id}`,
    )
    return state(doc.data).session
  }

  async function messages(dir: string, id: string, limit = 100) {
    const prev = await get(dir, id)
    const count = Math.max(0, Math.min(limit, 500))
    if (!count) return []
    return Promise.all(
      prev.ids.slice(-count).map(async (msg) => message((await store.load(dir, `message:${id}:${msg}`)).data.message)),
    )
  }

  return {
    async create(
      dir: string,
      input: { providerID?: string; modelID?: string; title?: string; agent?: string; parentID?: string },
    ) {
      const path = resolve(dir)
      const settings = await config.get(path)
      const providerID = input.providerID ?? settings?.providerID
      const modelID = input.modelID ?? settings?.modelID
      if (!providerID || !modelID)
        throw new NativeProviderError("Configure a provider and model before creating a session", false)
      const provider = (await providers.list()).find((item) => item.id === providerID)
      if (!provider?.models.some((item) => item.id === modelID)) {
        throw new NativeProviderError(`Model ${modelID} is not available from provider ${providerID}`, false)
      }
      const now = Date.now()
      const session: NativeSession = {
        id: randomUUID(),
        directory: path,
        projectID: createHash("sha256").update(scope(path)).digest("hex").slice(0, 16),
        ...(input.parentID ? { parentID: input.parentID } : {}),
        title: input.title ?? "New Session",
        agent: input.agent ?? settings?.agent ?? "build",
        model: { providerID, modelID },
        ...(settings?.system ? { system: settings.system } : {}),
        time: { created: now, updated: now },
        status: "idle",
      }
      await store.update(
        path,
        (data) => {
          if (data.session) throw new Error(`Session already exists: ${session.id}`)
          return { session: json(session), messageIDs: [] }
        },
        `session:${session.id}`,
      )
      await store.update(
        path,
        (data) => ({
          ...data,
          ids: [
            ...(Array.isArray(data.ids) ? data.ids.filter((id): id is string => typeof id === "string") : []),
            session.id,
          ],
        }),
        "sessions",
      )
      emit({ type: "session.created", session })
      return session
    },
    async get(dir: string, id: string) {
      return (await get(resolve(dir), id)).session
    },
    async list(dir: string) {
      const path = resolve(dir)
      const ids = (await store.load(path, "sessions")).data.ids
      if (!Array.isArray(ids)) return []
      return Promise.all(
        ids.filter((id): id is string => typeof id === "string").map(async (id) => (await get(path, id)).session),
      )
    },
    messages: (dir: string, id: string, limit?: number) => messages(resolve(dir), id, limit),
    async delete(dir: string, id: string) {
      const path = resolve(dir)
      const prev = await get(path, id)
      await store.update(
        path,
        (data) => {
          const current = state(data)
          if (current.session.status === "busy" && current.runner && alive(current.runner.pid)) {
            throw new Error(`Cannot delete a running session: ${id}`)
          }
          return { ...data, deleted: true }
        },
        `session:${id}`,
      )
      await store.update(
        path,
        (data) => ({ ...data, ids: (Array.isArray(data.ids) ? data.ids : []).filter((value) => value !== id) }),
        "sessions",
      )
      await Promise.all(prev.ids.map((msg) => store.remove(path, `message:${id}:${msg}`)))
      await store.remove(path, `session:${id}`)
      emit({ type: "session.deleted", sessionID: id, directory: path })
    },
    async abort(dir: string, id: string) {
      const ctl = active.get(`${scope(dir)}\0${id}`)
      if (!ctl) return false
      ctl.abort(new Error("Session response aborted"))
      return true
    },
    async prompt(dir: string, id: string, text: string) {
      const path = resolve(dir)
      const runKey = `${scope(path)}\0${id}`
      if (active.has(runKey)) throw new Error(`Session is already running: ${id}`)
      const token = randomUUID()
      const session = await claim(path, id, token)
      const ctl = new AbortController()
      active.set(runKey, ctl)
      let failure: { name: string; message: string } | undefined

      try {
        emit({ type: "session.status", sessionID: id, status: "busy" })
        emit({ type: "session.updated", session })
        emit({ type: "session.turn.open", sessionID: id })
        const prev = (await messages(path, id, 1)).at(-1)
        const user: NativeMessage = {
          id: randomUUID(),
          sessionID: id,
          role: "user",
          ...(prev ? { parentID: prev.id } : {}),
          time: { created: Date.now() },
          parts: [{ id: randomUUID(), type: "text", text }],
        }
        await save(path, id, user)
        await append(path, id, user)
        emit({ type: "message.created", message: user })

        const max = (await config.get(path))?.maxSteps ?? DEFAULT_TURNS
        for (let step = 0; step < max; step++) {
          const result = await turn(providers, tools, session, config, ctl.signal, messages, save, append, emit)
          if (!result.more) return result.message
        }
        throw new RangeError(`Agent exceeded the ${max}-turn tool limit`)
      } catch (err) {
        const error = ctl.signal.aborted
          ? (ctl.signal.reason as Error)
          : err instanceof Error
            ? err
            : new Error(String(err))
        failure = { name: error.name, message: error.message }
        emit({ type: "session.error", sessionID: id, ...failure })
        throw error
      } finally {
        active.delete(runKey)
        await status(path, id, "idle", token)
        emit({ type: "session.turn.close", sessionID: id, ...(failure ? { error: failure } : {}) })
      }
    },
    dispose() {
      for (const ctl of active.values()) ctl.abort(new Error("Native runtime disposed"))
      active.clear()
    },
  }
}
