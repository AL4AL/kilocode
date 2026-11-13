import { describe, expect, test } from "bun:test"
import { sweepPending } from "@/kilocode/openrouter/batch-resume"
import { OpenRouterBatchStore } from "@/kilocode/openrouter/batch-store"
import { SessionID, MessageID } from "@/session/schema"
import { createBatchFetch } from "../../lib/openrouter-batch-server"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import fs from "fs"

describe("batch resume sweep", () => {
  test("HL-9 sweep GET completes without duplicate POST", async () => {
    const mock = createBatchFetch({
      statuses: [
        {
          status: "completed",
          results: [
            {
              custom_id: "kilo-msg_hl9",
              response: {
                status_code: 200,
                body: { choices: [{ finish_reason: "stop", message: { content: "x" } }] },
              },
            },
          ],
        },
      ],
    })
    const stateDir = path.join(process.cwd(), `.kilo-batch-hl9-${process.pid}`)
    fs.mkdirSync(stateDir, { recursive: true })
    const prev = Global.Path.state
    Global.Path.state = stateDir
    OpenRouterBatchStore.upsert({
      batchId: "batch_hl9",
      customId: "kilo-msg_hl9",
      sessionID: SessionID.make("ses_hl9"),
      userMessageID: MessageID.make("msg_hl9"),
      model: "anthropic/claude-haiku-5.5-batch",
      providerID: "openrouter",
      createdAt: new Date().toISOString(),
    })
    process.env.OPENROUTER_API_KEY = "sk-test"
    try {
      await sweepPending({ fetch: mock.fetch })
      expect(mock.posts.length).toBe(0)
      expect(mock.fetch).toBeDefined()
    } finally {
      Global.Path.state = prev
      fs.rmSync(stateDir, { recursive: true, force: true })
      OpenRouterBatchStore.clear("kilo-msg_hl9")
    }
  })
})
