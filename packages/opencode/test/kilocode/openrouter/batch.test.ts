import { describe, expect, test } from "bun:test"
import { buildCreateBody, create, cancel, poll, TERMINAL } from "@/kilocode/openrouter/batch"
import { createBatchFetch } from "../../lib/openrouter-batch-server"

describe("openrouter batch client", () => {
  test("create body field order", () => {
    const body = buildCreateBody({
      endpoint: "/v1/chat/completions",
      model: "anthropic/claude-haiku-5.5",
      customId: "a",
      body: { messages: [], model: "anthropic/claude-haiku-5.5" },
    })
    const keys = Object.keys(body)
    expect(keys.indexOf("requests")).toBeGreaterThan(keys.indexOf("endpoint"))
    expect(keys.indexOf("requests")).toBeGreaterThan(keys.indexOf("model"))
  })

  test("create returns 202 id", async () => {
    const mock = createBatchFetch({
      statuses: [{ status: "completed", results: [] }],
    })
    const info = await create({
      token: "t",
      fetch: mock.fetch,
      payload: {
        endpoint: "/v1/chat/completions",
        model: "m",
        customId: "c1",
        body: { model: "m", messages: [] },
      },
    })
    expect(info.id).toStartWith("batch_mock_")
    expect(mock.posts.length).toBe(1)
  })

  test("cancel calls DELETE", async () => {
    const mock = createBatchFetch({ statuses: [{ status: "completed", results: [] }] })
    const created = await create({
      token: "t",
      fetch: mock.fetch,
      payload: {
        endpoint: "/v1/chat/completions",
        model: "m",
        customId: "c1",
        body: { model: "m", messages: [] },
      },
    })
    await cancel({ token: "t", id: created.id, fetch: mock.fetch })
    expect(mock.deletes).toEqual([created.id])
  })

  test("terminal statuses", () => {
    expect(TERMINAL.has("completed")).toBe(true)
    expect(TERMINAL.has("in_progress")).toBe(false)
  })

  test("poll waits for results on completed", async () => {
    const id = "batch_results_lag"
    let gets = 0
    const prevPoll = process.env.KILO_OPENROUTER_BATCH_POLL_MS
    process.env.KILO_OPENROUTER_BATCH_POLL_MS = "1"
    try {
      const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (!url.includes(id)) return new Response("not found", { status: 404 })
        gets++
        if (gets < 2) {
          return new Response(JSON.stringify({ id, status: "completed", results: null }), { status: 200 })
        }
        return new Response(
          JSON.stringify({ id, status: "completed", results: [{ custom_id: "c1", response: { status_code: 200, body: {} } }] }),
          { status: 200 },
        )
      }) as typeof fetch
      const done = await poll({ token: "t", id, fetch: http })
      expect(done.results?.length).toBe(1)
      expect(gets).toBe(2)
    } finally {
      if (prevPoll === undefined) delete process.env.KILO_OPENROUTER_BATCH_POLL_MS
      else process.env.KILO_OPENROUTER_BATCH_POLL_MS = prevPoll
    }
  })

  test("poll retries transient 404 after create", async () => {
    const id = "batch-1794604808-cfaxmZDFzwAYgO9fOO6i"
    let gets = 0
    const prevPoll = process.env.KILO_OPENROUTER_BATCH_POLL_MS
    process.env.KILO_OPENROUTER_BATCH_POLL_MS = "1"
    try {
      const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        if (url.endsWith("/v1/batches") && init?.method === "POST") {
          return new Response(JSON.stringify({ id, status: "validating" }), { status: 202 })
        }
        if (url.includes(id) && init?.method !== "DELETE") {
          gets++
          if (gets < 2) {
            return new Response(JSON.stringify({ error: { message: `Batch job ${id} not found` } }), { status: 404 })
          }
          return new Response(
            JSON.stringify({
              id,
              status: "completed",
              results: [{ custom_id: "c1", response: { status_code: 200, body: { choices: [{ message: { content: "ok" } }] } } }],
            }),
            { status: 200 },
          )
        }
        return new Response("not found", { status: 404 })
      }) as typeof fetch
      const done = await poll({ token: "t", id, fetch: http })
      expect(done.status).toBe("completed")
      expect(gets).toBe(2)
    } finally {
      if (prevPoll === undefined) delete process.env.KILO_OPENROUTER_BATCH_POLL_MS
      else process.env.KILO_OPENROUTER_BATCH_POLL_MS = prevPoll
    }
  })
})
