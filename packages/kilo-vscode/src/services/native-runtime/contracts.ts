import type { NativeJsonObject } from "./types"

export type NativeSession = {
  id: string
  directory: string
  projectID: string
  parentID?: string
  title: string
  agent: string
  system?: string
  model: { providerID: string; modelID: string; variant?: string }
  time: { created: number; updated: number; archived?: number }
  status: "idle" | "busy" | "retry" | "offline"
}

export type NativeMessage = {
  id: string
  sessionID: string
  role: "user" | "assistant" | "tool"
  parentID?: string
  toolCallID?: string
  time: { created: number; completed?: number }
  parts: NativePart[]
  usage?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
}

export type NativePart =
  | { id: string; type: "text"; text: string; synthetic?: boolean }
  | { id: string; type: "reasoning"; text: string }
  | { id: string; type: "file"; name: string; mime: string; path?: string; data?: string }
  | {
      id: string
      type: "tool"
      callID: string
      name: string
      input: NativeJsonObject
      status: "pending" | "running" | "completed" | "error"
      output?: string
      error?: string
    }
  | { id: string; type: "error"; name: string; message: string; retryable: boolean }

export type NativeModel = {
  id: string
  providerID: string
  name: string
  contextWindow: number
  maxOutputTokens: number
  input: Array<"text" | "image" | "audio" | "video" | "pdf">
  output: Array<"text" | "image" | "audio">
  capabilities: { streaming: boolean; tools: boolean; reasoning: boolean; structuredOutput: boolean }
  options: NativeJsonObject
}

export type NativeProvider = {
  id: string
  name: string
  auth: "none" | "secret" | "oauth" | "device"
  connected: boolean
  models: NativeModel[]
}

export type NativeConfig = {
  providerID: string
  modelID: string
  agent: string
  variant?: string
  system?: string
  maxSteps: number
  permissions: Record<string, "allow" | "ask" | "deny">
  options: NativeJsonObject
}

export type NativePermission = {
  id: string
  sessionID: string
  directory: string
  tool: string
  reason: string
  paths?: string[]
  input: NativeJsonObject
}

export type NativeQuestion = {
  id: string
  sessionID: string
  directory: string
  question: string
  options: Array<{ label: string; description: string }>
  multiple?: boolean
  custom?: boolean
}

export type NativeMcpServer = {
  name: string
  transport: "stdio" | "http" | "sse"
  status: "disabled" | "connecting" | "connected" | "error"
  error?: string
  tools: Array<{ name: string; description?: string; inputSchema: NativeJsonObject }>
}

export type NativeEvent =
  | { type: "session.created" | "session.updated"; session: NativeSession }
  | { type: "session.deleted"; sessionID: string; directory: string }
  | { type: "session.status"; sessionID: string; status: NativeSession["status"] }
  | { type: "session.turn.open" | "session.turn.close"; sessionID: string; error?: { name: string; message: string } }
  | { type: "session.error"; sessionID: string; name: string; message: string }
  | { type: "message.created" | "message.updated"; message: NativeMessage }
  | {
      type: "message.text.delta" | "message.reasoning.delta"
      sessionID: string
      messageID: string
      partID: string
      text: string
    }
  | {
      type: "tool.input.delta"
      sessionID: string
      messageID: string
      index: number
      callID?: string
      name?: string
      text: string
    }
  | {
      type: "tool.started" | "tool.updated"
      sessionID: string
      messageID: string
      part: Extract<NativePart, { type: "tool" }>
    }
  | { type: "permission.asked"; request: NativePermission }
  | { type: "permission.replied"; requestID: string; reply: "once" | "always" | "reject" }
  | { type: "question.asked"; request: NativeQuestion }
  | { type: "question.replied"; requestID: string; answers: string[][] }
  | { type: "provider.updated"; providers: NativeProvider[] }
  | { type: "provider.catalog.error"; providerID: string; message: string }
  | {
      type: "provider.auth.device"
      providerID: string
      code: string
      verificationURL: string
      expiresIn: number
    }
  | {
      type: "provider.auth.status"
      providerID: string
      status: "approved" | "denied" | "expired" | "error"
      message?: string
    }
  | { type: "config.updated"; directory: string; config: NativeConfig }
  | { type: "mcp.updated"; directory: string; servers: NativeMcpServer[] }
  | { type: "runtime.status"; status: "ready" | "busy" | "error"; message?: string }
