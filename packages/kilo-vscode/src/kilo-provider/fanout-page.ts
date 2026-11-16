import type { ServerConfig } from "../services/cli-backend/types"

export type FanoutPage = {
  scriptId: string
  total: number
  pending: number
  running: number
  done: number
  failed: number
  offset: number
  sessionIds: string[]
  jobs: {
    id: string
    sessionId?: string
    label: string
    title?: string
    status: "pending" | "running" | "done" | "failed"
  }[]
}

export async function fetchFanout(input: {
  config: ServerConfig | null
  directory: string
  scriptID: string
  offset: number
  limit: number
}): Promise<FanoutPage | undefined> {
  if (!input.config) return
  const url = new URL("/kilocode/fanout", input.config.baseUrl)
  url.searchParams.set("scriptID", input.scriptID)
  url.searchParams.set("offset", String(input.offset))
  url.searchParams.set("limit", String(input.limit))
  if (input.directory) url.searchParams.set("directory", input.directory)
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`kilo:${input.config.password}`).toString("base64")}` },
  })
  if (!res.ok) throw new Error(`Fan-out page failed (${res.status})`)
  return (await res.json()) as FanoutPage
}
