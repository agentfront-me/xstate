// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { roleFor, sharingFor, skipReason } from './drive-rules.ts'

const ctx = {
  memberByEmail: new Map([
    ['priya@acme.test', 'm-priya'],
    ['sofia@acme.test', 'm-sofia'],
    ['jordan@acme.test', 'm-jordan'],
  ]),
  groupMembers: new Map([['support@acme.test', ['priya@acme.test', 'jordan@acme.test', 'gone@acme.test']]]),
  domains: new Set(['acme.test', 'acme-mail.test']),
  ownerMemberId: 'm-sofia',
}
const user = (email: string, role: string) => ({ type: 'user' as const, role, email, domain: null })

describe('roleFor', () => {
  it('maps Google roles', () => {
    assert.equal(roleFor('organizer'), 'manager')
    assert.equal(roleFor('fileOrganizer'), 'manager')
    assert.equal(roleFor('writer'), 'editor')
    assert.equal(roleFor('commenter'), 'viewer')
    assert.equal(roleFor('reader'), 'viewer')
    assert.equal(roleFor('something'), null)
  })
})

describe('sharingFor', () => {
  it('grants members, skipping the owner, and keeps the highest role', () => {
    const s = sharingFor([user('sofia@acme.test', 'owner'), user('priya@acme.test', 'reader'), user('priya@acme.test', 'writer')], ctx)
    assert.deepEqual(s, { grants: [{ memberId: 'm-priya', role: 'editor' }], orgAccess: null, notRecreated: [] })
  })

  it('expands groups to their migrated members', () => {
    const s = sharingFor([{ type: 'group', role: 'reader', email: 'support@acme.test', domain: null }], ctx)
    assert.deepEqual(s.grants, [{ memberId: 'm-priya', role: 'viewer' }, { memberId: 'm-jordan', role: 'viewer' }])
    assert.deepEqual(s.notRecreated, [])
  })

  it('turns domain sharing into organization access, never more than edit', () => {
    assert.equal(sharingFor([{ type: 'domain', role: 'reader', email: null, domain: 'acme.test' }], ctx).orgAccess, 'viewer')
    assert.equal(sharingFor([{ type: 'domain', role: 'organizer', email: null, domain: 'acme-mail.test' }], ctx).orgAccess, 'editor')
  })

  it('reports links, outsiders, other domains and unknown groups instead of recreating them', () => {
    const s = sharingFor(
      [
        { type: 'anyone', role: 'reader', email: null, domain: null },
        user('someone@outside.example', 'writer'),
        { type: 'domain', role: 'reader', email: null, domain: 'partner.example' },
        { type: 'group', role: 'reader', email: 'list@acme.test', domain: null },
      ],
      ctx,
    )
    assert.deepEqual(s.grants, [])
    assert.deepEqual(s.notRecreated, ['Anyone with the link', 'someone@outside.example', 'Everyone at partner.example', 'Group list@acme.test'])
  })
})

describe('skipReason', () => {
  it('copies ordinary and exportable files, and names what it skips', () => {
    assert.equal(skipReason('application/pdf', false), null)
    assert.equal(skipReason('application/vnd.google-apps.document', true), null)
    assert.equal(skipReason('application/vnd.google-apps.form', false), 'google_form')
    assert.equal(skipReason('application/vnd.google-apps.shortcut', false), 'shortcut')
    assert.equal(skipReason('application/vnd.google-apps.jam', false), 'google_jam')
  })
})
