// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { vectorId } from './vector-id.ts'

describe('vectorId', () => {
  it('keeps the existing form when it fits, so stored vectors stay valid', () => {
    assert.equal(vectorId('file:e31c0f2b-fdef-4851-b0be-1faec3c30d7a', 0), 'file:e31c0f2b-fdef-4851-b0be-1faec3c30d7a:0')
    assert.equal(vectorId('email:01f14684-1b37-4025-9f1d-22a3d67a7cc3:iaaaaac', 3), 'email:01f14684-1b37-4025-9f1d-22a3d67a7cc3:iaaaaac:3')
  })

  it('hashes an id over 64 bytes, the same every time', () => {
    const doc = 'email:01f315d9-b969-4147-8a47-9dc721d8e3b9:01M7NENBKYTTCFBCV18TESAGXS'
    const id = vectorId(doc, 12)
    assert.match(id, /^h:[0-9a-f]{32}:12$/)
    assert.equal(vectorId(doc, 12), id)
    assert.ok(new TextEncoder().encode(vectorId(doc, 999)).length <= 64)
  })

  it('gives different documents different ids', () => {
    const a = vectorId('email:01f315d9-b969-4147-8a47-9dc721d8e3b9:01M7NENBKYTTCFBCV18TESAGXS', 0)
    const b = vectorId('email:01f315d9-b969-4147-8a47-9dc721d8e3b9:01M7NENBKYTTCFBCV18TESAGXT', 0)
    assert.notEqual(a, b)
  })
})
