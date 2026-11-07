// pnpm --filter @xstate/api test
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canRemove, chainRoles, childRole, hiddenAbove, inTrash, roleOn, searchScopes, TOPS_PER_FILTER, type ChainNode } from './roles.ts'

const node = (patch: Partial<ChainNode> = {}): ChainNode => ({
  space: 'organization',
  owner_member_id: 'someone',
  org_access: null,
  grant_role: null,
  trashed_at: null,
  ...patch,
})
const me = { memberId: 'me', admin: false }
const admin = { memberId: 'me', admin: true }

describe('roleOn', () => {
  it('gives nothing without an owner, grant or org access', () => {
    assert.equal(roleOn([node(), node()], me), null)
  })

  it('makes the owner of a folder manager of everything inside it', () => {
    assert.equal(roleOn([node(), node(), node({ owner_member_id: 'me' })], me), 'manager')
  })

  it('passes a grant on a folder down to what is inside', () => {
    assert.equal(roleOn([node(), node({ grant_role: 'editor' })], me), 'editor')
  })

  it('never lets an item give less than its folder', () => {
    assert.equal(roleOn([node({ grant_role: 'viewer' }), node({ org_access: 'editor' })], me), 'editor')
  })

  it('lets an item give more than its folder', () => {
    assert.equal(roleOn([node({ grant_role: 'manager' }), node({ org_access: 'viewer' })], me), 'manager')
  })

  it('makes admins managers in the organization space', () => {
    assert.equal(roleOn([node(), node()], admin), 'manager')
  })

  it("gives admins nothing in someone's My Files", () => {
    const personal = { space: 'personal' as const }
    assert.equal(roleOn([node(personal), node(personal)], admin), null)
  })

  it("follows sharing in someone's My Files", () => {
    const personal = { space: 'personal' as const }
    assert.equal(roleOn([node(personal), node({ ...personal, org_access: 'viewer' })], me), 'viewer')
  })
})

describe('chainRoles and hiddenAbove', () => {
  it('hides the folders above a directly shared item', () => {
    const chain = [node(), node({ grant_role: 'viewer' }), node(), node()]
    assert.deepEqual(chainRoles(chain, me), ['viewer', 'viewer', null, null])
    assert.equal(hiddenAbove(chain, me), 2)
  })

  it('hides nothing when the top is visible', () => {
    assert.equal(hiddenAbove([node(), node({ org_access: 'viewer' })], me), 0)
  })
})

describe('childRole', () => {
  it('adds what the child gives', () => {
    assert.equal(childRole('viewer', node({ owner_member_id: 'me' }), me), 'manager')
    assert.equal(childRole('editor', node({ grant_role: 'viewer' }), me), 'editor')
  })
})

describe('canRemove', () => {
  it('needs editor on the folder the item is in', () => {
    assert.equal(canRemove([node({ grant_role: 'manager' }), node({ grant_role: 'viewer' })], me), false)
    assert.equal(canRemove([node(), node({ grant_role: 'editor' })], me), true)
  })

  it('needs manager for an item at the top', () => {
    assert.equal(canRemove([node({ org_access: 'editor' })], me), false)
    assert.equal(canRemove([node({ owner_member_id: 'me' })], me), true)
  })
})

describe('inTrash', () => {
  it('counts trashed folders above', () => {
    assert.equal(inTrash([node(), node({ trashed_at: '2026-11-01T00:00:00Z' })]), true)
    assert.equal(inTrash([node(), node()]), false)
  })
})

describe('searchScopes', () => {
  const tops = [
    { id: 'team', space: 'organization' as const },
    { id: 'shared-personal', space: 'personal' as const },
  ]

  it('always searches My Files, and lists the shared tops and mailboxes for a member', () => {
    assert.deepEqual(searchScopes(me, tops, ['mb1']), [
      { space: 'personal', owner: 'me' },
      { top: { $in: ['team', 'shared-personal', 'mb:mb1'] } },
    ])
  })

  it('gives an admin the whole organization space instead of its tops', () => {
    assert.deepEqual(searchScopes(admin, tops, []), [
      { space: 'personal', owner: 'me' },
      { space: 'organization' },
      { top: { $in: ['shared-personal'] } },
    ])
  })

  it('splits long lists so each filter stays small', () => {
    const many = Array.from({ length: 85 }, (_, i) => ({ id: `t${i}`, space: 'organization' as const }))
    const filters = searchScopes(me, many, [])
    assert.equal(filters.length, 4)
    assert.equal(filters[1]!.top!.$in.length, TOPS_PER_FILTER)
    assert.equal(filters[3]!.top!.$in.length, 5)
  })

  it('lists a top once however many items under it are shared', () => {
    const filters = searchScopes(me, [tops[0]!, tops[0]!], [])
    assert.deepEqual(filters[1], { top: { $in: ['team'] } })
  })
})
