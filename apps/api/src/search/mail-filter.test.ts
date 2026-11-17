// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hasMailFilter, matchesMail } from './mail-filter.ts'

describe('matchesMail', () => {
  it('matches part of the sender, any case', () => {
    assert.ok(matchesMail({ from: 'WaveApps.com' }, 'mailer@waveapps.com', null))
    assert.ok(!matchesMail({ from: 'paddle.com' }, 'mailer@waveapps.com', null))
  })

  it('fails a sender filter when the sender is unknown', () => {
    assert.ok(!matchesMail({ from: 'waveapps' }, undefined, '2023-01-01T00:00:00Z'))
  })

  it('takes after as inclusive and before as exclusive', () => {
    const f = { after: '2023-01-01T00:00:00Z', before: '2024-01-01T00:00:00Z' }
    assert.ok(matchesMail(f, null, '2023-01-01T00:00:00Z'))
    assert.ok(matchesMail(f, null, '2023-12-31T23:59:59Z'))
    assert.ok(!matchesMail(f, null, '2024-01-01T00:00:00Z'))
    assert.ok(!matchesMail(f, null, '2022-12-31T23:59:59Z'))
    assert.ok(!matchesMail(f, null, undefined))
  })

  it('passes everything with no filter set', () => {
    assert.ok(matchesMail({}, undefined, undefined))
    assert.ok(!hasMailFilter({}))
    assert.ok(!hasMailFilter(undefined))
    assert.ok(hasMailFilter({ from: 'x' }))
  })
})
