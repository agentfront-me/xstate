// Stalwart x:Account objects. Users sign in with a password; groups are shared mailboxes opened by their members.

import { create, destroy, indexed, jmap, update, type StalwartEnv } from './client'

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

/** The permissions a sending suspension turns off: SMTP submission (and sign-in on SMTP) and JMAP sending. */
const SEND_PERMISSIONS = ['emailSend', 'jmapEmailSubmissionCreate']

type Permissions =
  | { '@type': 'Inherit' }
  | { '@type': 'Merge' | 'Replace'; enabledPermissions: Record<string, boolean>; disabledPermissions: Record<string, boolean> }

/**
 * Turns an account's sending on or off, keeping any other permission changes it has. Off blocks SMTP sign-in
 * ("not authorized to use this service") and JMAP submission; IMAP and reading mail keep working. Returns 'admin'
 * without changing anything for an administrator account (the API key belongs to one), and 'missing' for an
 * account that no longer exists.
 */
export async function setSendingBlocked(env: StalwartEnv, id: string, blocked: boolean): Promise<'done' | 'admin' | 'missing'> {
  const [result] = await jmap(env, [['x:Account/get', { ids: [id], properties: ['permissions', 'roles'] }]])
  const account = (result?.list as { permissions?: Permissions; roles?: { '@type'?: string } }[] | undefined)?.[0]
  if (!account) return 'missing'
  if (account.roles?.['@type'] === 'Admin') return 'admin'

  const current = account.permissions ?? { '@type': 'Inherit' }
  const next: Permissions =
    current['@type'] === 'Inherit'
      ? { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: {} }
      : { ...current, enabledPermissions: { ...current.enabledPermissions }, disabledPermissions: { ...current.disabledPermissions } }
  for (const p of SEND_PERMISSIONS) {
    if (blocked) next.disabledPermissions[p] = true
    else delete next.disabledPermissions[p]
  }
  const empty = next['@type'] === 'Merge' && !Object.keys(next.enabledPermissions).length && !Object.keys(next.disabledPermissions).length
  await update(env, 'x:Account', id, { permissions: empty ? { '@type': 'Inherit' } : next })
  return 'done'
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
