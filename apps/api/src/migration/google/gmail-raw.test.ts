// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSizeBatch, RawTooLarge, readRawMessage, sizeBatchBody } from './gmail-raw.ts'

/** A body that arrives in chunks of `size` bytes, so escapes and the key get split across chunks. */
function stream(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let at = 0
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close()
      c.enqueue(bytes.subarray(at, at + size))
      at += size
    },
  })
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
const message = 'From: a@example.com\r\nSubject: Héllo ✓\r\n\r\nBody with ~ and ? to hit + and / in base64.\r\n'

describe('readRawMessage', () => {
  it('decodes raw and keeps the other fields, whatever the chunking', async () => {
    const json = `{\n  "id": "m1",\n  "labelIds": ["INBOX", "UNREAD"],\n  "sizeEstimate": 99,\n  "raw": "${b64url(message)}",\n  "internalDate": "1700000000000"\n}`
    for (const size of [1, 3, 7, 64, 4096]) {
      const { meta, raw } = await readRawMessage(stream(json, size))
      assert.equal(new TextDecoder().decode(raw), message)
      assert.deepEqual(meta, { id: 'm1', labelIds: ['INBOX', 'UNREAD'], sizeEstimate: 99, raw: '', internalDate: '1700000000000' })
    }
  })

  it('undoes JSON escapes Google uses for padding', async () => {
    for (const text of ['a', 'ab', 'abc', 'abcd']) {
      const padded = Buffer.from(text).toString('base64').replace(/=/g, '\\u003d')
      const { raw } = await readRawMessage(stream(`{"raw":"${padded}","id":"x"}`, 2))
      assert.equal(new TextDecoder().decode(raw), text)
    }
  })

  it('grows past a size hint that was too small', async () => {
    const big = 'x'.repeat(50_000)
    const { raw } = await readRawMessage(stream(`{"raw":"${b64url(big)}"}`, 1000), { sizeHint: 10 })
    assert.equal(raw.byteLength, big.length)
  })

  it('stops reading once the message is over the limit', async () => {
    let cancelled = false
    const body = stream(`{"raw":"${b64url('y'.repeat(10_000))}"}`, 100)
    const watched = new ReadableStream<Uint8Array>({
      async pull(c) {
        const r = await reader.read()
        if (r.done) c.close()
        else c.enqueue(r.value)
      },
      cancel() {
        cancelled = true
      },
    })
    const reader = body.getReader()
    await assert.rejects(readRawMessage(watched, { maxRawBytes: 1000 }), RawTooLarge)
    assert.ok(cancelled)
  })

  it('ignores "raw" appearing as a value', async () => {
    const { meta, raw } = await readRawMessage(stream(`{"labelIds":["Label_raw"],"note":"say \\"raw\\"","raw":"${b64url('ok')}"}`, 5))
    assert.equal(new TextDecoder().decode(raw), 'ok')
    assert.deepEqual(meta.labelIds, ['Label_raw'])
  })
})

describe('size batches', () => {
  it('builds one GET per id', () => {
    const body = sizeBatchBody(['a', 'b/c'], 'B')
    assert.equal(body.match(/^--B\r\n/gm)?.length, 2)
    assert.ok(body.includes('GET /gmail/v1/users/me/messages/b%2Fc?format=minimal&fields=id,sizeEstimate'))
    assert.ok(body.endsWith('--B--\r\n'))
  })

  it('reads sizes and leaves out failed parts', () => {
    const part = (status: string, json: string) =>
      `--batch_x\r\nContent-Type: application/http\r\nContent-ID: <response-s0>\r\n\r\nHTTP/1.1 ${status}\r\nContent-Type: application/json\r\n\r\n${json}\r\n`
    const text = part('200 OK', '{\n "id": "m1",\n "sizeEstimate": 1234\n}') + part('404 Not Found', '{"error":{"code":404}}') + part('200 OK', '{"id":"m3","sizeEstimate":5}') + '--batch_x--'
    const sizes = parseSizeBatch(text, 'multipart/mixed; boundary=batch_x')
    assert.deepEqual([...sizes], [['m1', 1234], ['m3', 5]])
  })
})
