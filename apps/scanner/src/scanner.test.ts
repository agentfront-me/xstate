// pnpm --filter @xstate/scanner test
import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { clamd, hasEicar, parseReply, parseVersion } from './clamd.ts'
import { attachments, hookResponse, judge, rawMessage, type HookRequest } from './message.ts'
import { scanServer } from './server.ts'

// The EICAR test file, in two halves so this file isn't flagged itself.
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
const SECRET = 'test-secret-0123456789'
const enc = (s: string) => new TextEncoder().encode(s)
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64')

/** A message with one attachment, the way Stalwart's hook hands it over: header pairs, then the body. */
function hookMessage(file: { name: string; content: string | Uint8Array } | null): NonNullable<HookRequest['message']> {
  const headers: [string, string][] = [
    ['From', ' Alice <alice@example.com>\r\n'],
    ['To', ' bob@xstate.test\r\n'],
    ['Subject', ' Invoice\r\n'],
    ['MIME-Version', ' 1.0\r\n'],
    ['Content-Type', ' multipart/mixed; boundary="b1"\r\n'],
  ]
  const text = '--b1\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n'
  const part = file
    ? `--b1\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="${file.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(file.content)}\r\n`
    : ''
  return { headers, contents: `${text}${part}--b1--\r\n`, size: 1000 }
}

/** A stand-in for clamd that speaks its INSTREAM protocol: "infected" when the stream holds EICAR. */
function fakeDaemon(): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0)
    let command: string | null = null
    const body: Buffer[] = []
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (command === null) {
        const end = buffer.indexOf(0)
        if (end < 0) return
        command = buffer.subarray(1, end).toString()
        buffer = buffer.subarray(end + 1)
        if (command === 'PING') return socket.end('PONG\0')
        if (command === 'VERSION') return socket.end('ClamAV 1.4.3/27812/Tue Nov 10 09:30:21 2026\0')
      }
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0)
        if (size === 0) return socket.end(hasEicar(Buffer.concat(body)) ? 'stream: Eicar-Signature FOUND\0' : 'stream: OK\0')
        if (buffer.length < 4 + size) return
        body.push(buffer.subarray(4, 4 + size))
        buffer = buffer.subarray(4 + size)
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

describe('clamd replies', () => {
  it('reads clean, infected and error replies', () => {
    assert.deepEqual(parseReply('stream: OK'), { infected: false })
    assert.deepEqual(parseReply('stream: Win.Test.EICAR_HDB-1 FOUND'), { infected: true, virus: 'Win.Test.EICAR_HDB-1' })
    assert.throws(() => parseReply('INSTREAM size limit exceeded. ERROR'), /size limit/)
    assert.throws(() => parseReply(''), /no reply/)
  })
  it('reads the signature date from VERSION', () => {
    const v = parseVersion('ClamAV 1.4.3/27812/Tue Nov 10 09:30:21 2026')
    assert.equal(v.version, 'ClamAV 1.4.3')
    assert.equal(v.signatures?.getFullYear(), 2026)
    assert.equal(parseVersion('ClamAV 1.4.3').signatures, null)
  })
})

describe('clamd client', () => {
  let daemon: Server
  let address = ''
  before(async () => {
    daemon = await fakeDaemon()
    address = `127.0.0.1:${(daemon.address() as AddressInfo).port}`
  })
  after(() => daemon.close())

  it('scans bytes over INSTREAM, in chunks', async () => {
    const clam = clamd(address)
    assert.deepEqual(await clam.scan(new Uint8Array(300_000).fill(65)), { infected: false })
    const dirty = Buffer.concat([Buffer.alloc(200_000, 66), Buffer.from(EICAR)])
    assert.deepEqual(await clam.scan(dirty), { infected: true, virus: 'Eicar-Signature' })
  })
  it('scans a stream of chunks', async () => {
    async function* chunks() {
      yield enc('hello ')
      yield enc(EICAR)
    }
    assert.equal((await clamd(address).scan(chunks())).infected, true)
  })
  it('pings and reads the version', async () => {
    const clam = clamd(address)
    await clam.ping()
    assert.equal((await clam.version()).version, 'ClamAV 1.4.3')
  })
  it('fails (never "clean") when clamd is unreachable', async () => {
    await assert.rejects(clamd('127.0.0.1:1').scan(enc('x')))
  })
})

