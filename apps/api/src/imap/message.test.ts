import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addresses, describe, envelope, parseFields, pickFields, quote, section } from './message.ts'

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))
const slice = (raw: string, s: ReturnType<typeof section>) => (s && s.kind === 'bytes' ? raw.slice(s.start, s.end) : null)

test('strings are quoted, or sent as literals when they must be', () => {
  assert.equal(quote('plain'), '"plain"')
  assert.equal(quote('say "hi" \\ there'), '"say \\"hi\\" \\\\ there"')
  assert.equal(quote('two\r\nlines'), '{10}\r\ntwo\r\nlines')
  assert.equal(quote('caf\xe9'), '{4}\r\ncaf\xe9')
})

test('address lists', () => {
  assert.deepEqual(addresses('Ann Lee <ann@x.test>, bob@y.test'), [
    { name: 'Ann Lee', mailbox: 'ann', host: 'x.test' },
    { name: null, mailbox: 'bob', host: 'y.test' },
  ])
  assert.deepEqual(addresses('"Lee, Ann" <ann@x.test>'), [{ name: 'Lee, Ann', mailbox: 'ann', host: 'x.test' }])
  assert.deepEqual(addresses('ann@x.test (Ann)'), [{ name: 'Ann', mailbox: 'ann', host: 'x.test' }])
  assert.deepEqual(addresses('=?UTF-8?B?w4k=?= <e@x.test>'), [{ name: '=?UTF-8?B?w4k=?=', mailbox: 'e', host: 'x.test' }])
  assert.deepEqual(addresses('Team: a@x.test, b@x.test;'), [
    { name: null, mailbox: 'Team', host: null },
    { name: null, mailbox: 'a', host: 'x.test' },
    { name: null, mailbox: 'b', host: 'x.test' },
    { name: null, mailbox: null, host: null },
  ])
  assert.deepEqual(addresses('undisclosed-recipients:;'), [{ name: null, mailbox: 'undisclosed-recipients', host: null }, { name: null, mailbox: null, host: null }])
  assert.deepEqual(addresses(null), [])
})

test('envelope: sender and reply-to fall back to from, folded subjects are joined', () => {
  const fields = parseFields('Date: Mon, 2 Nov 2026 10:00:00 +0000\r\nSubject: A long\r\n subject\r\nFrom: Ann <ann@x.test>\r\nTo: bob@y.test\r\nMessage-ID: <1@x.test>\r\n')
  assert.equal(
    envelope(fields),
    '("Mon, 2 Nov 2026 10:00:00 +0000" "A long subject" (("Ann" NIL "ann" "x.test")) (("Ann" NIL "ann" "x.test")) (("Ann" NIL "ann" "x.test")) ((NIL NIL "bob" "y.test")) NIL NIL NIL "<1@x.test>")',
  )
})

const simple = 'From: a@x.test\r\nSubject: Hi\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nline one\r\nline two\r\n'

test('a plain message is one part, numbered 1', () => {
  const meta = describe(bytes(simple))
  assert.equal(meta.structure, '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 20 2 NIL NIL NIL NIL)')
  assert.equal(meta.head, simple.slice(0, meta.bodyStart))
  assert.equal(slice(simple, section(meta, '')), simple)
  assert.equal(slice(simple, section(meta, 'HEADER')), simple.slice(0, meta.bodyStart))
  assert.equal(slice(simple, section(meta, 'TEXT')), 'line one\r\nline two\r\n')
  assert.equal(slice(simple, section(meta, '1')), 'line one\r\nline two\r\n')
  assert.equal(section(meta, '2'), null)
})

