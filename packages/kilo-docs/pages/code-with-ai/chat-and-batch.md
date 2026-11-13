---
title: Chat agent and OpenRouter batch models
---

# Chat agent and OpenRouter batch models

## Chat agent

The **Chat** primary agent is plain model conversation: no Kilo soul, environment block, tools, skills, or MCP. It is not the **Ask** agent (Ask keeps a read-oriented system prompt and limited tools).

Switch agents mid-session like Code → Architect; the next user message uses the new agent's prep rules.

## Batch models

OpenRouter batch-capable models appear in the model picker with a **Batch** badge (ids ending in `-batch`). Selecting one routes the LLM step through `POST /api/v1/batches` instead of synchronous chat completions.

- One user message → one batch request per LLM step (tool loops use a new batch after tools run).
- While a batch polls, additional prompts **queue** on the session (`session.queue.changed`).
- **Stop** cancels the OpenRouter batch (`DELETE`) and clears pending store rows.
- Closing the editor stops local polling; reopening Kilo resumes via stored `batchId` + `GET /batch/{id}`.

Batch requires BYOK **OpenRouter** (`OPENROUTER_API_KEY`). Expect higher latency than streaming; pricing follows OpenRouter batch docs.
