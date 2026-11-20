import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasHeader, headerEnd, rewriteHeaders } from './raw-headers.ts'

const bytes = (s: string) => new TextEncoder().encode(s)
const text = (b: Uint8Array) => new TextDecoder().decode(b)
const message = 'From: A <a@x.test>\r\nTo: b@y.test\r\nBcc: secret@z.test,\r\n other@z.test\r\nMessage-Id: <client@laptop>\r\nSubject: Hi\r\n\r\nBody line\r\nBcc: not a header\r\n'

test('the header block ends at the blank line', () => {
  assert.equal(text(bytes(message).subarray(headerEnd(bytes(message)))), '\r\nBody line\r\nBcc: not a header\r\n')
  assert.equal(headerEnd(bytes('A: 1\n\nbody')), 5)
  assert.equal(headerEnd(bytes('A: 1\r\n')), 6)
})

test('headers are found whatever their capitals', () => {
  assert.equal(hasHeader(bytes(message), 'message-id'), true)
  assert.equal(hasHeader(bytes(message), 'date'), false)
  // A line in the body that looks like a header isn't one.
  assert.equal(hasHeader(bytes('A: 1\r\n\r\nDate: x\r\n'), 'date'), false)
})

test('removes a folded header whole and leaves the body alone', () => {
  const out = text(rewriteHeaders(bytes(message), ['bcc'], []))
  assert.equal(out, 'From: A <a@x.test>\r\nTo: b@y.test\r\nMessage-Id: <client@laptop>\r\nSubject: Hi\r\n\r\nBody line\r\nBcc: not a header\r\n')
})

test('replaces the Message-ID and adds lines first', () => {
  const out = text(rewriteHeaders(bytes(message), ['bcc', 'message-id'], ['Message-ID: <ses@amazonses.com>', 'Bcc: secret@z.test']))
  assert.ok(out.startsWith('Message-ID: <ses@amazonses.com>\r\nBcc: secret@z.test\r\nFrom: A <a@x.test>\r\n'))
  assert.ok(!out.includes('client@laptop'))
  assert.ok(out.endsWith('\r\n\r\nBody line\r\nBcc: not a header\r\n'))
})

test('bytes above ASCII in headers and body survive', () => {
  const raw = new Uint8Array([...bytes('Subject: '), 0xe9, ...bytes('\r\n\r\n'), 0xff, 0x00, 0x80])
  const out = rewriteHeaders(raw, [], ['X-A: 1'])
  assert.deepEqual([...out.subarray(out.length - 3)], [0xff, 0x00, 0x80])
  assert.equal(out[bytes('X-A: 1\r\nSubject: ').length], 0xe9)
})

test('a message that is only headers', () => {
  assert.equal(text(rewriteHeaders(bytes('A: 1'), [], ['B: 2'])), 'B: 2\r\nA: 1\r\n')
})