const inner = 'From: c@z.test\r\nSubject: Inner\r\n\r\ninner body\r\n'
const mixed =
  'From: a@x.test\r\nTo: b@y.test\r\nSubject: Files\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="XX"\r\n\r\npreamble\r\n' +
  '--XX\r\nContent-Type: multipart/alternative; boundary=YY\r\n\r\n' +
  '--YY\r\nContent-Type: text/plain\r\n\r\nplain\r\n' +
  '--YY\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>html</p>\r\n--YY--\r\n' +
  '--XX\r\nContent-Type: application/pdf; name="a b.pdf"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="a b.pdf"\r\nContent-ID: <f1@x>\r\n\r\nQUJD\r\n' +
  `--XX\r\nContent-Type: message/rfc822\r\n\r\n${inner}` +
  '--XX--\r\n'

test('a nested message: structure and every numbered section', () => {
  const meta = describe(bytes(mixed))
  assert.equal(
    meta.structure,
    '((("text" "plain" NIL NIL NIL "7bit" 5 0 NIL NIL NIL NIL)("text" "html" NIL NIL NIL "quoted-printable" 11 0 NIL NIL NIL NIL) "alternative" ("boundary" "YY") NIL NIL NIL)' +
      '("application" "pdf" ("name" "a b.pdf") "<f1@x>" NIL "base64" 4 NIL ("attachment" ("filename" "a b.pdf")) NIL NIL)' +
      `("message" "rfc822" NIL NIL NIL "7bit" ${inner.length - 2} (NIL "Inner" ((NIL NIL "c" "z.test")) ((NIL NIL "c" "z.test")) ((NIL NIL "c" "z.test")) NIL NIL NIL NIL NIL) ("text" "plain" NIL NIL NIL "7bit" 10 0 NIL NIL NIL NIL) 3 NIL NIL NIL NIL)` +
      ' "mixed" ("boundary" "XX") NIL NIL NIL)',
  )
  assert.deepEqual(Object.keys(meta.parts).sort(), ['1', '1.1', '1.2', '2', '3', '3.1'])
  assert.equal(slice(mixed, section(meta, '1.1')), 'plain')
  assert.equal(slice(mixed, section(meta, '1.2')), '<p>html</p>')
  assert.equal(slice(mixed, section(meta, '1.2.MIME')), 'Content-Type: text/html\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n')
  assert.equal(slice(mixed, section(meta, '2')), 'QUJD')
  assert.equal(slice(mixed, section(meta, '3')), inner.slice(0, -2))
  assert.equal(slice(mixed, section(meta, '3.HEADER')), 'From: c@z.test\r\nSubject: Inner\r\n\r\n')
  assert.equal(slice(mixed, section(meta, '3.TEXT')), 'inner body')
  assert.equal(slice(mixed, section(meta, '3.1')), 'inner body')
  assert.equal(section(meta, '1.HEADER'), null)
  assert.deepEqual(section(meta, 'HEADER.FIELDS (From "Subject")'), { kind: 'fields', start: 0, end: meta.bodyStart, names: ['from', 'subject'], not: false })
  assert.deepEqual(section(meta, '3.HEADER.FIELDS.NOT (From)'), { kind: 'fields', start: meta.messages['3']![0], end: meta.messages['3']![1], names: ['from'], not: true })
})

test('header fields are returned as written, folded lines included', () => {
  const head = 'From: a@x.test\r\nSubject: A long\r\n subject\r\nX-Other: 1\r\n\r\n'
  assert.equal(pickFields(head, ['subject', 'date'], false), 'Subject: A long\r\n subject\r\n\r\n')
  assert.equal(pickFields(head, ['subject'], true), 'From: a@x.test\r\nX-Other: 1\r\n\r\n')
})

test('odd messages do not break it', () => {
  assert.equal(describe(bytes('')).structure, '("text" "plain" NIL NIL NIL "7bit" 0 0 NIL NIL NIL NIL)')
  assert.equal(describe(bytes('no headers at all')).size, 17)
  // A multipart whose boundary never appears is one part.
  assert.match(describe(bytes('Content-Type: multipart/mixed; boundary=Q\r\n\r\nbody\r\n')).structure, /^\("multipart" "mixed"/)
  // LF-only line ends.
  const lf = describe(bytes('Subject: x\n\nbody\n'))
  assert.equal(lf.bodyStart, 12)
})
