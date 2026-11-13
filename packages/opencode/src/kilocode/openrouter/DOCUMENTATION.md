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

See the [batch quickstart](https://openrouter.ai/docs/batch-quickstart) section on models with a batch variant (otherwise **400**). Catalog field `batch` / `openrouterBatch` when models.dev exposes it; else [`batch-models.ts`](./batch-models.ts) allowlist and synthetic `*-batch` picker ids.

Official docs refer to a **batch models list** (models without a batch variant return **400**).
We mark models with `openrouterBatch: true` via catalog metadata when present, else
[`batch-models.ts`](./batch-models.ts) allowlist + synthetic `-batch` picker ids sharing `api.id`.
