---
title: "Using llama.cpp with Kilo Code | Local LLMs"
description: "Connect a local llama.cpp server to Kilo Code through its OpenAI-compatible API."
sidebar_label: llama.cpp
---

# Using llama.cpp With Kilo Code

Kilo Code's VS Code extension includes a guided **llama.cpp** provider setup. It connects to `llama-server` through its OpenAI-compatible API, so your model can run locally.

## Start the llama.cpp server

Start `llama-server` with your model and enable its OpenAI-compatible server. The default URL used by the setup form is `http://127.0.0.1:8080/v1`.

Confirm that the server is reachable and check the model ID it reports:

```bash
curl http://127.0.0.1:8080/v1/models
```

Use the exact model ID from the response when you configure Kilo Code. If your server uses a different host, port, or API path, use its configured URL instead.

## Connect from the VS Code extension

1. Open **Settings** and select **Providers**.
2. Under **Popular Providers**, choose **llama.cpp**.
3. Enter the server URL and model ID. The form starts with local defaults, including `qwen36-local` as the model ID; replace it if your server reports a different ID.
4. Confirm the model's context and maximum output token limits. The defaults are 131,072 and 32,768 tokens.
5. Leave the API key as `sk-local` for a server that accepts any key, or enter the key your server requires. The field can also be left blank when authentication is disabled.
6. Review the model capabilities and generation defaults, then select **Save provider**.

The default generation settings are temperature `0.6`, Top P `0.95`, and Top K `20`; the request timeout defaults to 10 minutes. Enable tool calling, reasoning, or thinking mode only when your model and server support them. Set the token limits to match the model and server configuration so Kilo Code does not assume a larger context window than is available.

When **Reasoning** is enabled in the setup form, Kilo saves two chat variants — **none** (thinking off) and **thinking** (thinking on) — instead of generic OpenAI-style effort levels. The **Thinking** switch sets the default for **Default** in the picker (`enable_thinking` in model options). Match `llama-server` flags such as `--reasoning on` and your chat template when reasoning is enabled.

## Troubleshooting

- **Connection refused:** Start `llama-server` and confirm the host, port, and `/v1` path in the Server URL field.
- **Model not found:** Set Model ID to the exact `id` returned by `GET /v1/models`.
- **Requests time out:** Increase Request timeout for slower models, or use a smaller/quantized model.
- **Tools or reasoning do not work:** Turn off the related capability unless the model and server support it. Thinking mode is sent as the model-specific `enable_thinking` option.

For other local model options, see [Ollama](/docs/ai-providers/ollama), [LM Studio](/docs/ai-providers/lmstudio), and [Atomic Chat](/docs/ai-providers/atomic-chat).
