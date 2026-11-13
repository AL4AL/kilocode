import { describe, expect, test } from "bun:test"
import { chatToolChoice } from "@/kilocode/session/chat-agent"

describe("chat agent toolChoice", () => {
  test("forces none for chat agent", () => {
    expect(chatToolChoice("chat")).toBe("none")
    expect(chatToolChoice("code")).toBeUndefined()
  })
})
