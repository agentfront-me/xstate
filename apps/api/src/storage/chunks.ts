// Cuts a stream into pieces of exactly `size` bytes (the last one may be shorter), for multipart uploads: R2, like
// S3, needs every part except the last to be the same size. Only one piece is held in memory at a time.

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
