import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNativeRuntime } from "../../src/services/native-runtime/runtime"
import type { NativeSecretStorage } from "../../src/services/native-runtime/providers"
import { execTree } from "../../src/util/process"

const dirs: string[] = []

async function root() {
  const path = await mkdtemp(join(tmpdir(), "kilo-native-tools-"))
  dirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function secrets(): NativeSecretStorage {
  return { get: async () => undefined, store: async () => undefined, delete: async () => undefined }
}

describe("native workspace tools", () => {
  it("confines paths, asks before writes, and persists exact-path allow rules", async () => {
    const path = await root()
    const dir = join(path, "repo")
    await mkdir(dir)
    const value = createNativeRuntime({ root: path, secrets: secrets(), trusted: () => true })
    let asked = 0
    value.onEvent((event) => {
      if (event.type !== "permission.asked") return
      asked++
      expect(event.request.input).toEqual({ path: "src.ts" })
      expect(value.tools.replyPermission(event.request.id, "always")).toBe(true)
    })

    try {
      await value.tools.execute(
        "write_file",
        dir,
        "session",
        { path: "src.ts", content: "const value = 1\n" },
        new AbortController().signal,
      )
      await value.tools.execute(
        "write_file",
        dir,
        "session",
        { path: "src.ts", content: "const value = 2\n" },
        new AbortController().signal,
      )
      expect(await readFile(join(dir, "src.ts"), "utf8")).toBe("const value = 2\n")
      expect(asked).toBe(1)
      expect(
        await value.tools.execute("read_file", dir, "session", { path: "src.ts" }, new AbortController().signal),
      ).toContain("const value = 2")
      await expect(
        value.tools.execute("read_file", dir, "session", { path: "../../outside" }, new AbortController().signal),
      ).rejects.toThrow("inside the workspace")
    } finally {
      value.dispose()
    }
  })

  it("rejects symlinks that resolve outside the workspace", async () => {
    const path = await root()
    const dir = join(path, "repo")
    const outside = join(path, "secret.txt")
    await mkdir(dir)
    await writeFile(outside, "private")
    await symlink(outside, join(dir, "linked.txt"))
    const value = createNativeRuntime({ root: path, secrets: secrets(), trusted: () => true })

    try {
      await expect(
        value.tools.execute("read_file", dir, "session", { path: "linked.txt" }, new AbortController().signal),
      ).rejects.toThrow("outside the workspace")
    } finally {
      value.dispose()
    }
  })

  it("revalidates workspace paths after a permission wait", async () => {
    const path = await root()
    const dir = join(path, "repo")
    const sub = join(dir, "src")
    const outside = join(path, "outside")
    await mkdir(sub, { recursive: true })
    await mkdir(outside)
    const value = createNativeRuntime({ root: path, secrets: secrets(), trusted: () => true })
    const request = Promise.withResolvers<string>()
    value.onEvent((event) => {
      if (event.type === "permission.asked") request.resolve(event.request.id)
    })

    try {
      const task = value.tools.execute(
        "write_file",
        dir,
        "session",
        { path: "src/new.ts", content: "outside" },
        new AbortController().signal,
      )
      const id = await request.promise
      await rm(sub, { recursive: true })
      await symlink(outside, sub)
      value.tools.replyPermission(id, "once")

      await expect(task).rejects.toThrow("outside the workspace")
      await expect(readFile(join(outside, "new.ts"), "utf8")).rejects.toThrow()
    } finally {
      value.dispose()
    }
  })

  it("denies file operations when the workspace is not trusted", async () => {
    const path = await root()
    const dir = join(path, "repo")
    await mkdir(dir)
    const value = createNativeRuntime({ root: path, secrets: secrets(), trusted: () => false })

    try {
      await expect(
        value.tools.execute("read_file", dir, "session", { path: "src.ts" }, new AbortController().signal),
      ).rejects.toThrow("Workspace trust is required")
    } finally {
      value.dispose()
    }
  })

  it("routes model questions to the user and validates the selected answer", async () => {
    const path = await root()
    const dir = join(path, "repo")
    await mkdir(dir)
    const value = createNativeRuntime({ root: path, secrets: secrets(), trusted: () => true })
    const request = Promise.withResolvers<string>()
    value.onEvent((event) => {
      if (event.type === "question.asked") request.resolve(event.request.id)
    })

    try {
      const answer = value.tools.execute(
        "ask_user",
        dir,
        "session",
        { question: "Use this option?", options: [{ label: "Apply", description: "Continue" }] },
        new AbortController().signal,
      )
      const id = await request.promise
      expect(value.tools.replyQuestion(id, [["Unknown"]])).toBe(false)
      expect(value.tools.replyQuestion(id, [["Apply"]])).toBe(true)
      expect(await answer).toBe('[["Apply"]]')
    } finally {
      value.dispose()
    }
  })

  it("creates workspace directories only after user permission", async () => {
    const path = await root()
    const dir = join(path, "repo")
    await mkdir(dir)
    const value = createNativeRuntime({ root: path, secrets: secrets(), trusted: () => true })
    let asked = 0
    value.onEvent((event) => {
      if (event.type !== "permission.asked") return
      asked++
      value.tools.replyPermission(event.request.id, "once")
    })

    try {
      const result = await value.tools.execute(
        "create_directory",
        dir,
        "session",
        { path: "src" },
        new AbortController().signal,
      )
      expect(result).toBe("Created src")
      expect((await stat(join(dir, "src"))).isDirectory()).toBe(true)
      expect(asked).toBe(1)
    } finally {
      value.dispose()
    }
  })

  it("runs shell commands through the extension process wrapper after permission", async () => {
    const path = await root()
    const dir = join(path, "repo")
    await mkdir(dir)
    const value = createNativeRuntime({ root: path, secrets: secrets(), trusted: () => true })
    const request = Promise.withResolvers<string>()
    value.onEvent((event) => {
      if (event.type === "permission.asked" && event.request.tool === "run_command") {
        expect(event.request.input.command).toBe("node -e \"process.stdout.write('native-ok')\"")
        request.resolve(event.request.id)
      }
    })

    try {
      const result = value.tools.execute(
        "run_command",
        dir,
        "session",
        { command: "node -e \"process.stdout.write('native-ok')\"" },
        new AbortController().signal,
      )
      expect(value.tools.replyPermission(await request.promise, "once")).toBe(true)
      expect(await result).toBe("native-ok")
    } finally {
      value.dispose()
    }
  })

  it.skipIf(process.platform === "win32")("terminates command descendants when the caller aborts", async () => {
    const path = await root()
    const file = join(path, "child.pid")
    const ctl = new AbortController()
    const code = [
      'const { spawn } = require("node:child_process")',
      'const fs = require("node:fs")',
      'process.on("SIGTERM", () => {})',
      'const child = spawn(process.execPath, ["-e", "process.on(\\\"SIGTERM\\\", () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" })',
      `fs.writeFileSync(${JSON.stringify(file)}, String(child.pid))`,
      "setInterval(() => {}, 1000)",
    ].join(";")
    const task = execTree(process.execPath, ["-e", code], { cwd: path, signal: ctl.signal })

    for (let attempt = 0; attempt < 40 && !(await Bun.file(file).exists()); attempt++) {
      await new Promise<void>((done) => setTimeout(done, 25))
    }
    const pid = Number(await readFile(file, "utf8"))
    ctl.abort(new Error("stop tree"))

    await expect(task).rejects.toThrow("stop tree")
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        return !(typeof err === "object" && err !== null && "code" in err && err.code === "ESRCH")
      }
    }
    for (let attempt = 0; attempt < 20 && alive(); attempt++) await new Promise<void>((done) => setTimeout(done, 25))
    expect(alive()).toBe(false)
  })
})
