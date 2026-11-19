import { describe, expect, test } from "bun:test"
import { normalizeBatchMessages } from "@/kilocode/openrouter/batch-messages"

describe("normalizeBatchMessages", () => {
  test("maps reasoning into text and tool-call into tool_calls", () => {
    const wire = normalizeBatchMessages([
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "use bash" },
          { type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "text", value: "a\nb" } }],
      },
    ])
    const assistant = wire.find((m) => m.role === "assistant")
    expect(assistant).toBeDefined()
    expect(Array.isArray(assistant?.content)).toBe(false)
    expect(assistant?.content).toBe("use bash")
    expect((assistant as { tool_calls?: unknown[] }).tool_calls?.length).toBe(1)
    const tool = wire.find((m) => m.role === "tool")
    expect(tool?.content).toBe("a\nb")
    expect(tool?.tool_call_id).toBe("c1")
    expect(JSON.stringify(wire)).not.toContain('"tool-call"')
    expect(JSON.stringify(wire)).not.toContain('"reasoning"')
  })
})