import * as fs from "fs"
import * as path from "path"

/** Per-extension CLI state under VS Code globalStorage (auth.json, sessions, cache). */
export function resolveExtensionCliXdg(globalStorageFsPath: string) {
  const root = path.join(globalStorageFsPath, "kilo-cli")
  return {
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }
}

export function ensureCliXdgDirs(xdg: ReturnType<typeof resolveExtensionCliXdg>) {
  for (const dir of Object.values(xdg)) fs.mkdirSync(dir, { recursive: true })
}

export function ensureServerCwd(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/**
 * Parse the port number from CLI server startup output.
 * Matches lines like: "kilo server listening on http://127.0.0.1:12345"
 * Returns the port number or null if not found.
 */
export function parseServerPort(output: string, complete = false): number | null {
  const match = output.match(
    complete ? /listening on http:\/\/[\w.]+:(\d+)\r?\n/ : /listening on http:\/\/[\w.]+:(\d+)/,
  )
  if (!match) return null
  return parseInt(match[1]!, 10)
}

export function scanServerPort(output: string, chunk: string, limit: number) {
  const text = `${output}${chunk}`
  return { output: text.slice(-limit), port: parseServerPort(text, true) }
}
