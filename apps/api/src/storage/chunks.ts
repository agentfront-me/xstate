// Cuts a stream into pieces of exactly `size` bytes (the last one may be shorter), for multipart uploads: R2, like
// S3, needs every part except the last to be the same size. Only one piece is held in memory at a time.

/**
 * Passes a stream through unchanged while feeding every chunk to the given digests. Unlike `tee()`, nothing is
 * buffered when the consumer is slower than the hashing: one pipe, one pace.
 */
export function hashing(stream: ReadableStream<Uint8Array>, digests: WritableStream<Uint8Array>[]): ReadableStream<Uint8Array> {
  const writers = digests.map((d) => d.getWriter())
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        for (const w of writers) await w.write(chunk)
        controller.enqueue(chunk)
      },
      async flush() {
        for (const w of writers) await w.close()
      },
    }),
  )
}

export async function* fixedChunks(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let buffer = new Uint8Array(size)
  let filled = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      let offset = 0
      while (offset < value.byteLength) {
        const take = Math.min(size - filled, value.byteLength - offset)
        buffer.set(value.subarray(offset, offset + take), filled)
        filled += take
        offset += take
        if (filled === size) {
          yield buffer
          buffer = new Uint8Array(size)
          filled = 0
        }
      }
    }
    if (filled) yield buffer.subarray(0, filled)
  } finally {
    reader.releaseLock()
  }
}
