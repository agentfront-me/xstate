// What the dashboard (and agents over MCP) can do with an organization's audience and API keys. Checks access here,
// then calls the organization's AudienceStore.
//
// Any member can see the audience, except other members' contacts. Changing website people, segments and shared
// contacts needs the "audience.manage" permission (owners and admins have it); a member's own contacts are theirs to
// change. API keys are for owners and admins only: the secret key acts for the whole organization.

import { messagesWith } from '../mailserver'
import { isAdmin, loadMember, requireOrgPermission } from '../mailserver/access'
import type { Actor } from '../auth/types'
import { ApiError } from '../errors'
import * as keys from './keys'
import { organizationBucket } from '../storage/buckets'
import { getObject } from '../storage/r2'
import type { ListQuery, Viewer } from './store'
import type { Filter, Person, PersonDetail, PersonFields, SegmentIcon } from './types'

const store = (env: Env, organizationId: string) => env.AUDIENCE.get(env.AUDIENCE.idFromName(organizationId))

/** The organization's store and who's looking, for any member. */
async function reader(env: Env, actor: Actor, organizationId: string): Promise<{ s: ReturnType<typeof store>; viewer: Viewer }> {
  const member = await loadMember(env, organizationId, actor.userId)
  const manage = isAdmin(member) || member.permissions.org.includes('audience.manage')
  return { s: store(env, organizationId), viewer: { memberId: member.id, manage } }
}

async function manager(env: Env, actor: Actor, organizationId: string) {
  requireOrgPermission(await loadMember(env, organizationId, actor.userId), 'audience.manage')
  return store(env, organizationId)
}

async function admin(env: Env, actor: Actor, organizationId: string) {
  if (!isAdmin(await loadMember(env, organizationId, actor.userId))) {
    throw new ApiError('forbidden', 'Only owners and admins can see API keys', 403)
  }
}

const notFound = (what: string) => new ApiError('not_found', `No such ${what}`, 404)

// People

export async function overview(env: Env, actor: Actor, organizationId: string) {
  const { s, viewer } = await reader(env, actor, organizationId)
  return s.overview(viewer)
}

export async function schema(env: Env, actor: Actor, organizationId: string) {
  return (await reader(env, actor, organizationId)).s.schema()
}

export async function listPeople(env: Env, actor: Actor, organizationId: string, query: Omit<ListQuery, 'viewer'>) {
  const { s, viewer } = await reader(env, actor, organizationId)
  const result = await s.listPeople({ ...query, viewer })
  if (!result) throw notFound('segment')
  return result
}

/** A person's profile, segments and events, plus the mail exchanged with their email address in the mailboxes the
 * viewer can read. If the mail server can't be reached the profile still loads, with `emails: null`. */
export async function getPerson(env: Env, actor: Actor, organizationId: string, personId: string) {
  // Event properties are free-form JSON, which the RPC stub's types can't express; the shape is store.getPerson's.
  const { s, viewer } = await reader(env, actor, organizationId)
  const result = (await s.getPerson(personId, viewer)) as PersonDetail | null
  if (!result) throw notFound('person')
  const email = result.person.email
  const emails = email
    ? await messagesWith(env, actor, organizationId, email, 30).catch((err: unknown) => {
        console.error('audience person emails failed', err)
        return null
      })
    : []
  return { ...result, emails }
}

/**
 * Adds a lead to a website (needs audience.manage), or a contact: your own by default, or shared with the whole
 * organization (`shared`, needs audience.manage). Contacts have no website domain.
 */
export async function addPerson(
  env: Env,
  actor: Actor,
  organizationId: string,
  input: { kind?: 'lead' | 'contact'; domain?: string; shared?: boolean } & PersonFields,
) {
  const { s, viewer } = await reader(env, actor, organizationId)
  const kind = input.kind ?? 'lead'
  if ((kind === 'lead' || input.shared) && !viewer.manage) throw new ApiError('forbidden', 'Missing permission audience.manage', 403)
  const domain = (input.domain ?? '').toLowerCase().replace(/^www\./, '')
  if (kind === 'lead' && !domain) throw new ApiError('invalid_input', 'Enter the website domain this person belongs to')
  const { kind: _k, shared: _s, ...fields } = input
  const result = await s.addPerson({ ...fields, kind, domain, source: 'Added manually', ownerMemberId: kind === 'contact' && !input.shared ? viewer.memberId : null })
  if (result.conflict) throw new ApiError('conflict', result.conflict, 409)
  return result.person!
}

