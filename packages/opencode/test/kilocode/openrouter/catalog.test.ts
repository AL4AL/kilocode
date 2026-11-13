import { describe, expect, it } from "bun:test"
import {
  batchCapable,
  catalogQuery,
  fromList,
  keepsBatchTwin,
  keepsChatText,
} from "../../../src/kilocode/openrouter/catalog"

describe("openrouter catalog", () => {
  it("builds filtered list URL", () => {
    expect(catalogQuery()).toContain("output_modalities=text")
    expect(catalogQuery()).not.toContain("endpoints=")
  })

  it("drops embedding and decision models", () => {
    expect(
      keepsChatText({
        id: "openai/text-embedding-3-small",
        name: "embed",
        endpoints: ["/api/v1/embeddings"],
        architecture: { output_modalities: ["embeddings"] },
      }),
    ).toBe(false)
    expect(
      keepsChatText({
        id: "openai/gpt-4",
        name: "GPT-4",
        endpoints: ["/api/v1/chat/completions"],
        architecture: { output_modalities: ["text"] },
      }),
    ).toBe(true)
  })

  it("maps batch capability from endpoints", () => {
    const row = {
      id: "deepseek/deepseek-v4-flash-0731",
      name: "Flash",
      endpoints: ["/api/v1/chat/completions", "/api/v1/batches"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
      context_length: 128_000,
    }
    expect(batchCapable(row)).toBe(true)
    const models = fromList({ data: [row] })
    expect((models[row.id] as { batch?: boolean })?.batch).toBe(true)
  })

  it("includes :batch twins and marks chat base models batch-capable", () => {
    const base = {
      id: "deepseek/deepseek-v4.1-flash-1017",
      name: "Flash base",
      endpoints: ["/api/v1/chat/completions"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
    }
    const twin = {
      id: "deepseek/deepseek-v4.1-flash-1017:batch",
      name: "Flash batch",
      endpoints: ["/api/v1/batches"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
    }
    expect(keepsBatchTwin(twin)).toBe(true)
    const models = fromList({ data: [base, twin] })
    expect((models[twin.id] as { openrouterBatch?: boolean })?.openrouterBatch).toBe(true)
    expect((models[base.id] as { batch?: boolean })?.batch).toBe(true)
  })
})
