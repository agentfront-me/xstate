// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { hasEicar, ScanUnavailable, scanFile, scanMode, scannerHealth } from './scan.ts'

// The EICAR test file, in two halves so this file isn't flagged itself.
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
const enc = (s: string) => new TextEncoder().encode(s)
const stream = (s: string) => new Blob([s]).stream()

describe('scan modes', () => {
  it('is off unless set', () => {
    assert.equal(scanMode({} as never), 'off')
    assert.equal(scanMode({ SCAN_MODE: 'nonsense' } as never), 'off')
    assert.equal(scanMode({ SCAN_MODE: 'live' } as never), 'live')
  })
  it('off: everything is clean, nothing is called', async () => {
    assert.deepEqual(await scanFile({ SCAN_MODE: 'off' } as never, enc(EICAR), 'a.txt'), { infected: false })
  })
  it('fake: only the EICAR test file is a virus', async () => {
    const env = { SCAN_MODE: 'fake' } as never
    assert.deepEqual(await scanFile(env, enc('hello'), 'a.txt'), { infected: false })
    assert.deepEqual(await scanFile(env, enc(`xx${EICAR}yy`), 'a.txt'), { infected: true, virus: 'Eicar-Test-Signature' })
    assert.equal((await scanFile(env, stream(EICAR), 'a.txt')).infected, true)
    assert.equal(hasEicar(enc(EICAR.slice(1))), false)
  })
})

describe('scanner calls', () => {
  let url = ''
  let seen: { auth?: string; name?: string | null } = {}
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const at = new URL(req.url ?? '/', 'http://x')
      if (at.pathname === '/health') return res.writeHead(200).end(JSON.stringify({ ok: true, clamav: 'ClamAV 1.4.3', ageHours: 5 }))
      seen = { auth: req.headers.authorization, name: at.searchParams.get('name') }
      const infected = Buffer.concat(chunks).includes(EICAR)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(infected ? { infected: true, virus: 'Eicar-Signature' } : { infected: false }))
    })
  })
  before(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  after(() => server.close())
  const env = (mode: string, at = url) => ({ SCAN_MODE: mode, SCAN_URL: at, SCAN_SECRET: 's3cret-s3cret-s3cret' }) as never

  it('live: sends the file with the secret and its name', async () => {
    assert.deepEqual(await scanFile(env('live'), enc('hello'), 'report q3.pdf'), { infected: false })
    assert.deepEqual(seen, { auth: 'Bearer s3cret-s3cret-s3cret', name: 'report q3.pdf' })
    assert.deepEqual(await scanFile(env('live'), stream(EICAR), 'a.txt'), { infected: true, virus: 'Eicar-Signature' })
  })
  it('live: refuses the file when the scanner is unreachable', async () => {
    await assert.rejects(scanFile(env('live', 'http://127.0.0.1:1'), enc('hello'), 'a.txt'), ScanUnavailable)
  })
  it('log: never refuses, even a virus or with the scanner down', async () => {
    assert.deepEqual(await scanFile(env('log'), enc(EICAR), 'a.txt'), { infected: false })
    assert.deepEqual(await scanFile(env('log', 'http://127.0.0.1:1'), enc('hello'), 'a.txt'), { infected: false })
  })
  it('reports health, and nothing when scanning is off', async () => {
    assert.deepEqual(await scannerHealth(env('live')), { ok: true, detail: 'ClamAV 1.4.3, signatures 5 h old' })
    assert.equal((await scannerHealth(env('live', 'http://127.0.0.1:1')))?.ok, false)
    assert.equal(await scannerHealth(env('off')), null)
    assert.equal(await scannerHealth(env('fake')), null)
  })
})
