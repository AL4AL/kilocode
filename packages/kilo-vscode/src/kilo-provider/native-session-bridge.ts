import { resolve } from "node:path"
import type { NativeEvent, NativeMessage, NativePart, NativeSession } from "../services/native-runtime/contracts"
import type { createNativeRuntime } from "../services/native-runtime/runtime"
import type { Part } from "../../webview-ui/src/types/messages/parts"

type Runtime = ReturnType<typeof createNativeRuntime>
type Post = (message: unknown) => void

function parts(msg: NativeMessage): Part[] {
  return msg.parts.flatMap<Part>((part) => {
    const base = { id: part.id, sessionID: msg.sessionID, messageID: msg.id }
    if (part.type === "text")
      return [{ ...base, type: "text" as const, text: part.text, ...(part.synthetic ? { synthetic: true } : {}) }]
    if (part.type === "reasoning") return [{ ...base, type: "reasoning" as const, text: part.text }]
    if (part.type === "file") {
      return [
        {
          ...base,
          type: "file" as const,
          mime: part.mime,
          url: part.data ? `data:${part.mime};base64,${part.data}` : (part.path ?? ""),
          filename: part.name,
        },
      ]
    }
    if (part.type === "tool") {
      const state =
        part.status === "completed"
          ? { status: "completed" as const, input: part.input, output: part.output ?? "", title: part.name }
          : part.status === "error"
            ? { status: "error" as const, input: part.input, error: part.error ?? "Tool failed" }
            : part.status === "running"
              ? { status: "running" as const, input: part.input }
              : { status: "pending" as const, input: part.input }
      return [{ ...base, type: "tool" as const, tool: part.name, callID: part.callID, state }]
    }
    return []
  })
}

function message(msg: NativeMessage) {
  const info = {
    id: msg.id,
    sessionID: msg.sessionID,
    role: msg.role === "tool" ? "assistant" : msg.role,
    parts: parts(msg),
    createdAt: new Date(msg.time.created).toISOString(),
    time: msg.time,
    ...(msg.parentID ? { parentID: msg.parentID } : {}),
    ...(msg.usage
      ? {
          tokens: {
            input: msg.usage.input,
            output: msg.usage.output,
            reasoning: msg.usage.reasoning,
            cache: { read: msg.usage.cacheRead, write: msg.usage.cacheWrite },
          },
        }
      : {}),
  }
  return info
}

function session(info: NativeSession) {
  return {
    id: info.id,
    parentID: info.parentID ?? null,
    title: info.title,
    createdAt: new Date(info.time.created).toISOString(),
    updatedAt: new Date(info.time.updated).toISOString(),
    agent: info.agent,
    model: { providerID: info.model.providerID, modelID: info.model.modelID, variant: info.model.variant },
    revert: null,
    summary: null,
    goal: null,
  }
}

function status(value: NativeSession["status"]) {
  return value === "offline" ? "idle" : value
}

function sessionEvent(value: NativeEvent, root: string, sessions: Set<string>, post: Post) {
  if (value.type === "session.created" || value.type === "session.updated") {
    if (value.session.directory !== root) return true
    sessions.add(value.session.id)
    post({
      type: value.type === "session.created" ? "sessionCreated" : "sessionUpdated",
      session: session(value.session),
    })
    return true
  }
  if (value.type === "session.deleted") {
    if (value.directory !== root && !sessions.has(value.sessionID)) return true
    sessions.delete(value.sessionID)
    post({ type: "sessionDeleted", sessionID: value.sessionID })
    return true
  }
  if (value.type === "session.status") {
    if (sessions.has(value.sessionID))
      post({ type: "sessionStatus", sessionID: value.sessionID, status: status(value.status) })
    return true
  }
  if (value.type === "session.turn.open") {
    return true
  }
  if (value.type === "session.turn.close") {
    if (sessions.has(value.sessionID)) {
      post({
        type: "sessionTurnClosed",
        sessionID: value.sessionID,
        eventID: `${value.sessionID}:${Date.now()}`,
        reason: value.error ? "error" : "completed",
      })
    }
    return true
  }
  if (value.type === "session.error") {
    if (sessions.has(value.sessionID)) {
      post({
        type: "sessionError",
        sessionID: value.sessionID,
        eventID: `${value.sessionID}:${Date.now()}`,
        error: { name: value.name, data: { message: value.message } },
      })
    }
    return true
  }
  return false
}

