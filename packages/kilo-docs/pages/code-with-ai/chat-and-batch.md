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
- **Stop** sends `DELETE`, keeps the **Stop** button until OpenRouter reports the batch **cancelled** (or gone with `404`), then returns to idle.
- The CLI polls OpenRouter every **5 seconds** (override with `KILO_OPENROUTER_BATCH_POLL_MS`) while `kilo serve` is running. There is no client-side timeout—the session stays in **waiting batch** until OpenRouter reaches a final status or you stop.
- A brief **404** right after submit is normal; Kilo keeps polling instead of failing the turn.
- User-visible failure happens only when the batch status is **`failed`**, **`expired`**, or **`cancelled`** (using OpenRouter’s `error.message`), not while the job is still validating or in progress.
- If the editor or backend restarts, pending rows resume from disk; the background sweep restarts polling every 5s while the extension is enabled.
- After a batch backfill completes, Kilo runs **title generation** when the session still has the default `New session - …` title and the assistant reply is complete (small title model, same as normal chat).

Batch requires BYOK **OpenRouter** (API key in provider settings / `auth.json`). Expect higher latency than streaming; pricing follows [OpenRouter batch docs](https://openrouter.ai/docs/batch-quickstart).
