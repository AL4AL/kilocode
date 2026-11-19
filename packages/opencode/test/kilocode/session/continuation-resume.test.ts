import { describe, expect, test } from "bun:test"
import { MessageV2 } from "@/session/message-v2"
import { KiloSessionContinuation } from "@/kilocode/session/continuation"
import type { MessageID } from "@/session/schema"
import type { SessionID } from "@/session/schema"

const sessionID = "ses_test" as SessionID

function user(id: string): MessageV2.WithParts {
  return {
    info: {
      id: id as MessageID,
      sessionID,
      role: "user",
      time: { created: 1 },
      agent: "code",
      model: { providerID: "openrouter", modelID: "anthropic/claude-fable-5.2:batch" },
    },
    parts: [],
  } as unknown as MessageV2.WithParts
}

function assistant(id: string, parent: string, err?: { name: string; data: { message: string } }): MessageV2.WithParts {
  return {
    info: {
      id: id as MessageID,
      sessionID,
      role: "assistant",
      parentID: parent as MessageID,
      time: { created: 2 },
      agent: "code",
      mode: "code",
      modelID: "anthropic/claude-fable-5.2:batch",
      providerID: "openrouter",
      error: err,
    },
    parts: [],
  } as unknown as MessageV2.WithParts
}

describe("KiloSessionContinuation.resumable", () => {
  test("batch validation error is resumable by explicit assistant id", () => {
    const failed = assistant("msg_fail", "msg_user", {
      name: "UnknownError",
      data: {
        message:
          "Batch request 'kilo-x' contains unsupported 'reasoning' content. Batch does not support this content.",
      },
    })
    const messages = [user("msg_user"), failed]
    expect(KiloSessionContinuation.resumable(messages, failed.info.id)).toBe(true)
    expect(KiloSessionContinuation.target(messages)).toBe(failed.info.id)
  })

  test("extra later user message does not block resumable on failed batch turn", () => {
    const failed = assistant("msg_fail", "msg_user", {
      name: "UnknownError",
      data: { message: "contains unsupported 'reasoning' content" },
    })
    const follow = user("msg_follow")
    follow.info.time.created = 3
    const messages = [user("msg_user"), failed, follow]
    expect(KiloSessionContinuation.target(messages)).toBeUndefined()
    expect(KiloSessionContinuation.resumable(messages, failed.info.id)).toBe(true)
  })
})