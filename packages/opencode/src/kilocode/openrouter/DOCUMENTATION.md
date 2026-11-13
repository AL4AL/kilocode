# OpenRouter Batch API (implementation notes)

Docs read (2026-11-13):

| Topic | URL |
|-------|-----|
| Quickstart | https://openrouter.ai/docs/batch-quickstart |
| Create | https://openrouter.ai/docs/api/api-reference/batch/create-a-batch |
| Get | https://openrouter.ai/docs/api/api-reference/batch/get-a-batch |
| Cancel | https://openrouter.ai/docs/api/api-reference/batch/cancel-a-batch |
| List | https://openrouter.ai/docs/api/api-reference/batch/list-batches |

## Behavior we implement

- `POST https://openrouter.ai/api/v1/batches` → **202**, `status: "validating"`.
- Poll `GET /v1/batches/{id}` (~1 min interval, backoff on 429).
- `DELETE /v1/batches/{id}` on user cancel.
- Request JSON: `endpoint`, `model`, optional `provider` / `completion_window` / `callback_url` **before** `requests`.
- One chat step → one batch with a single `requests[]` item (`custom_id` per user message).
- BYOK OpenRouter API key only (not Kilo Gateway batch).
- Resume: persisted `batchId` + GET on `kilo serve` start (no webhooks, no GCS/BQ `input`).

## Batch-eligible models

OpenRouter **chat** models are loaded live from `GET /api/v1/models` (`output_modalities=text`, `endpoints=/api/v1/chat/completions`) when `OPENROUTER_API_KEY` is set — see [`catalog.ts`](./catalog.ts).

The live catalog must not filter the models API to chat-only endpoints (that drops `provider/model:batch` rows). `fromList` ingests those twins and sets `batch` on the chat base model; synthetic `*-batch` ids are still added in [`batch-models.ts`](./batch-models.ts) when no `:batch` twin exists.

`ModelCache` paginates through OpenRouter `links.next` until the list is exhausted, compares row count to `total_count`, and logs a warning when incomplete. With an API key, the VS Code extension loads this list from `kilo serve` (`GET /provider`); live rows overlay the bundled models.dev baseline so config-only entries are not dropped.
