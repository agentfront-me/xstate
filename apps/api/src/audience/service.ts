// What the dashboard (and agents over MCP) can do with an organization's audience and API keys. Checks access here,
// then calls the organization's AudienceStore.
//
// Any member can see the audience. Changing people and segments needs the "audience.manage" permission (owners and
// admins have it). API keys are for owners and admins only: the secret key acts for the whole organization.

import { messagesWith } from '../mailserver'
import { isAdmin, loadMember, requireOrgPermission } from '../mailserver/access'
import type { Actor } from '../auth/types'
import { ApiError } from '../errors'
import * as keys from './keys'
import type { ListQuery } from './store'
import type { Filter, Person, PersonDetail, PersonFields, SegmentIcon } from './types'

const store = (env: Env, organizationId: string) => env.AUDIENCE.get(env.AUDIENCE.idFromName(organizationId))

async function reader(env: Env, actor: Actor, organizationId: string) {
  await loadMember(env, organizationId, actor.userId)
  return store(env, organizationId)
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
  return (await reader(env, actor, organizationId)).overview()
}

export async function schema(env: Env, actor: Actor, organizationId: string) {
  return (await reader(env, actor, organizationId)).schema()
}

export async function listPeople(env: Env, actor: Actor, organizationId: string, query: ListQuery) {
  const result = await (await reader(env, actor, organizationId)).listPeople(query)
  if (!result) throw notFound('segment')
  return result
}

/** A person's profile, segments and events, plus the mail exchanged with their email address in the mailboxes the
 * viewer can read. If the mail server can't be reached the profile still loads, with `emails: null`. */
export async function getPerson(env: Env, actor: Actor, organizationId: string, personId: string) {
  // Event properties are free-form JSON, which the RPC stub's types can't express; the shape is store.getPerson's.
  const result = (await (await reader(env, actor, organizationId)).getPerson(personId)) as PersonDetail | null
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

export async function addPerson(env: Env, actor: Actor, organizationId: string, input: { domain: string } & PersonFields) {
  const domain = input.domain.toLowerCase().replace(/^www\./, '')
  const result = await (await manager(env, actor, organizationId)).addPerson({ ...input, domain, source: 'Added manually' })
  if (result.conflict) throw new ApiError('conflict', result.conflict, 409)
  return result.person!
}

export async function updatePerson(env: Env, actor: Actor, organizationId: string, personId: string, fields: PersonFields) {
  const result = await (await manager(env, actor, organizationId)).updatePerson(personId, fields)
  if (!result) throw notFound('person')
  if (result.conflict) throw new ApiError('conflict', result.conflict, 409)
  return result.person!
}

export async function deletePeople(env: Env, actor: Actor, organizationId: string, ids: string[]) {
  return { deleted: await (await manager(env, actor, organizationId)).deletePeople(ids) }
}

export async function exportCsv(env: Env, actor: Actor, organizationId: string, query: Omit<ListQuery, 'cursor' | 'limit'>) {
  const people = await (await reader(env, actor, organizationId)).exportPeople(query)
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
  return { count: await (await reader(env, actor, organizationId)).count(filter, domain) }
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
