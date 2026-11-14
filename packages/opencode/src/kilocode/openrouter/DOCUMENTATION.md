# OpenRouter Batch API (implementation notes)

Docs read (2026-11-14):

| Topic | URL |
|-------|-----|
| Quickstart | https://openrouter.ai/docs/batch-quickstart |
| Create | https://openrouter.ai/docs/api/api-reference/batch/create-a-batch |
| Get | https://openrouter.ai/docs/api/api-reference/batch/get-a-batch |
| Cancel | https://openrouter.ai/docs/api/api-reference/batch/cancel-a-batch |
| List | https://openrouter.ai/docs/api/api-reference/batch/list-batches |

## Behavior we implement

- `POST https://openrouter.ai/api/v1/batches` → **202**, `status: "validating"`.
- Poll `GET /v1/batches/{id}` every **5s** while `kilo serve` runs (default `KILO_OPENROUTER_BATCH_POLL_MS=5000`); backoff to 60s on `429`. No client timeout — only terminal batch statuses (`failed`, `expired`, `cancelled`) fail the turn. Treat HTTP `404` during poll as “not visible yet”. For `completed`, wait until `results` is non-null (per quickstart).
- `DELETE /v1/batches/{id}` on user cancel, then poll until `status` is `cancelled` or `GET` returns **404** (batch removed). Session stays `waiting_batch` with `phase: "cancelling"` until verified so the Stop affordance stays visible.
- Request JSON: `endpoint`, `model`, optional `provider` / `completion_window` / `callback_url` **before** `requests`.
- One chat step → one batch with a single `requests[]` item (`custom_id` per user message). While that row is in `openrouter-batch.json`, a second `LLM.run` for the same user message **resumes poll** on the stored `batchId` instead of POSTing again (session retries / reconnect during `waiting_batch`).
- BYOK OpenRouter API key only (not Kilo Gateway batch).
- Resume: persisted `batchId` in `openrouter-batch.json`; `armBatchResumeLoop()` sweeps every **5s** while `kilo serve` runs (extension enabled). Resume/backfill does not run while `OpenRouterBatchActive` holds the session or the assistant message already has text/reasoning parts (avoids duplicating live batch output). No webhooks, no GCS/BQ `input`.

## Polling and failures

Aligned with the quickstart `waitForBatch` pattern:

| Situation | Behavior |
|---|---|
| `validating` / `in_progress` / `finalizing` / `cancelling` | Keep polling at `KILO_OPENROUTER_BATCH_POLL_MS` (default 5s). |
| `completed` but `results` is null | Keep polling until results arrive (GET can lag webhooks). |
| HTTP `404` on GET | Treat as eventual consistency; keep polling (do not surface “batch not found” immediately). |
| HTTP `429` | Sleep at least 60s, then retry. |
| HTTP `5xx` | Sleep 5s, retry. |
| HTTP `402` or `410` | Fail immediately (billing / gone). |
| `failed` / `expired` / `cancelled` | Fail the turn with OpenRouter `error.message`. |

There is no Kilo-side poll timeout. A turn stays in `waiting_batch` until OpenRouter returns a terminal status or the user stops.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `KILO_OPENROUTER_BATCH_POLL_MS` | `5000` | Interval between `GET /v1/batches/{id}` while pending. |

## Batch-eligible models

OpenRouter **chat** models are loaded live from `GET /api/v1/models` (`output_modalities=text`, `endpoints=/api/v1/chat/completions`) when `OPENROUTER_API_KEY` is set — see [`catalog.ts`](./catalog.ts).

The live catalog must not filter the models API to chat-only endpoints (that drops `provider/model:batch` rows). `fromList` ingests those twins and sets `batch` on the chat base model; synthetic `*-batch` ids are still added in [`batch-models.ts`](./batch-models.ts) when no `:batch` twin exists.

`ModelCache` paginates through OpenRouter `links.next` until the list is exhausted, compares row count to `total_count`, and logs a warning when incomplete. With an API key, the VS Code extension loads this list from `kilo serve` (`GET /provider`); live rows overlay the bundled models.dev baseline so config-only entries are not dropped.
