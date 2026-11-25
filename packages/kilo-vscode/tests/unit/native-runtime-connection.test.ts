import { afterEach, describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KiloConnectionService } from "../../src/services/cli-backend/connection-service"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("connection service native runtime ownership", () => {
  it("shares one native runtime and stores data under extension global storage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kilo-native-runtime-connection-"))
    dirs.push(dir)
    const values = new Map<string, string>()
    const context = {
      globalStorageUri: { fsPath: dir },
      workspaceState: { get: () => undefined, update: async () => undefined },
      secrets: {
        get: async (key: string) => values.get(key),
        store: async (key: string, value: string) => void values.set(key, value),
        delete: async (key: string) => void values.delete(key),
      },
    } as unknown as vscode.ExtensionContext
    const service = new KiloConnectionService(context)

    try {
      const first = service.getNativeRuntime()
      expect(service.getNativeRuntime()).toBe(first)
      await first.store.update(join(dir, "workspace"), (data) => ({ ...data, marker: true }))
      expect((await first.store.load(join(dir, "workspace"))).data.marker).toBe(true)
    } finally {
      service.dispose()
    }

    expect(() => service.getNativeRuntime()).toThrow("unavailable")
  })
})
