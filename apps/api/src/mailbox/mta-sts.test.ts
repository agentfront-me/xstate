// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mtaStsPolicy, policyDomain } from './mta-sts.ts'

describe('mtaStsPolicy', () => {
  it('enforces SES receiving for the region as the only MX', () => {
    assert.equal(mtaStsPolicy('us-east-2'), 'version: STSv1\nmode: enforce\nmx: inbound-smtp.us-east-2.amazonaws.com\nmax_age: 604800\n')
  })
})

describe('policyDomain', () => {
  it('takes the domain from an mta-sts host and ignores every other host', () => {
    assert.equal(policyDomain('mta-sts.xstate.com'), 'xstate.com')
    assert.equal(policyDomain('MTA-STS.Example.org'), 'example.org')
    assert.equal(policyDomain('api.xstate.com'), null)
    assert.equal(policyDomain('mta-sts.'), null)
  })
})
