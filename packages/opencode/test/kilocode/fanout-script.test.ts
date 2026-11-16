import { describe, expect, test } from "bun:test"
import { spawnCall } from "@/kilocode/fanout/script"

describe("spawnCall", () => {
  test("reads a prompt string", () => {
    expect(spawnCall("fix the parser")).toEqual({
      prompt: "fix the parser",
      label: "fix the parser",
      paths: [],
      isolate: false,
    })
  })

  test("reads an object and a second argument", () => {
    expect(spawnCall("fix it", { label: "parser", paths: ["a.ts", 1], isolate: true })).toEqual({
      prompt: "fix it",
      label: "parser",
      paths: ["a.ts"],
      isolate: true,
    })
    expect(spawnCall({ prompt: "  " })).toBeUndefined()
  })
})
