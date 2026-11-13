// Connection states
export type ConnectionState = "connecting" | "connected" | "disconnected" | "error"

// Session status (simplified from backend)
export type SessionStatus = "idle" | "busy" | "retry" | "offline" | "waiting_batch"

// Rich status info for retry countdown and future extensions
export type SessionStatusInfo =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number }
  | { type: "offline"; message: string }
  | { type: "waiting_batch"; batchId: string; modelId: string }

// Server info
export interface ServerInfo {
  port: number
  version?: string
}

// Device auth flow status
export type DeviceAuthStatus = "idle" | "initiating" | "pending" | "success" | "error" | "cancelled"

// Device auth state
export interface DeviceAuthState {
  status: DeviceAuthStatus
  code?: string
  verificationUrl?: string
  expiresIn?: number
  error?: string
}
