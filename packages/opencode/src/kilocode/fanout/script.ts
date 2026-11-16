export type SpawnCall = {
  prompt: string
  label: string
  paths: string[]
  isolate: boolean
}

function strings(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function fromRecord(value: Record<string, unknown>): SpawnCall | undefined {
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) return undefined
  const label = typeof value.label === "string" && value.label.trim() ? value.label.trim() : value.prompt.slice(0, 80)
  return {
    prompt: value.prompt,
    label,
    paths: strings(value.paths),
    isolate: value.isolate === true,
  }
}

/** Accept spawn(prompt, opts?) and spawn({ prompt, label, paths, isolate }). */
export function spawnCall(first: unknown, second?: unknown): SpawnCall | undefined {
  if (typeof first === "string") {
    const opts = second && typeof second === "object" ? (second as Record<string, unknown>) : {}
    return fromRecord({ ...opts, prompt: first })
  }
  if (!first || typeof first !== "object") return undefined
  return fromRecord(first as Record<string, unknown>)
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

/** Run the parent-written script. spawn is the only binding. */
export async function runScript(source: string, spawn: (call: SpawnCall) => Promise<void>) {
  const fn = new AsyncFunction(
    "spawn",
    `"use strict";\n${source}`,
  )
  await fn(async (first: unknown, second?: unknown) => {
    const call = spawnCall(first, second)
    if (!call) throw new Error("spawn() needs a prompt string or { prompt }")
    await spawn(call)
  })
}
