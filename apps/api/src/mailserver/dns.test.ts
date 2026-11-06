// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { checkRecords } from './dns.ts'

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
