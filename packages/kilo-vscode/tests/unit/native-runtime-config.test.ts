import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNativeRuntime } from "../../src/services/native-runtime/runtime"
import type { NativeConfig } from "../../src/services/native-runtime/contracts"
import type { NativeSecretStorage } from "../../src/services/native-runtime/providers"

const dirs: string[] = []

async function root() {
  const path = await mkdtemp(join(tmpdir(), "kilo-native-config-"))
  dirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const secrets: NativeSecretStorage = {
  get: async () => undefined,
  store: async () => undefined,
  delete: async () => undefined,
}

function runtime(root: string) {
  const value = createNativeRuntime({ root, secrets, trusted: () => true })
  value.providers.register({
    id: "provider",
    name: "Provider",
    auth: "none",
    connected: true,
    protocol: "openai-compatible",
    endpoint: "https://provider.example/v1",
    models: [
      {
        id: "model",
        providerID: "provider",
        name: "Model",
        contextWindow: 4096,
        maxOutputTokens: 512,
        input: ["text"],
        output: ["text"],
        capabilities: { streaming: true, tools: true, reasoning: false, structuredOutput: false },
        options: {},
      },
    ],
  })
  return value
}

describe("native runtime config", () => {
  it("persists workspace defaults and uses them when creating sessions", async () => {
    const path = await root()
    const dir = join(path, "workspace")
    const value = runtime(path)
    const config: NativeConfig = {
      providerID: "provider",
      modelID: "model",
      agent: "plan",
      system: "Respect the project conventions.",
      maxSteps: 4,
      permissions: { write_file: "ask" },
      options: { temperature: 0.2 },
    }

    try {
      expect(await value.config.set(dir, config)).toEqual(config)
      expect(await value.config.get(dir)).toEqual(config)
      expect(await value.sessions.create(dir, {})).toMatchObject({
        agent: "plan",
        system: "Respect the project conventions.",
        model: { providerID: "provider", modelID: "model" },
      })
    } finally {
      value.dispose()
    }
  })

  it("rejects credential-shaped options rather than persisting plaintext secrets", async () => {
    const path = await root()
    const value = runtime(path)

    try {
      await expect(
        value.config.set(join(path, "workspace"), {
          providerID: "provider",
          modelID: "model",
          agent: "build",
          maxSteps: 4,
          permissions: {},
          options: { nested: { apiKey: "secret-value" } },
        }),
      ).rejects.toThrow("SecretStorage")
      expect(await value.config.get(join(path, "workspace"))).toBeUndefined()
    } finally {
      value.dispose()
    }
  })
})
