import { describe, expect, it } from "bun:test"
import {
  batchCapable,
  catalogQuery,
  dedupeRows,
  fromList,
  keepsBatchTwin,
  keepsChatText,
  overlayOpenRouterModels,
} from "../../../src/kilocode/openrouter/catalog"

describe("openrouter catalog", () => {
  it("builds filtered list URL", () => {
    expect(catalogQuery()).toContain("output_modalities=text")
    expect(catalogQuery()).not.toContain("endpoints=")
    expect(catalogQuery(500)).toContain("offset=500")
  })

  it("overlays live models on the static baseline", () => {
    const merged = overlayOpenRouterModels(
      { "a/old": { id: "a/old", name: "Old" } as never },
      { "a/new": { id: "a/new", name: "New" } as never },
    )
    expect(merged["a/old"]?.name).toBe("Old")
    expect(merged["a/new"]?.name).toBe("New")
  })

  it("dedupes rows by id", () => {
    const rows = dedupeRows([
      { id: "x", name: "one" },
      { id: "x", name: "two" },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe("two")
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

  it("maps supported reasoning efforts and leaves unadvertised models empty", () => {
    const chat = {
      id: "google/gemini-4-carbon",
      name: "Carbon",
      endpoints: ["/api/v1/chat/completions"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
      supported_parameters: ["reasoning"],
      reasoning: { supported_efforts: ["high", "medium", "low", "none"], mandatory: true },
    }
    const open = {
      id: "openai/gpt-oss",
      name: "OSS",
      endpoints: ["/api/v1/chat/completions"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
      reasoning: { supported_efforts: null },
    }
    const plain = {
      id: "meta/plain",
      name: "Plain",
      endpoints: ["/api/v1/chat/completions"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
      supported_parameters: ["reasoning"],
    }
    const models = fromList({ data: [chat, open, plain] })
    expect(models[chat.id]?.reasoning_options).toEqual([{ type: "effort", values: ["high", "medium", "low"] }])
    expect(models[open.id]?.reasoning_options).toEqual([
      { type: "effort", values: ["max", "xhigh", "high", "medium", "low", "minimal", "none"] },
    ])
    expect(models[plain.id]?.reasoning_options).toEqual([])
  })

  it("keeps a batch twin's own efforts and copies the base list when the twin omits them", () => {
    const base = {
      id: "google/gemini-4-carbon",
      name: "Carbon",
      endpoints: ["/api/v1/chat/completions"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
      reasoning: { supported_efforts: ["high", "low"] },
    }
    const own = {
      id: "google/gemini-4-carbon:batch",
      name: "Carbon batch",
      endpoints: ["/api/v1/batches"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
      reasoning: { supported_efforts: ["medium"] },
    }
    const bareBase = {
      id: "google/other",
      name: "Other",
      endpoints: ["/api/v1/chat/completions"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
      reasoning: { supported_efforts: ["high", "low"] },
    }
    const bare = {
      id: "google/other:batch",
      name: "Other batch",
      endpoints: ["/api/v1/batches"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
    }
    const silentBase = {
      id: "google/silent",
      name: "Silent",
      endpoints: ["/api/v1/chat/completions"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
      reasoning: { supported_efforts: ["high", "low"] },
    }
    const silent = {
      id: "google/silent:batch",
      name: "Silent batch",
      endpoints: ["/api/v1/batches"],
      architecture: { output_modalities: ["text"], input_modalities: ["text"] },
      reasoning: { mandatory: true },
    }
    const models = fromList({ data: [base, own, bareBase, bare, silentBase, silent] })
    expect(models[own.id]?.reasoning_options).toEqual([{ type: "effort", values: ["medium"] }])
    expect(models[bare.id]?.reasoning_options).toEqual([{ type: "effort", values: ["high", "low"] }])
    expect(models[bare.id]?.reasoning).toBe(true)
    expect(models[silent.id]?.reasoning_options).toEqual([])
  })
})