describe('messages', () => {
  const fake = clamd('fake')

  it('rebuilds the message and finds its attachments', async () => {
    const parts = await attachments(rawMessage(hookMessage({ name: 'report.pdf', content: '%PDF-1.7' })))
    assert.deepEqual(parts.map((p) => p.name), ['report.pdf'])
    assert.equal(Buffer.from(parts[0]!.bytes).toString(), '%PDF-1.7')
  })
  it('accepts ordinary mail', async () => {
    assert.deepEqual(await judge(rawMessage(hookMessage(null)), fake, true), { ok: true })
    assert.deepEqual(await judge(rawMessage(hookMessage({ name: 'report.pdf', content: '%PDF-1.7' })), fake, true), { ok: true })
  })
  it('refuses blocked file types, with a reply the sender can read', async () => {
    const verdict = await judge(rawMessage(hookMessage({ name: 'setup.exe', content: 'MZ' })), fake, true)
    assert.equal(verdict.ok, false)
    assert.equal(!verdict.ok && verdict.reason, 'blocked_type')
    const reply = hookResponse(verdict)
    assert.equal(reply.action, 'reject')
    assert.equal(reply.action === 'reject' && reply.response.status, 550)
    assert.match(reply.action === 'reject' ? reply.response.message : '', /setup\.exe/)
  })
  it('refuses a virus inside a base64 attachment', async () => {
    const verdict = await judge(rawMessage(hookMessage({ name: 'notes.txt', content: EICAR })), fake, true)
    assert.deepEqual(verdict, { ok: false, reason: 'virus', virus: 'Eicar-Test-Signature' })
    assert.match(JSON.stringify(hookResponse(verdict)), /virus was found/)
  })
  it('opens attached messages', async () => {
    const inner = Buffer.from(rawMessage(hookMessage({ name: 'run.vbs', content: 'x' }))).toString()
    const outer: NonNullable<HookRequest['message']> = {
      headers: [['Content-Type', ' multipart/mixed; boundary="o1"\r\n']],
      contents: `--o1\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="fwd.eml"\r\n\r\n${inner}\r\n--o1--\r\n`,
    }
    const verdict = await judge(rawMessage(outer), fake, true)
    assert.equal(!verdict.ok && verdict.reason === 'blocked_type' && verdict.file, 'run.vbs')
  })
  it('keeps SMTP replies to one line of ASCII', () => {
    const reply = hookResponse({ ok: false, reason: 'blocked_type', file: 'bad\r\n250 ok "é".exe', detail: 'blocked_type' })
    assert.doesNotMatch(reply.action === 'reject' ? reply.response.message : '\n', /[\r\n]|[^\x20-\x7e]/)
  })
})

describe('server', () => {
  const logs: Record<string, unknown>[] = []
  const start = (enforce: boolean) =>
    new Promise<{ url: string; close: () => void }>((resolve) => {
      const server = scanServer({ clam: clamd('fake'), secret: SECRET, enforce, fake: true, log: (l) => logs.push(l) })
      server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }))
    })
  const auth = { Authorization: `Bearer ${SECRET}` }
  const hook = (url: string, message: HookRequest['message'], headers: Record<string, string> = auth) =>
    fetch(`${url}/hook`, { method: 'POST', headers, body: JSON.stringify({ context: { stage: 'data' }, envelope: { from: { address: 'a@example.com' } }, message }) })

  it('needs the secret', async () => {
    const s = await start(true)
    assert.equal((await hook(s.url, hookMessage(null), {})).status, 401)
    assert.equal((await hook(s.url, hookMessage(null), { Authorization: 'Bearer wrong-secret-0123456789' })).status, 401)
    assert.equal((await fetch(`${s.url}/scan`, { method: 'POST', body: 'x' })).status, 401)
    s.close()
  })
  it('accepts clean mail and refuses bad mail', async () => {
    const s = await start(true)
    assert.deepEqual(await (await hook(s.url, hookMessage(null))).json(), { action: 'accept' })
    const refused = (await (await hook(s.url, hookMessage({ name: 'a.txt', content: EICAR }))).json()) as { action: string }
    assert.equal(refused.action, 'reject')
    assert.equal(logs.at(-1)?.event, 'message-refused')
    s.close()
  })
  it('accepts everything in log-only mode, and logs what it would refuse', async () => {
    const s = await start(false)
    assert.deepEqual(await (await hook(s.url, hookMessage({ name: 'a.exe', content: 'MZ' }))).json(), { action: 'accept' })
    assert.equal(logs.at(-1)?.event, 'message-would-be-refused')
    const file = await fetch(`${s.url}/scan?name=a.txt`, { method: 'POST', headers: auth, body: EICAR })
    assert.deepEqual(await file.json(), { infected: false })
    s.close()
  })
  it('scans files for the API', async () => {
    const s = await start(true)
    const clean = await fetch(`${s.url}/scan?name=a.txt`, { method: 'POST', headers: auth, body: 'hello' })
    assert.deepEqual(await clean.json(), { infected: false })
    const dirty = await fetch(`${s.url}/scan?name=a.txt`, { method: 'POST', headers: auth, body: EICAR })
    assert.deepEqual(await dirty.json(), { infected: true, virus: 'Eicar-Test-Signature' })
    s.close()
  })
  it('reports health', async () => {
    const s = await start(true)
    const res = await fetch(`${s.url}/health`)
    assert.equal(res.status, 200)
    assert.equal(((await res.json()) as { ok: boolean }).ok, true)
    s.close()
  })
  it('answers 500, not "accept", when the scan fails', async () => {
    const server = scanServer({ clam: clamd('127.0.0.1:1'), secret: SECRET, enforce: true, log: () => {} })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    assert.equal((await hook(url, hookMessage(null))).status, 500)
    assert.equal((await fetch(`${url}/health`)).status, 503)
    server.close()
  })
})
