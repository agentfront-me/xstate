// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { checkRecords, storeRecords, zoneFile } from './dns.ts'

describe('checkRecords: SPF', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const published = (txt: string) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ Status: 0, Answer: [{ type: 16, data: `"${txt}"` }] }))) as typeof fetch
  }
  const spf = { type: 'TXT' as const, name: '@', value: 'v=spf1 mx -all', purpose: 'SPF' as const, required: true }
  const found = async () => (await checkRecords([spf], 'example.com'))[0]!.found

  it('accepts our record as is', async () => {
    published('v=spf1 mx -all')
    assert.equal(await found(), true)
  })

  it("accepts a record merged with the owner's other senders (Domain Connect SPFM)", async () => {
    published('v=spf1 mx include:_spf.google.com ~all')
    assert.equal(await found(), true)
  })

  it('rejects a record without mx', async () => {
    published('v=spf1 include:_spf.google.com ~all')
    assert.equal(await found(), false)
  })
})

describe('storeRecords (a domain on the mailbox store)', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })
  const dkim = [{ type: 'CNAME' as const, name: 'abc._domainkey', value: 'abc.dkim.amazonses.com', purpose: 'DKIM' as const, required: true }]

  it("points mail at SES and leaves Stalwart's records out", () => {
    const records = storeRecords('us-east-2', dkim)
    assert.deepEqual(
      records.map((r) => [r.purpose, r.type, r.name, r.value, r.required]),
      [
        ['Mail', 'MX', '@', '10 inbound-smtp.us-east-2.amazonaws.com', true],
        ['SPF', 'TXT', '@', 'v=spf1 include:amazonses.com -all', true],
        ['DKIM', 'CNAME', 'abc._domainkey', 'abc.dkim.amazonses.com', true],
        ['DMARC', 'TXT', '_dmarc', 'v=DMARC1; p=reject', false],
      ],
    )
    assert.equal(
      zoneFile('99events.com', records),
      [
        '99events.com. IN MX 10 inbound-smtp.us-east-2.amazonaws.com.',
        '99events.com. IN TXT "v=spf1 include:amazonses.com -all"',
        'abc._domainkey.99events.com. IN CNAME abc.dkim.amazonses.com.',
        '_dmarc.99events.com. IN TXT "v=DMARC1; p=reject"',
      ].join('\n'),
    )
  })

  it("finds the pilot's published records (SES MX, SPF with ~all, DMARC p=none)", async () => {
    const answers: Record<string, { type: number; data: string }[]> = {
      '99events.com|MX': [{ type: 15, data: '10 inbound-smtp.us-east-2.amazonaws.com.' }],
      '99events.com|TXT': [{ type: 16, data: '"v=spf1 include:amazonses.com ~all"' }],
      'abc._domainkey.99events.com|CNAME': [{ type: 5, data: 'abc.dkim.amazonses.com.' }],
      '_dmarc.99events.com|TXT': [{ type: 16, data: '"v=DMARC1; p=none"' }],
    }
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url)
      return new Response(JSON.stringify({ Status: 0, Answer: answers[`${u.searchParams.get('name')}|${u.searchParams.get('type')}`] ?? [] }))
    }) as typeof fetch
    const found = await checkRecords(storeRecords('us-east-2', dkim), '99events.com')
    assert.deepEqual(found.map((r) => [r.purpose, r.found]), [['Mail', true], ['SPF', true], ['DKIM', true], ['DMARC', true]])
  })

  it("doesn't take Stalwart's MX for a store domain", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 15, data: '10 mx.xstate.io.' }] }))) as typeof fetch
    const [mx] = await checkRecords(storeRecords('us-east-2', []).slice(0, 1), '99events.com')
    assert.equal(mx!.found, false)
  })
})
