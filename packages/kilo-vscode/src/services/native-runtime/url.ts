export function providerURL(value: string, credentials: boolean) {
  const url = new URL(value)
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new TypeError("Provider endpoint must use HTTP or HTTPS")
  if (url.username || url.password) throw new TypeError("Provider credentials must not be embedded in the endpoint URL")
  if (
    [...url.searchParams.keys()].some((key) =>
      /(api[-_]?key|access[-_]?token|token|secret|password|authorization)/i.test(key),
    )
  ) {
    throw new TypeError("Provider credentials must be stored in SecretStorage, not endpoint query parameters")
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (url.protocol === "http:" && credentials && host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new TypeError("Provider credentials require HTTPS except for localhost endpoints")
  }
  return url
}
