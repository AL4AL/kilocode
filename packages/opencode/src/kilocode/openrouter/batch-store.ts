// kilocode_change - new file
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import type { SessionID } from "@/session/schema"
import type { MessageID } from "@/session/schema"

export type PendingBatch = {
  batchId: string
  customId: string
  sessionID: SessionID
  userMessageID: MessageID
  model: string
  providerID: string
  createdAt: string
}

type StoreFile = {
  pending: PendingBatch[]
}

function file() {
  return path.join(Global.Path.state, "openrouter-batch.json")
}

function read(): StoreFile {
  try {
    const raw = readFileSync(file(), "utf8")
    const data = JSON.parse(raw) as StoreFile
    if (Array.isArray(data.pending)) return data
  } catch {
    // missing
  }
  return { pending: [] }
}

function write(data: StoreFile) {
  mkdirSync(path.dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(data, null, 2))
}

export namespace OpenRouterBatchStore {
  export function list() {
    return read().pending
  }

  export function upsert(row: PendingBatch) {
    const data = read()
    const rest = data.pending.filter((p) => p.customId !== row.customId && p.batchId !== row.batchId)
    data.pending = [...rest, row]
    write(data)
  }

  export function bySession(sessionID: SessionID) {
    return read().pending.filter((p) => p.sessionID === sessionID)
  }

  export function byCustom(customId: string) {
    return read().pending.find((p) => p.customId === customId)
  }

  export function byBatch(batchId: string) {
    return read().pending.find((p) => p.batchId === batchId)
  }

  export function clear(customId: string) {
    const data = read()
    data.pending = data.pending.filter((p) => p.customId !== customId)
    write(data)
  }

  export function clearSession(sessionID: SessionID) {
    const data = read()
    data.pending = data.pending.filter((p) => p.sessionID !== sessionID)
    write(data)
  }
}
