import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it, mock } from 'node:test'
import { fetchWithin, MailServerTimeout } from './timeout.ts'

// A stand-in mail server: /ok answers at once, /hang never answers, /slow-body sends headers and then stalls.
const open = new Set<ServerResponse>()
const server = createServer((req, res) => {
  open.add(res)
  res.on('close', () => open.delete(res))
  if (req.url === '/ok') return res.end('{"ok":true}')
  if (req.url === '/slow-body') return res.writeHead(200, { 'Content-Type': 'application/json' }) && res.write('{')
  // /hang: never answer
})
let base = ''

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
after(() => {
  for (const res of open) res.destroy()
  server.close()
})

describe('fetchWithin', () => {
  it('returns what read gives back when the server answers in time', async () => {
    const body = await fetchWithin(`${base}/ok`, {}, { what: 'test', ms: 2000 }, (res) => res.json())
    assert.deepEqual(body, { ok: true })
  })

  it('gives up on a server that never answers, and logs which call it was', async () => {
    const log = mock.method(console, 'error', () => {})
    const started = Date.now()
    await assert.rejects(fetchWithin(`${base}/hang?secret=x`, {}, { what: 'jmap Email/get', ms: 200 }), (err) => {
      assert.ok(err instanceof MailServerTimeout)
      assert.equal(err.what, 'jmap Email/get')
      return true
    })
    assert.ok(Date.now() - started < 2000)
    const [label, details] = log.mock.calls[0]!.arguments as [string, string]
    assert.equal(label, 'stalwart: timed out')
    assert.deepEqual({ ...JSON.parse(details), waitedMs: 0 }, { what: 'jmap Email/get', path: '/hang', limitMs: 200, waitedMs: 0 })
    log.mock.restore()
  })

  it('counts reading the body against the limit', async () => {
    const log = mock.method(console, 'error', () => {})
    await assert.rejects(
      fetchWithin(`${base}/slow-body`, {}, { what: 'session', ms: 200 }, (res) => res.json()),
      (err) => err instanceof MailServerTimeout,
    )
    log.mock.restore()
  })

  it('with untilHeaders, stops the clock once the headers arrive', async () => {
    const res = await fetchWithin(`${base}/slow-body`, {}, { what: 'download', ms: 200, untilHeaders: true })
    assert.equal(res.status, 200)
    await new Promise((r) => setTimeout(r, 400)) // past the limit: the body must not be cut off
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    assert.equal(new TextDecoder().decode(value), '{')
    await reader.cancel()
  })

  it('passes errors from read through untouched', async () => {
    const refused = new Error('HTTP 500')
    await assert.rejects(fetchWithin(`${base}/ok`, {}, { what: 'test', ms: 2000 }, async () => { throw refused }), (err) => err === refused)
  })

  it('logs and rethrows when the server can\'t be reached at all', async () => {
    const log = mock.method(console, 'error', () => {})
    await assert.rejects(fetchWithin('http://127.0.0.1:1/jmap/', {}, { what: 'jmap', ms: 2000 }), (err) => !(err instanceof MailServerTimeout))
    assert.equal((log.mock.calls[0]!.arguments as string[])[0], 'stalwart: request failed')
    log.mock.restore()
  })
})
