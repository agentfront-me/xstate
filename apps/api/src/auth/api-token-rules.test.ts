// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { expiryDate, hashToken, isToken, maskToken, newToken, tokenState } from './api-token-rules.ts'

describe('tokens', () => {
  it('makes tokens that pass their own check and differ each time', () => {
    const a = newToken()
    const b = newToken()
    assert.ok(isToken(a))
    assert.ok(isToken(b))
    assert.notEqual(a, b)
    assert.equal(a.length, 'xst_live_'.length + 40)
  })

  it('refuses anything that is not a token', () => {
    for (const value of ['', 'xst_live_short', 'sk_live_' + 'a'.repeat(40), 'xst_live_' + 'a'.repeat(41), 'xst_live_' + '-'.repeat(40)]) {
      assert.equal(isToken(value), false, value)
    }
  })

  it('hashes to hex SHA-256, the same every time', async () => {
    const hash = await hashToken('xst_live_' + 'a'.repeat(40))
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.equal(hash, await hashToken('xst_live_' + 'a'.repeat(40)))
    assert.notEqual(hash, await hashToken('xst_live_' + 'b'.repeat(40)))
  })

  it('shows only the last 4 characters', () => {
    assert.equal(maskToken('CWTF'), 'xst_live_…CWTF')
  })
})

describe('expiryDate', () => {
  const now = new Date('2026-11-16T00:00:00.000Z')
  it('adds the chosen time', () => {
    assert.equal(expiryDate('30d', now), '2026-12-16T00:00:00.000Z')
    assert.equal(expiryDate('90d', now), '2027-02-14T00:00:00.000Z')
    assert.equal(expiryDate('1y', now), '2027-11-16T00:00:00.000Z')
  })
  it('is null for no expiry', () => {
    assert.equal(expiryDate('never', now), null)
  })
})

describe('tokenState', () => {
  const now = new Date('2026-11-16T00:00:00.000Z')
  const live = { revoked_at: null, expires_at: null }
  it('is active with a usable mailbox and inactive without one', () => {
    assert.equal(tokenState(live, 2, now), 'active')
    assert.equal(tokenState(live, 0, now), 'inactive')
  })
  it('is expired from the moment it ends', () => {
    assert.equal(tokenState({ ...live, expires_at: '2026-11-16T00:00:00.000Z' }, 1, now), 'expired')
    assert.equal(tokenState({ ...live, expires_at: '2026-11-16T00:00:00.001Z' }, 1, now), 'active')
  })
  it('is revoked whatever else is true', () => {
    assert.equal(tokenState({ revoked_at: '2026-11-01T00:00:00.000Z', expires_at: '2026-11-02T00:00:00.000Z' }, 1, now), 'revoked')
  })
})
