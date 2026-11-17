// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import PostalMime from 'postal-mime'
import { buildMessage, encodeWords, quotedPrintable, rfc5322Date, type OutMessage } from './compose.ts'
import { decodePart, locateParts } from './mime.ts'

const base: OutMessage = {
  from: { name: 'Pilot', email: 'hello@99events.com' },
  to: [{ name: null, email: 'someone@example.org' }],
  subject: 'Hello',
  text: 'Hi there.\n\nSee you.',
  messageId: '01M7ABC@99events.com',
  date: new Date('2026-11-18T07:05:09Z'),
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const parse = (bytes: Uint8Array) => PostalMime.parse(bytes)

describe('buildMessage', () => {
  it('builds a plain message mail apps read back the same', async () => {
    const raw = buildMessage(base)
    const mail = await parse(raw)
    assert.equal(mail.subject, 'Hello')
    assert.equal(mail.from?.address, 'hello@99events.com')
    assert.equal(mail.from?.name, 'Pilot')
    assert.equal(mail.messageId, '<01M7ABC@99events.com>')
    assert.equal(mail.text?.trim(), 'Hi there.\n\nSee you.')
    assert.match(text(raw), /^Date: Wed, 18 Nov 2026 07:05:09 \+0000\r$/m)
    assert.ok(!/(^|[^\r])\n/.test(text(raw)), 'every line break is CRLF')
  })

  it('encodes a subject, names and text outside ASCII', async () => {
    const raw = buildMessage({
      ...base,
      subject: 'Résumé — 2026 ☀️ for Zoë',
      from: { name: 'Zoë, Ops', email: 'hello@99events.com' },
      text: 'Café ' + 'é'.repeat(200),
    })
    const mail = await parse(raw)
    assert.equal(mail.subject, 'Résumé — 2026 ☀️ for Zoë')
    assert.equal(mail.from?.name, 'Zoë, Ops')
    assert.equal(mail.text?.trim(), 'Café ' + 'é'.repeat(200))
    assert.ok(text(raw).split('\r\n').every((l) => l.length <= 78), 'no line over 78 characters')
  })

  it('quotes a display name with specials', async () => {
    const mail = await parse(buildMessage({ ...base, to: [{ name: 'Doe, Jane "JD"', email: 'jane@example.org' }] }))
    assert.deepEqual(mail.to?.map((a) => [a.name, a.address]), [['Doe, Jane "JD"', 'jane@example.org']])
  })

  it('sends HTML as an alternative to the text', async () => {
    const mail = await parse(buildMessage({ ...base, html: '<p>Hi <b>there</b> &amp; caf&eacute;</p>' }))
    assert.equal(mail.html?.trim(), '<p>Hi <b>there</b> &amp; caf&eacute;</p>')
    assert.equal(mail.text?.trim(), 'Hi there.\n\nSee you.')
  })

  it('keeps files byte for byte, where our own locator finds them', async () => {
    const pdf = randomBytes(300_000)
    const raw = buildMessage({ ...base, files: [{ name: 'résumé.pdf', type: 'application/pdf', bytes: pdf }, { name: 'a "b".txt', type: 'text/plain', bytes: Buffer.from('hello') }] })
    const files = locateParts(raw).filter((p) => p.disposition === 'attachment')
    assert.equal(files.length, 2)
    assert.equal(files[0]!.name, 'résumé.pdf')
    assert.deepEqual(Buffer.from(decodePart(raw.subarray(files[0]!.start, files[0]!.start + files[0]!.length), files[0]!.encoding)), pdf)
    const mail = await parse(raw)
    assert.deepEqual(mail.attachments.map((a) => a.filename), ['résumé.pdf', 'a _b_.txt'])
  })

  it('puts images the HTML shows inline, next to it', async () => {
    const png = randomBytes(2_000)
    const raw = buildMessage({ ...base, html: '<img src="cid:logo1">', files: [{ name: 'logo.png', type: 'image/png', bytes: png, cid: 'logo1' }] })
    assert.match(text(raw), /multipart\/related/)
    assert.doesNotMatch(text(raw), /multipart\/mixed/)
    const part = locateParts(raw).find((p) => p.contentId === 'logo1')!
    assert.equal(part.disposition, 'inline')
  })

  it('threads a reply', async () => {
    const mail = await parse(buildMessage({ ...base, inReplyTo: ['a@x.com'], references: ['root@x.com', 'a@x.com'] }))
    assert.equal(mail.inReplyTo, '<a@x.com>')
    assert.equal(mail.references, '<root@x.com> <a@x.com>')
  })

  it('leaves Bcc out of what is sent, and keeps it in the mailbox\'s copy', async () => {
    const withBcc = { ...base, bcc: [{ name: null, email: 'secret@example.org' }] }
    assert.doesNotMatch(text(buildMessage(withBcc)), /secret@example\.org/)
    assert.equal((await parse(buildMessage(withBcc, { includeBcc: true }))).bcc?.[0]?.address, 'secret@example.org')
  })

  it('adds the API\'s extra headers', () => {
    assert.match(text(buildMessage({ ...base, headers: { 'List-Unsubscribe': '<https://x.example/u>' } })), /^List-Unsubscribe: <https:\/\/x\.example\/u>\r$/m)
  })
})

describe('encoding helpers', () => {
  it('keeps ASCII words as they are', () => {
    assert.equal(encodeWords('Plain subject'), 'Plain subject')
  })

  it('soft-breaks quoted-printable lines at 76', () => {
    const qp = quotedPrintable('x'.repeat(200))
    assert.ok(qp.split('\r\n').every((l) => l.length <= 76))
    assert.equal(qp.replace(/=\r\n/g, ''), 'x'.repeat(200))
  })

  it('escapes "=" and a trailing space', () => {
    assert.equal(quotedPrintable('a=b '), 'a=3Db=20')
  })

  it('writes the date in UTC', () => {
    assert.equal(rfc5322Date(new Date('2026-01-02T03:04:05Z')), 'Fri, 2 Jan 2026 03:04:05 +0000')
  })
})
