import * as fs from "fs"
import { describe, expect, it } from "bun:test"
import path from "path"
import {
  ensureCliXdgDirs,
  resolveExtensionCliXdg,
} from "../../src/services/cli-backend/server-utils"

describe("resolveExtensionCliXdg", () => {
  it("scopes CLI XDG dirs under the extension globalStorage path", () => {
    const storage = "/home/user/.config/Code/User/globalStorage/al4al.kilo-code-surge"
    const xdg = resolveExtensionCliXdg(storage)
    expect(xdg.XDG_DATA_HOME).toBe(path.join(storage, "kilo-cli", "data"))
    expect(xdg.XDG_CONFIG_HOME).toBe(path.join(storage, "kilo-cli", "config"))
    expect(xdg.XDG_STATE_HOME).toBe(path.join(storage, "kilo-cli", "state"))
    expect(xdg.XDG_CACHE_HOME).toBe(path.join(storage, "kilo-cli", "cache"))
  })

  it("creates XDG directories", () => {
    const tmp = path.join("/tmp", `surge-xdg-${process.pid}`)
    const xdg = resolveExtensionCliXdg(tmp)
    ensureCliXdgDirs(xdg)
    for (const dir of Object.values(xdg)) {
      expect(fs.existsSync(dir)).toBe(true)
    }
    fs.rmSync(path.join(tmp, "kilo-cli"), { recursive: true, force: true })
  })
})
