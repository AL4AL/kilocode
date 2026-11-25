export type NativeSseFrame = { data: string; event?: string; id?: string; retry?: number }

const MAX_FRAME = 1_048_576

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<NativeSseFrame> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  let event: string | undefined
  let id: string | undefined
  let retry: number | undefined
  let size = 0

  const dispatch = (): NativeSseFrame | undefined => {
    size = 0
    if (!data.length) {
      event = undefined
      return
    }
    const frame = { data: data.join("\n"), event, id, retry }
    data = []
    event = undefined
    return frame
  }

  const accept = (line: string) => {
    if (!line) return dispatch()
    if (line.startsWith(":")) return
    const index = line.indexOf(":")
    const field = index < 0 ? line : line.slice(0, index)
    const value = index < 0 ? "" : line.slice(index + 1).replace(/^ /, "")
    if (field === "data") {
      size += value.length + 1
      if (size > MAX_FRAME) throw new RangeError("Provider SSE event exceeded the 1 MiB limit")
      data.push(value)
    }
    if (field === "event") event = value
    if (field === "id" && !value.includes("\0")) id = value
    if (field === "retry" && /^\d+$/.test(value)) retry = Number(value)
  }

  try {
    while (true) {
      const index = buffer.indexOf("\n")
      if (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "")
        buffer = buffer.slice(index + 1)
        const frame = accept(line)
        if (frame) yield frame
        continue
      }

      const chunk = await reader.read()
      if (chunk.done) {
        buffer += decoder.decode()
        if (buffer.length > MAX_FRAME) throw new RangeError("Provider SSE line exceeded the 1 MiB limit")
        if (buffer) {
          const frame = accept(buffer.replace(/\r$/, ""))
          buffer = ""
          if (frame) yield frame
        }
        const frame = dispatch()
        if (frame) yield frame
        return
      }
      if (chunk.value.byteLength > MAX_FRAME * 4) throw new RangeError("Provider SSE chunk exceeded the 4 MiB limit")
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length > MAX_FRAME) throw new RangeError("Provider SSE line exceeded the 1 MiB limit")
    }
  } finally {
    await reader.cancel().catch((err: unknown) => {
      if (!signal?.aborted) console.warn("[Kilo New] Failed to cancel provider SSE stream:", err)
    })
    reader.releaseLock()
  }
}
