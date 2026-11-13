// kilocode_change - new file
import type { BatchInfo } from "@/kilocode/openrouter/batch"

export type Timeline = {
  statuses: Array<Omit<BatchInfo, "id"> & { delayMs?: number }>
  /** Poll frames per batch POST (default 1). When a turn issues multiple POSTs, set this so each POST advances the timeline. */
  stagesPerBatch?: number
}

export function createBatchFetch(timeline: Timeline) {
  const posts: unknown[] = []
  const deletes: string[] = []
  const polls = new Map<string, number>()
  const order = new Map<string, number>()
  let id = 0
  let created = 0

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.endsWith("/v1/batches") && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)))
      id++
      const batchId = `batch_mock_${id}`
      polls.set(batchId, 0)
      order.set(batchId, created)
      created += 1
      return new Response(JSON.stringify({ id: batchId, status: "validating" }), { status: 202 })
    }
    const match = url.match(/\/v1\/batches\/([^/]+)$/)
    if (match && init?.method === "DELETE") {
      deletes.push(match[1]!)
      return new Response(JSON.stringify({ id: match[1], status: "cancelled" }), { status: 200 })
    }
    if (match?.[1]) {
      const batchId = match[1]!
      const step = polls.get(batchId) ?? 0
      polls.set(batchId, step + 1)
      const batch = order.get(batchId) ?? 0
      const stride = timeline.stagesPerBatch ?? 1
      const index = stride > 1 ? batch * stride + step : step
      const frame = timeline.statuses[Math.min(index, timeline.statuses.length - 1)]!
      if (frame.delayMs) await new Promise((r) => setTimeout(r, frame.delayMs))
      return new Response(JSON.stringify({ id: batchId, ...frame }), { status: 200 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof globalThis.fetch

  return { fetch, posts, deletes, polls }
}
