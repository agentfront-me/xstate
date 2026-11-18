// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scanAllows, scanSafety, scanState } from './scan-state.ts'

const virus = { infected: true as const, virus: 'Eicar-Test-Signature' }
const clean = { infected: false as const }
const down = { unavailable: true as const }

describe('scanState', () => {
  it('enforces in live and fake', () => {
    assert.equal(scanState('live', virus, false), 'infected')
    assert.equal(scanState('fake', virus, false), 'infected')
    assert.equal(scanState('live', clean, false), 'clean')
  })

  it('holds nothing back in log or off', () => {
    assert.equal(scanState('log', virus, false), 'clean')
    assert.equal(scanState('log', down, false), 'clean')
    assert.equal(scanState('off', down, false), 'clean')
  })

  it('retries an unreachable scanner, then gives up as unscannable', () => {
    assert.equal(scanState('live', down, false), 'retry')
    assert.equal(scanState('live', down, true), 'unscannable')
  })
})

describe('scanSafety and scanAllows', () => {
  it('blocks while scanning, and refuses the download with 409', () => {
    assert.equal(scanSafety('scanning', null)?.level, 'blocked')
    assert.deepEqual(scanAllows('scanning'), { ok: false, status: 409, code: 'attachment_scanning', message: 'This attachment is still being checked for viruses. Try again in a moment.' })
  })

  it('blocks an infected file for good, naming the virus', () => {
    assert.match(scanSafety('infected', 'Eicar-Test-Signature')!.message!, /Eicar-Test-Signature/)
    assert.equal((scanAllows('infected') as { status: number }).status, 403)
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