function messageEvent(value: NativeEvent, sessions: Set<string>, text: Map<string, string>, post: Post) {
  if (value.type === "message.created" || value.type === "message.updated") {
    if (sessions.has(value.message.sessionID) && value.message.role !== "tool") {
      post({ type: "messageCreated", message: message(value.message) })
    }
    return true
  }
  if (value.type === "message.text.delta" || value.type === "message.reasoning.delta") {
    if (!sessions.has(value.sessionID)) return true
    const id = `${value.messageID}\0${value.partID}`
    const current = `${text.get(id) ?? ""}${value.text}`
    text.set(id, current)
    const type = value.type === "message.text.delta" ? "text" : "reasoning"
    post({
      type: "partUpdated",
      sessionID: value.sessionID,
      messageID: value.messageID,
      part: { id: value.partID, sessionID: value.sessionID, messageID: value.messageID, type, text: current },
      delta: { type: "text-delta", textDelta: value.text },
    })
    return true
  }
  if (value.type === "tool.started" || value.type === "tool.updated") {
    if (sessions.has(value.sessionID)) {
      post({
        type: "partUpdated",
        sessionID: value.sessionID,
        messageID: value.messageID,
        part: parts({
          id: value.messageID,
          sessionID: value.sessionID,
          role: "assistant",
          time: { created: Date.now() },
          parts: [value.part],
        })[0],
      })
    }
    return true
  }
  return false
}

function requestEvent(value: NativeEvent, root: string, requests: Set<string>, post: Post) {
  if (value.type === "permission.asked") {
    if (value.request.directory === root) {
      requests.add(value.request.id)
      post({
        type: "permissionRequest",
        permission: {
          id: value.request.id,
          sessionID: value.request.sessionID,
          toolName: value.request.tool,
          patterns: value.request.paths ?? [],
          always: [],
          args: { ...value.request.input, description: value.request.reason },
        },
      })
    }
    return true
  }
  if (value.type === "permission.replied") {
    if (requests.delete(value.requestID)) post({ type: "permissionResolved", permissionID: value.requestID })
    return true
  }
  if (value.type === "question.asked") {
    if (value.request.directory === root) {
      requests.add(value.request.id)
      post({
        type: "questionRequest",
        question: {
          id: value.request.id,
          sessionID: value.request.sessionID,
          questions: [
            {
              question: value.request.question,
              header: "Question",
              options: value.request.options,
              multiple: value.request.multiple,
              custom: value.request.custom,
            },
          ],
          blocking: true,
        },
      })
    }
    return true
  }
  if (value.type === "question.replied") {
    if (requests.delete(value.requestID)) post({ type: "questionResolved", requestID: value.requestID })
    return true
  }
  return false
}

export function createNativeSessionBridge(runtime: Runtime, dir: string, post: Post) {
  const root = resolve(dir)
  const key = process.platform === "win32" ? root.toLowerCase() : root
  const sessions = new Set<string>()
  const requests = new Set<string>()
  const text = new Map<string, string>()

  function event(value: NativeEvent) {
    if (sessionEvent(value, root, sessions, post)) return
    if (messageEvent(value, sessions, text, post)) return
    requestEvent(value, root, requests, post)
  }

  const off = runtime.onEvent(event)
  return {
    async create(input: { providerID?: string; modelID?: string; title?: string; agent?: string }) {
      const info = await runtime.sessions.create(root, input)
      sessions.add(info.id)
      return info
    },
    async list() {
      const info = await runtime.sessions.list(root)
      for (const item of info) sessions.add(item.id)
      return info.map(session)
    },
    async messages(id: string, limit?: number) {
      const info = await runtime.sessions.messages(root, id, limit)
      return info.filter((item) => item.role !== "tool").map(message)
    },
    async prompt(id: string, value: string) {
      sessions.add(id)
      return message(await runtime.sessions.prompt(root, id, value))
    },
    abort: (id: string) => runtime.sessions.abort(root, id),
    delete: (id: string) => runtime.sessions.delete(root, id),
    replyPermission: (id: string, reply: "once" | "always" | "reject") => runtime.tools.replyPermission(id, reply),
    replyQuestion: (id: string, answers: string[][]) => runtime.tools.replyQuestion(id, answers),
    dispose() {
      off()
      sessions.clear()
      requests.clear()
      text.clear()
    },
    scope: key,
  }
}
