import { describe, expect, test } from "bun:test"
import { buildCreateBody, create, cancel, TERMINAL } from "@/kilocode/openrouter/batch"
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
})
