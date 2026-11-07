// Who may do what in Storage. Pure functions over an item's chain (the item and its ancestors), so they can be
// tested without a database. No runtime imports: `pnpm test` runs this file directly under Node.
//
// The rules:
// - Access only adds up going down the tree. A role on a folder applies to everything inside it, and nothing
//   inside can take it away.
// - The owner of an item manages it and everything inside it. At the top of My Files, that's the person whose
//   My Files it is.
// - In the organization space, owners and admins manage everything. Admins get nothing in other people's My Files
//   unless it's shared with them, the same way they can't read people's personal mail.
// - An item gives roles through its own grants (to one member) and its org_access (to every member).

import type { OrgAccess, Space, StorageRole } from '../db/storage'

export type Role = StorageRole | null

const RANK: Record<StorageRole, number> = { viewer: 1, editor: 2, manager: 3 }

export function atLeast(role: Role, need: StorageRole): boolean {
  return !!role && RANK[role] >= RANK[need]
}

export function strongest(a: Role, b: Role): Role {
  if (!a) return b
  if (!b) return a
  return RANK[a] >= RANK[b] ? a : b
}

export type ChainNode = {
  space: Space
  owner_member_id: string | null
  org_access: OrgAccess | null
  grant_role: StorageRole | null
  trashed_at: string | null
}

export type Reader = { memberId: string; admin: boolean }

/** What one item gives the reader by itself, ignoring its ancestors. */
export function ownRole(node: ChainNode, reader: Reader): Role {
  if (node.owner_member_id === reader.memberId) return 'manager'
  return strongest(node.grant_role, node.org_access)
}

/**
 * The reader's role on every item of the chain (item first, then its ancestors up to the top), in the same order.
 * roles[i] is the role on chain[i], counting everything above it.
 */
export function chainRoles(chain: ChainNode[], reader: Reader): Role[] {
  const roles: Role[] = new Array(chain.length).fill(null)
  if (!chain.length) return roles
  const adminHere = reader.admin && chain[0]!.space === 'organization'
  let acc: Role = adminHere ? 'manager' : null
  for (let i = chain.length - 1; i >= 0; i--) {
    acc = strongest(acc, ownRole(chain[i]!, reader))
    roles[i] = acc
  }
  return roles
}

/** The reader's role on chain[0], the item itself. */
export function roleOn(chain: ChainNode[], reader: Reader): Role {
  return chainRoles(chain, reader)[0] ?? null
}

/** A child's role given the role on its folder: the folder's, or more if the child gives more by itself. */
export function childRole(parentRole: Role, child: ChainNode, reader: Reader): Role {
  return strongest(parentRole, ownRole(child, reader))
}

/** How many items from the top of the chain the reader can't see: the breadcrumb starts after them. */
export function hiddenAbove(chain: ChainNode[], reader: Reader): number {
  const roles = chainRoles(chain, reader)
  let hidden = 0
  for (let i = chain.length - 1; i > 0 && !roles[i]; i--) hidden++
  return hidden
}

/** Whether the item or any folder above it is in the trash. */
export function inTrash(chain: Pick<ChainNode, 'trashed_at'>[]): boolean {
  return chain.some((n) => n.trashed_at)
}

// ---------------------------------------------------------------------------------------------------------------
// Search

/** A Vectorize metadata filter: the coarse scope a search query is narrowed to before the permission check. */
export type SearchFilter = { space?: 'personal' | 'organization'; owner?: string; top?: { $in: string[] } }

/** Ids per `$in` list: 40 keep a filter under Vectorize's 2 KB limit. */
export const TOPS_PER_FILTER = 40

/**
 * The filters covering everything the reader may find, one Vectorize query each. `tops` are the top-level items
 * above whatever is shared with the reader (a grant, or org_access set) and the organization-space folders they
 * own; `mailboxIds` are the mailboxes whose mail they can read. Filters only narrow the candidates: every hit is
 * still checked with roleOn before it is returned.
 */
export function searchScopes(
  reader: Reader,
  tops: { id: string; space: Space }[],
  mailboxIds: string[],
): SearchFilter[] {
  const filters: SearchFilter[] = [{ space: 'personal', owner: reader.memberId }]
  // Admins see the whole organization space, so its tops need no listing.
  if (reader.admin) filters.push({ space: 'organization' })
  const ids = new Set<string>()
  for (const top of tops) if (!(reader.admin && top.space === 'organization')) ids.add(top.id)
  for (const id of mailboxIds) ids.add(`mb:${id}`)
  const list = [...ids]
  for (let i = 0; i < list.length; i += TOPS_PER_FILTER) filters.push({ top: { $in: list.slice(i, i + TOPS_PER_FILTER) } })
  return filters
}

/**
 * Whether the reader may take the item out of where it is (move it elsewhere, or trash it): editor on the folder
 * it's in, or manager of the item when it's at the top of its space.
 */
export function canRemove(chain: ChainNode[], reader: Reader): boolean {
  const roles = chainRoles(chain, reader)
  return chain.length > 1 ? atLeast(roles[1]!, 'editor') : atLeast(roles[0]!, 'manager')
}