export async function updatePerson(env: Env, actor: Actor, organizationId: string, personId: string, fields: PersonFields) {
  const { s, viewer } = await reader(env, actor, organizationId)
  const result = await s.updatePerson(personId, fields, viewer)
  if (!result) throw notFound('person')
  if (result.forbidden) throw new ApiError('forbidden', 'Missing permission audience.manage', 403)
  if (result.conflict) throw new ApiError('conflict', result.conflict, 409)
  return result.person!
}

/** Deletes the people the actor may change (others in the list are left alone). */
export async function deletePeople(env: Env, actor: Actor, organizationId: string, ids: string[]) {
  const { s, viewer } = await reader(env, actor, organizationId)
  return { deleted: await s.deletePeople(ids, viewer) }
}

/** A contact's photo (imported from Google), served through the API so only people who can see the contact get it. */
export async function personPhoto(env: Env, actor: Actor, organizationId: string, personId: string): Promise<Response> {
  const { s, viewer } = await reader(env, actor, organizationId)
  const result = (await s.getPerson(personId, viewer)) as PersonDetail | null
  const key = result?.person.attributes.photoKey
  // Only a key the import wrote for this contact's owner: never any other object in the bucket.
  if (typeof key !== 'string' || !key.startsWith(`contacts/${result?.person.owner ?? 'shared'}/`)) throw notFound('photo')
  const object = await getObject(env, await organizationBucket(env, organizationId), key)
  if (!object?.body) throw notFound('photo')
  return new Response(object.body, {
    headers: { 'Content-Type': object.headers.get('Content-Type') ?? 'image/jpeg', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
  })
}

/** Contacts for the compose window's To, Cc and Bcc: yours and shared ones, real contacts before "Other contacts". */
export async function suggestContacts(env: Env, actor: Actor, organizationId: string, q: string) {
  const { s, viewer } = await reader(env, actor, organizationId)
  return { contacts: await s.suggest(viewer, q, 8) }
}

/** For imports (no access check: the caller has done it). Adds or merges contacts owned by one member. */
export function importContacts(env: Env, organizationId: string, ownerMemberId: string, contacts: Parameters<ReturnType<typeof store>['importContacts']>[1]) {
  return store(env, organizationId).importContacts(ownerMemberId, contacts, 'Google')
}

export async function exportCsv(env: Env, actor: Actor, organizationId: string, query: Omit<ListQuery, 'cursor' | 'limit' | 'viewer'>) {
  const { s, viewer } = await reader(env, actor, organizationId)
  const people = await s.exportPeople({ ...query, viewer })
  if (!people) throw notFound('segment')
  return new Response(toCsv(people), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="users-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}

function toCsv(people: Person[]): string {
  const attrKeys = [...new Set(people.flatMap((p) => Object.keys(p.attributes)))].sort()
  const head = ['id', 'type', 'domain', 'user_id', 'visitor_id', 'name', 'email', 'phone', 'source', 'first_seen', 'last_seen', 'created', ...attrKeys]
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    // Quote everything that needs it, and defuse spreadsheet formulas.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const rows = people.map((p) =>
    [p.id, p.kind, p.domain, p.externalId, p.anonymousId, p.name, p.email, p.phone, p.source, p.firstSeenAt, p.lastSeenAt, p.createdAt, ...attrKeys.map((k) => p.attributes[k])]
      .map(cell)
      .join(','),
  )
  return [head.join(','), ...rows].join('\n') + '\n'
}

// Segments

export async function countFilter(env: Env, actor: Actor, organizationId: string, filter: Filter, domain?: string) {
  const { s, viewer } = await reader(env, actor, organizationId)
  return { count: await s.count(filter, viewer, domain) }
}

export async function saveSegment(env: Env, actor: Actor, organizationId: string, input: { id?: string; name: string; icon?: SegmentIcon; filter: Filter }) {
  const segment = await (await manager(env, actor, organizationId)).saveSegment(input)
  if (!segment) throw notFound('segment')
  return segment
}

export async function deleteSegment(env: Env, actor: Actor, organizationId: string, segmentId: string) {
  if (!(await (await manager(env, actor, organizationId)).deleteSegment(segmentId))) throw notFound('segment')
}

// API keys

export async function getKeys(env: Env, actor: Actor, organizationId: string) {
  await admin(env, actor, organizationId)
  return keys.present(await keys.ensure(env, organizationId))
}

export async function revealSecret(env: Env, actor: Actor, organizationId: string) {
  await admin(env, actor, organizationId)
  return { key: await keys.revealSecret(env, organizationId) }
}

export async function rollSecret(env: Env, actor: Actor, organizationId: string) {
  await admin(env, actor, organizationId)
  const { keys: apiKeys, secret } = await keys.rollSecret(env, organizationId)
  return { keys: apiKeys, key: secret }
}
