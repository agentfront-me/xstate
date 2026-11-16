// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_CHOICES, scopesFor } from './scopes.ts'

describe('scopesFor', () => {
  it('gives the default connection: read everything, write only drafts', () => {
    assert.deepEqual(scopesFor(DEFAULT_CHOICES), ['mail.read', 'mail.draft', 'calendar.read', 'storage.read', 'contacts.read'])
  })
  it('never lets an app send unless sending was chosen', () => {
    assert.equal(scopesFor({ ...DEFAULT_CHOICES, email: 'read' }).some((s) => s === 'mail.draft' || s === 'mail.send'), false)
    assert.equal(scopesFor({ ...DEFAULT_CHOICES, email: 'draft' }).includes('mail.send'), false)
    assert.deepEqual(scopesFor({ ...DEFAULT_CHOICES, email: 'send' }).slice(0, 3), ['mail.read', 'mail.draft', 'mail.send'])
  })
  it('spells out read with write, and leaves an area out when it is off', () => {
    const scopes = scopesFor({ email: 'read', calendar: 'write', storage: 'off', contacts: 'read', setup: false })
    assert.deepEqual(scopes, ['mail.read', 'calendar.read', 'calendar.write', 'contacts.read'])
  })
  it('adds setup only when asked', () => {
    assert.equal(scopesFor(DEFAULT_CHOICES).includes('setup'), false)
    assert.equal(scopesFor({ ...DEFAULT_CHOICES, setup: true }).includes('setup'), true)
  })
})
