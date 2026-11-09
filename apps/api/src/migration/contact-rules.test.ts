// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { contactAttributes } from './contact-rules.ts'

const base = { id: 'people/c1', name: 'Dana', emails: ['dana@a.com'], phones: [], company: null, title: null, addresses: [], birthday: null, notes: null, photoUrl: null, labels: [] }
const groups = new Map([['contactGroups/clients', 'Clients'], ['contactGroups/family', 'Family']])

describe('contactAttributes', () => {
  it('keeps only what is set, with the Google id', () => {
    assert.deepEqual(contactAttributes(base, groups, false), { googleId: 'people/c1' })
  })

  it('puts extra emails and phones, labels by name, and the rest in attributes', () => {
    const c = {
      ...base,
      emails: ['dana@a.com', 'dana@b.com', 'd@c.com'],
      phones: ['+1 1', '+1 2'],
      company: 'Acme',
      title: 'Buyer',
      addresses: ['1 Main St'],
      birthday: '04-12',
      notes: 'Met at the fair',
      labels: ['contactGroups/clients', 'contactGroups/myContacts', 'contactGroups/family'],
    }
    assert.deepEqual(contactAttributes(c, groups, false), {
      googleId: 'people/c1',
      emails: 'dana@b.com, d@c.com',
      phones: '+1 2',
      company: 'Acme',
      title: 'Buyer',
      address: '1 Main St',
      birthday: '04-12',
      notes: 'Met at the fair',
      labels: 'Clients, Family',
    })
  })

  it('marks Other contacts and clips long values', () => {
    const a = contactAttributes({ ...base, notes: 'x'.repeat(900) }, groups, true)
    assert.equal(a.other, true)
    assert.equal(String(a.notes).length, 500)
  })
})
