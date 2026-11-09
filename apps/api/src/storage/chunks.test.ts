// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { fixedChunks } from './chunks.ts'

/** A stream that yields the given pieces, filled with a running byte counter so order can be checked. */
function streamOf(sizes: number[]): ReadableStream<Uint8Array> {
  let n = 0
  const pieces = sizes.map((size) => Uint8Array.from({ length: size }, () => n++ % 256))
  return new ReadableStream({
    pull(controller) {
      const next = pieces.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>, size: number) {
  const out: Uint8Array[] = []
  for await (const chunk of fixedChunks(stream, size)) out.push(chunk.slice())
  return out
}

describe('fixedChunks', () => {
  it('cuts uneven pieces into equal parts with a shorter last one', async () => {
    const parts = await collect(streamOf([3, 7, 1, 9, 5]), 8)
    assert.deepEqual(parts.map((p) => p.byteLength), [8, 8, 8, 1])
    const all = parts.flatMap((p) => [...p])
    assert.deepEqual(all, Array.from({ length: 25 }, (_, i) => i))
  })

  it('splits a piece larger than the part size', async () => {
    const parts = await collect(streamOf([20]), 8)
    assert.deepEqual(parts.map((p) => p.byteLength), [8, 8, 4])
  })

  it('yields nothing for an empty stream and no short tail on an exact multiple', async () => {
    assert.equal((await collect(streamOf([]), 8)).length, 0)
    assert.deepEqual((await collect(streamOf([4, 4, 8]), 8)).map((p) => p.byteLength), [8, 8])
  })
})
