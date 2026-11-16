import { describe, expect, test } from "bun:test"
import { runScript, spawnCall } from "@/kilocode/fanout/script"

describe("runScript", () => {
  test("waits for spawn calls when the script does not await them", async () => {
    let n = 0
    await runScript(
      `for (let i = 0; i < 5; i++) spawn("job " + i);`,
      async () => {
        n += 1
        await Promise.resolve()
      },
    )
    expect(n).toBe(5)
  })
})

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
