// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { onlySesMx, readiness, type MailboxFacts } from './switch-rules.ts'

describe('onlySesMx', () => {
  it('needs every MX host to be SES, and at least one', () => {
    assert.equal(onlySesMx(['inbound-smtp.us-east-2.amazonaws.com'], 'us-east-2'), true)
    assert.equal(onlySesMx(['inbound-smtp.us-east-2.amazonaws.com.'], 'us-east-2'), true)
    assert.equal(onlySesMx(['inbound-smtp.us-east-2.amazonaws.com', 'mx.xstate.io'], 'us-east-2'), false)
    assert.equal(onlySesMx(['mx.xstate.io'], 'us-east-2'), false)
    assert.equal(onlySesMx([], 'us-east-2'), false)
    assert.equal(onlySesMx(['inbound-smtp.us-east-1.amazonaws.com'], 'us-east-2'), false)
  })
})

describe('readiness', () => {
  const ready: MailboxFacts = {
    address: 'asif@xstate.com',
    backend: 'stalwart',
    storeMode: 'read',
    storeRaw: true,
    countsMatch: true,
    rawMissing: 0,
    threadingLeft: 0,
    otherDomainAddresses: [],
  }

  it('is ready when SES is verified and every mailbox is fully copied', () => {
    assert.equal(readiness({ sending: 'verified' }, [ready]).ready, true)
  })

  it('names what is missing', () => {
    const r = readiness({ sending: 'pending' }, [
      { ...ready, address: 'hello@xstate.com', storeMode: 'off', storeRaw: false, countsMatch: null, rawMissing: null, threadingLeft: null },
      { ...ready, threadingLeft: 120, otherDomainAddresses: ['asif@xstate.io'] },
    ])
    assert.equal(r.ready, false)
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.check}: ${c.detail}`)
    assert.deepEqual(failed, [
      'ses: Amazon SES: pending',
      'hello@xstate.com: copy: store_mode is off; it must be read',
      'hello@xstate.com: counts: not checked',
      'hello@xstate.com: raw copies: raw copy is off',
      'hello@xstate.com: threading headers: not checked',
      'asif@xstate.com: threading headers: 120 left',
      'asif@xstate.com: other domains: also has asif@xstate.io',
    ])
  })

  it('counts mailboxes already on the store as done, and a domain without mailboxes as not ready', () => {
    assert.equal(readiness({ sending: 'verified' }, [{ ...ready, backend: 'store', storeMode: 'off' }]).ready, true)
    assert.equal(readiness({ sending: 'verified' }, []).ready, false)
  })
})
