// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'
import { decodePart, isBodyText, locateParts, param, withoutFiles, type MimePart } from './mime.ts'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const wrap76 = (s: string) => s.replace(/(.{76})/g, '$1\r\n')
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
const read = (raw: Uint8Array, p: MimePart) => decodePart(raw.subarray(p.start, p.start + p.length), p.encoding)

const pdf = randomBytes(200_000)
const png = randomBytes(30_000)
const csv = Buffer.from('a,b\r\n1,2\r\n'.repeat(500))

const message = bytes(
  [
    'From: Jane <jane@example.com>', 'To: asif@example.test', 'Subject: Test', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed;', ' boundary="outer"', '',
    'preamble', '--outer', 'Content-Type: multipart/related; boundary="rel"', '',
    '--rel', 'Content-Type: multipart/alternative; boundary=alt', '',
    '--alt', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'Caf=C3=A9 and a look-alike --outer inside a line, soft=', 'break', '',
    '--alt', 'Content-Type: text/html', '', '<p>Hello</p>', '--alt--',
    '--rel', 'Content-Type: image/png', 'Content-ID: <logo@x>', 'Content-Disposition: inline; filename="logo.png"',
    'Content-Transfer-Encoding: base64', '', wrap76(png.toString('base64')), '--rel--',
    '--outer', 'Content-Type: application/pdf; name="fallback.pdf"', 'Content-Disposition: attachment; filename="in voice.pdf"',
    'Content-Transfer-Encoding: BASE64', '', wrap76(pdf.toString('base64')),
    '--outer', 'Content-Type: text/csv', 'Content-Disposition: attachment; filename=data.csv', '', csv.toString('latin1'),
    '--outer--', 'epilogue', '',
  ].join('\r\n'),
)

describe('locateParts', () => {
  const parts = locateParts(message)

  it('finds every leaf part in order, with its place in the tree', () => {
    assert.deepEqual(parts.map((p) => `${p.path} ${p.type}`), ['1.1.1.1 text/plain', '1.1.1.2 text/html', '1.1.2 image/png', '1.2 application/pdf', '1.3 text/csv'])
  })

  it('reads names, dispositions, content ids and encodings', () => {
    const [text, , logo, invoice, data] = parts
    assert.deepEqual([text!.encoding, text!.name, text!.disposition], ['quoted-printable', null, null])
    assert.deepEqual([logo!.name, logo!.disposition, logo!.contentId, logo!.encoding], ['logo.png', 'inline', 'logo@x', 'base64'])
    assert.deepEqual([invoice!.name, invoice!.disposition, invoice!.encoding], ['in voice.pdf', 'attachment', 'base64'])
    assert.deepEqual([data!.name, data!.encoding], ['data.csv', 'plain'])
  })

  it('gives positions whose bytes decode to the original files', () => {
    const [, , logo, invoice, data] = parts
    assert.equal(sha(read(message, logo!)), sha(png))
    assert.equal(sha(read(message, invoice!)), sha(pdf))
    assert.equal(sha(read(message, data!)), sha(csv))
  })

  it('decodes quoted-printable, soft line breaks included, and ignores a boundary look-alike inside a line', () => {
    assert.equal(Buffer.from(read(message, parts[0]!)).toString('utf8'), 'Café and a look-alike --outer inside a line, softbreak\r\n')
  })

  it('treats a message without MIME headers as one text part', () => {
    const plain = bytes('Subject: Hi\n\nJust text.\n')
    const [only] = locateParts(plain)
    assert.deepEqual([only!.type, only!.encoding, Buffer.from(read(plain, only!)).toString()], ['text/plain', 'plain', 'Just text.\n'])
  })

  it('copes with a missing closing boundary and a part with no headers', () => {
    const cut = bytes('Content-Type: multipart/mixed; boundary=b\n\n--b\n\nfirst\n--b\nContent-Type: text/csv\n\nx,y\n')
    const found = locateParts(cut)
    assert.deepEqual(found.map((p) => [p.type, Buffer.from(read(cut, p)).toString()]), [['text/plain', 'first'], ['text/csv', 'x,y\n']])
  })

  it('keeps a multipart with no boundary to be found as one leaf', () => {
    const odd = bytes('Content-Type: multipart/mixed; boundary=zzz\n\nno parts here\n')
    assert.deepEqual(locateParts(odd).map((p) => p.type), ['multipart/mixed'])
  })
})

describe('withoutFiles', () => {
  const parts = locateParts(message)
  const small = withoutFiles(message, parts)

  it('cuts the bodies of files and keeps text and structure', () => {
    assert.ok(small.length < 3000, `still ${small.length} bytes`)
    const again = locateParts(small)
    assert.deepEqual(again.map((p) => `${p.path} ${p.type} ${p.name}`), parts.map((p) => `${p.path} ${p.type} ${p.name}`))
    assert.equal(Buffer.from(read(small, again[1]!)).toString(), '<p>Hello</p>')
    assert.equal(again[3]!.length, 0)
  })

  it('counts only unnamed text parts that are not attachments as body text', () => {
    assert.deepEqual(parts.map(isBodyText), [true, true, false, false, false])
  })

  it('returns the message itself when there is nothing to cut', () => {
    const plain = bytes('Subject: Hi\n\nJust text.\n')
    assert.equal(withoutFiles(plain, locateParts(plain)), plain)
  })
})

describe('param', () => {
  it('reads plain and quoted values', () => {
    assert.equal(param('attachment; filename=report.pdf', 'filename'), 'report.pdf')
    assert.equal(param('attachment; filename="Q3 \\"final\\".pdf"; size=10', 'filename'), 'Q3 "final".pdf')
    assert.equal(param('application/pdf; name=a.pdf', 'filename'), null)
  })

  it('does not take filename= for name=', () => {
    assert.equal(param('attachment; filename=a.pdf', 'name'), null)
  })

  it('decodes an RFC 2231 value with its charset', () => {
    assert.equal(param("attachment; filename*=utf-8''r%C3%A9sum%C3%A9.pdf", 'filename'), 'résumé.pdf')
    assert.equal(param("attachment; filename*=iso-8859-1'en'caf%E9.txt", 'filename'), 'café.txt')
  })

  it('joins RFC 2231 continuations in order, encoded or not', () => {
    const header = "attachment;\r\n filename*1*=%20report.pdf; filename*0*=UTF-8''Quarterly%E2%80%94Q3;"
    assert.equal(param(header.replace(/\r\n /g, ' '), 'filename'), 'Quarterly—Q3 report.pdf')
    assert.equal(param('attachment; filename*0="a very long "; filename*1="name.pdf"', 'filename'), 'a very long name.pdf')
  })

  it('prefers the RFC 2231 form over a plain fallback', () => {
    assert.equal(param("attachment; filename=\"resume.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", 'filename'), 'résumé.pdf')
  })

  it('names a part sent with continuations only', () => {
    const raw = bytes(
      'Content-Type: multipart/mixed; boundary=b\n\n--b\nContent-Type: text/plain\n\nHi\n--b\n' +
        "Content-Type: text/plain\nContent-Disposition: inline; filename*0*=utf-8''notes%20; filename*1=today.txt\n\nNotes\n--b--\n",
    )
    const parts = locateParts(raw)
    assert.equal(parts[1]!.name, 'notes today.txt')
    assert.equal(isBodyText(parts[1]!), false)
  })
})
