/** Detect OpenRouter batch validation errors (debug / retry UX). */
export function batchRetryable(error: { data?: { message?: unknown } } | undefined) {
  const raw = error?.data?.message
  const msg = typeof raw === "string" ? raw : raw == null ? "" : String(raw)
  if (msg.length === 0) return false
  return (
    /unsupported\s+['"]?reasoning['"]?\s+content/i.test(msg) ||
    /unsupported\s+['"]?tool-call['"]?\s+content/i.test(msg)
  )
}
