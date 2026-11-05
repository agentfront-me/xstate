// Stalwart x:Account objects. Users sign in with a password; groups are shared mailboxes opened by their members.

import { create, destroy, indexed, update, type StalwartEnv } from './client'

type AccountFields = {
  /** Local part of the address; the domain comes from domainId. */
  name: string
  /** Stalwart id of the domain. */
  domainId: string
  /** Display name. */
  description: string | null
  quotaBytes: number | null
}

/** An extra address on an account, on any Stalwart domain. */
export type Alias = { localPart: string; domainId: string }

export function createUser(env: StalwartEnv, fields: AccountFields & { password: string }): Promise<string> {
  return create(env, 'x:Account', {
    '@type': 'User',
    ...common(fields),
    credentials: indexed([{ '@type': 'Password', secret: fields.password }]),
    roles: { '@type': 'User' },
  })
}

export function createGroup(env: StalwartEnv, fields: AccountFields): Promise<string> {
  return create(env, 'x:Account', { '@type': 'Group', ...common(fields) })
}

/** Changes the display name and/or storage quota; omitted fields are left alone. */
export function updateAccount(
  env: StalwartEnv,
  id: string,
  changes: { description?: string | null; quotaBytes?: number | null },
): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (changes.description !== undefined) patch.description = changes.description
  if (changes.quotaBytes !== undefined) patch.quotas = quotas(changes.quotaBytes)
  return update(env, 'x:Account', id, patch)
}

/** Resets the first credential's password. Also signs the account out of its OAuth apps. */
export function setPassword(env: StalwartEnv, id: string, password: string): Promise<void> {
  return update(env, 'x:Account', id, { 'credentials/0/secret': password })
}

/** Replaces the account's alias list. */
export function setAliases(env: StalwartEnv, id: string, aliases: Alias[]): Promise<void> {
  return update(env, 'x:Account', id, {
    aliases: indexed(aliases.map((a) => ({ name: a.localPart, domainId: a.domainId, enable: true }))),
  })
}

/** Replaces the groups (shared mailboxes) a user account belongs to. */
export function setMemberGroups(env: StalwartEnv, id: string, groupIds: string[]): Promise<void> {
  return update(env, 'x:Account', id, { memberGroupIds: Object.fromEntries(groupIds.map((g) => [g, true])) })
}

/** Deletes the account at once; Stalwart removes its mail and other data in a background task. */
export function destroyAccount(env: StalwartEnv, id: string): Promise<void> {
  return destroy(env, 'x:Account', id)
}

function common(fields: AccountFields) {
  return {
    name: fields.name,
    domainId: fields.domainId,
    description: fields.description,
    quotas: quotas(fields.quotaBytes),
    aliases: {},
  }
}

/** Stalwart's quotas map; empty means no limit. */
function quotas(quotaBytes: number | null): Record<string, number> {
  return quotaBytes ? { maxDiskQuota: quotaBytes } : {}
}
