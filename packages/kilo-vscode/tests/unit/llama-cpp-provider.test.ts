import { describe, expect, it } from "bun:test"
import { sanitizeCustomProviderConfig } from "../../src/shared/custom-provider"
import { isPopularProvider } from "../../webview-ui/src/components/settings/provider-catalog"
import {
  LLAMA_CPP_DEFAULTS,
  LLAMA_CPP_PROVIDER_ID,
  validateLlamaCppForm,
} from "../../webview-ui/src/components/settings/llama-cpp-provider"

describe("llama.cpp provider setup", () => {
  it("builds and preserves the default local provider configuration", () => {
    const result = validateLlamaCppForm(LLAMA_CPP_DEFAULTS)
    if (!result.config) throw new Error("Expected the default llama.cpp settings to be valid")
    const saved = sanitizeCustomProviderConfig(result.config)

    expect(LLAMA_CPP_PROVIDER_ID).toBe("llama-cpp")
    expect(isPopularProvider(LLAMA_CPP_PROVIDER_ID)).toBe(true)
    expect(saved).toEqual({
      value: {
        npm: "@ai-sdk/openai-compatible",
        name: "llama.cpp",
        options: {
          baseURL: "http://127.0.0.1:8080/v1",
          timeout: 600000,
        },
        models: {
          "qwen36-local": {
            name: "Qwen3.6-35B local",
            tool_call: true,
            reasoning: true,
            temperature: true,
            limit: { context: 131072, output: 32768 },
            options: { temperature: 0.6, topP: 0.95, topK: 20, enable_thinking: true },
          },
        },
      },
    })
  })

  it("rejects malformed URLs and settings outside supported ranges", () => {
    const result = validateLlamaCppForm({
      ...LLAMA_CPP_DEFAULTS,
      baseURL: "file:///tmp/model",
      modelID: "model id",
      context: "1024",
      output: "2048",
      timeout: "999",
      temperature: "2.1",
      topP: "-0.1",
      topK: "0",
    })

    expect(result.config).toBeUndefined()
    expect(Object.keys(result.errors).sort()).toEqual(
      ["baseURL", "modelID", "output", "timeout", "temperature", "topP", "topK"].sort(),
    )
  })
})
