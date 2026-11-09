// How Google Drive sharing becomes Storage access, and which Drive items can't be copied. Pure (drive-rules.test.ts).
// See the Workspace Migration Plan, "Drive to Storage".

import type { GPermission } from './google/workspace'

export type Role = 'viewer' | 'editor' | 'manager'

/** Google's role → Storage's. Owners and organizers manage, writers edit, commenters and readers view. */
export function roleFor(googleRole: string): Role | null {
  if (googleRole === 'owner' || googleRole === 'organizer' || googleRole === 'fileOrganizer') return 'manager'
  if (googleRole === 'writer') return 'editor'
  if (googleRole === 'commenter' || googleRole === 'reader') return 'viewer'
  return null
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, manager: 3 }
const higher = (a: Role | undefined, b: Role) => (!a || RANK[b] > RANK[a] ? b : a)

export type SharingContext = {
  /** Member id by email: migrated people and anyone already in the organization. */
  memberByEmail: Map<string, string>
  /** Group email → its members' emails (from discovery). */
  groupMembers: Map<string, string[]>
  /** The Workspace's domains: sharing with one of them is sharing with the whole organization. */
  domains: Set<string>
  /** The item's owner in xstate, who needs no grant. */
  ownerMemberId: string | null
}

export type Sharing = {
  grants: { memberId: string; role: Role }[]
  /** What everyone in the organization gets, from domain-wide sharing. */
  orgAccess: 'viewer' | 'editor' | null
  /** Sharing that isn't recreated, for the report: links for anyone, and people outside the organization. */
  notRecreated: string[]
}

export function sharingFor(permissions: GPermission[], ctx: SharingContext): Sharing {
  const best = new Map<string, Role>()
  let org: Role | undefined
  const notRecreated: string[] = []
  const give = (email: string, role: Role) => {
    const memberId = ctx.memberByEmail.get(email)
    if (!memberId) return false
    if (memberId !== ctx.ownerMemberId) best.set(memberId, higher(best.get(memberId), role))
    return true
  }
  for (const p of permissions) {
    const role = roleFor(p.role)
    if (!role) continue
    if (p.type === 'anyone') notRecreated.push('Anyone with the link')
    else if (p.type === 'domain') {
      if (p.domain && ctx.domains.has(p.domain)) org = higher(org, role === 'manager' ? 'editor' : role)
      else notRecreated.push(`Everyone at ${p.domain ?? 'another domain'}`)
    } else if (p.type === 'group' && p.email) {
      const members = ctx.groupMembers.get(p.email)
      if (members) for (const m of members) give(m, role)
      else notRecreated.push(`Group ${p.email}`)
    } else if (p.type === 'user' && p.email) {
      if (!give(p.email, role)) notRecreated.push(p.email)
    }
  }
  return {
    grants: [...best].map(([memberId, role]) => ({ memberId, role })),
    orgAccess: org === 'manager' ? 'editor' : (org ?? null),
    notRecreated,
  }
}

const GOOGLE_APPS = 'application/vnd.google-apps.'

/** Why an item can't be copied, or null if it can. */
export function skipReason(mimeType: string, exportable: boolean): string | null {
  if (!mimeType.startsWith(GOOGLE_APPS) || exportable) return null
  const kind = mimeType.slice(GOOGLE_APPS.length)
  if (kind === 'shortcut') return 'shortcut'
  if (kind === 'form') return 'google_form'
  if (kind === 'site') return 'google_site'
  if (kind === 'map') return 'google_map'
  return `google_${kind}`
}
