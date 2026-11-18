// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scanAllows, scanSafety } from './scan-state.ts'

describe('scanSafety and scanAllows', () => {
  it('blocks an infected file for good, naming the virus', () => {
    assert.match(scanSafety('infected', 'Eicar-Test-Signature')!.message!, /Eicar-Test-Signature/)
    assert.equal((scanAllows('infected') as { status: number }).status, 403)
  })

  it('no longer holds back a file left `scanning`', () => {
    assert.equal(scanSafety('scanning', null), null)
    assert.deepEqual(scanAllows('scanning'), { ok: true })
  })

  it('warns about an unscannable file but lets it through', () => {
    assert.equal(scanSafety('unscannable', null)?.level, 'warn')
    assert.deepEqual(scanAllows('unscannable'), { ok: true })
  })

  it('leaves clean files and ones with no state alone', () => {
    assert.equal(scanSafety('clean', null), null)
    assert.equal(scanSafety(null, null), null)
    assert.deepEqual(scanAllows(null), { ok: true })
  })
})
