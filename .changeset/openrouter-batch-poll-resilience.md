---
"@kilocode/cli": patch
"kilo-code": patch
---

Fix OpenRouter batch polling: poll every 5 seconds with no client timeout, retry transient 404s, wait for results on completed batches, and fail only on terminal batch statuses from OpenRouter.
