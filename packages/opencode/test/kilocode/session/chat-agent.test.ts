import { describe, expect, test } from "bun:test"
import { chatMessages, isChat } from "@/kilocode/session/chat-agent"

describe("chat agent prep", () => {
  test("isChat", () => {
    expect(isChat("chat")).toBe(true)
    expect(isChat("code")).toBe(false)
  })

  test("strips system rows", () => {
    const rows = chatMessages([
      { role: "system", content: "secret" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
    ])
    expect(rows).toHaveLength(2)
    expect(rows[0]?.role).toBe("user")
  })
})
