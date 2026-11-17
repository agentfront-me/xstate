// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseDifferences } from './compare.ts'

const base = { subject: 'Invoice 314', from: [{ name: 'HireNinja', email: 'mailer@waveapps.com' }], to: [{ name: null, email: 'asif@example.test' }], text: 'Hello\n\nthere' }

describe('parseDifferences', () => {
  it('finds none when only whitespace, address case, names or order differ', () => {
    const theirs = { subject: ' Invoice  314 ', from: [{ name: null, email: 'Mailer@WaveApps.com' }], to: base.to, text: 'Hello there\n' }
    assert.deepEqual(parseDifferences(base, theirs), [])
  })

  it('names each field that differs', () => {
    const theirs = { subject: 'Invoice 315', from: [{ name: null, email: 'other@waveapps.com' }], to: [], text: 'Goodbye' }
    assert.deepEqual(parseDifferences(base, theirs), ['subject', 'from', 'to', 'text'])
  })

  it('compares only the start of long text', () => {
    const long = 'word '.repeat(1000)
    assert.deepEqual(parseDifferences({ ...base, text: `${long} ours` }, { ...base, text: `${long} theirs` }), [])
  })
})
