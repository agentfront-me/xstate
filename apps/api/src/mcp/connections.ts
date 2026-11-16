// Settings → Connected apps: the AI apps connected to an organization over MCP, and disconnecting them. Everyone sees
// their own; owners and admins see, and can disconnect, everyone's. A connection is an OAuth grant
// (@cloudflare/workers-oauth-provider), found through each person's grant list and the organization in its metadata.

import type { GrantSummary } from '@cloudflare/workers-oauth-provider'
import type { Actor } from '../auth/types'
import * as mailboxesDb from '../db/mailboxes'
import * as membersDb from '../db/members'
import { ApiError } from '../errors'
import { isAdmin, loadMember } from '../mailserver/access'
import type { GrantMetadata } from './consent'
import { CONNECTION_IDLE_SECONDS, oauthApi } from './oauth'

export type Connection = {
  id: string
  app: string
  /** The app's verified domain, or null when it only gave a name. */
  appDomain: string | null
  person: { userId: string; name: string | null; email: string; you: boolean }
  scopes: string[]
  mailboxes: { id: string; address: string }[]
  connectedAt: string
  /** When the app last renewed its access: within about an hour of its last use. */
  lastActiveAt: string | null
  /** When it ends unless it is used again. */
  expiresAt: string | null
}

type Found = { grant: GrantSummary; metadata: GrantMetadata; person: Connection['person'] }

async function grantsOf(env: Env, userId: string): Promise<GrantSummary[]> {
  const oauth = oauthApi(env)
  const all: GrantSummary[] = []
  let cursor: string | undefined
  do {
    const page = await oauth.listUserGrants(userId, { limit: 1000, cursor })
    all.push(...page.items)
    cursor = page.cursor
  } while (cursor)
  return all
}

/** The connections the actor may see in this organization: their own, or everyone's for owners and admins. */
async function visible(env: Env, actor: Actor, organizationId: string): Promise<Found[]> {
  const member = await loadMember(env, organizationId, actor.userId)
  const people = (await membersDb.listForOrg(env.DB, organizationId)).filter(
    (m) => m.status === 'active' && (isAdmin(member) || m.user_id === actor.userId),
  )
  const found = await Promise.all(
    people.map(async (m) =>
      (await grantsOf(env, m.user_id)).flatMap((grant) => {
        const metadata = grant.metadata as GrantMetadata | null
        if (metadata?.organizationId !== organizationId) return []
        // Approved, but the app never collected its tokens (a sign-in left halfway): nothing to show or end.
        if (!grant.expiresAt) return []
        return [{ grant, metadata, person: { userId: m.user_id, name: m.name, email: m.email, you: m.user_id === actor.userId } }]
      }),
    ),
  )
  return found.flat()
}

export async function listConnections(env: Env, actor: Actor, organizationId: string): Promise<{ connections: Connection[] }> {
  const found = await visible(env, actor, organizationId)
  const addresses = new Map((await mailboxesDb.list(env.DB, organizationId)).map((m) => [m.id, m.address]))
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString()
  const connections = found.map(({ grant, metadata, person }): Connection => {
    const lastActive = grant.expiresAt ? grant.expiresAt - CONNECTION_IDLE_SECONDS : null
    return {
      id: grant.id,
      app: metadata.app,
      appDomain: metadata.appDomain,
      person,
      scopes: grant.scope,
      // A mailbox deleted since has no address any more, and nothing to reach.
      mailboxes: metadata.mailboxIds.flatMap((id) => {
        const address = addresses.get(id)
        return address ? [{ id, address }] : []
      }),
      connectedAt: iso(grant.createdAt),
      lastActiveAt: lastActive !== null && lastActive > grant.createdAt ? iso(lastActive) : null,
      expiresAt: grant.expiresAt ? iso(grant.expiresAt) : null,
    }
  })
  // Yours first, then the most recently active.
  connections.sort((a, b) => Number(b.person.you) - Number(a.person.you) || (b.lastActiveAt ?? b.connectedAt).localeCompare(a.lastActiveAt ?? a.connectedAt))
  return { connections }
}

/** Ends a connection at once: its tokens stop working on the app's next call. */
export async function revokeConnection(env: Env, actor: Actor, organizationId: string, connectionId: string): Promise<void> {
  const target = (await visible(env, actor, organizationId)).find((f) => f.grant.id === connectionId)
  // Same answer for one that doesn't exist and one this person may not see.
  if (!target) throw new ApiError('connection_not_found', 'Connection not found', 404)
  await oauthApi(env).revokeGrant(target.grant.id, target.person.userId)
  console.log('mcp disconnected', JSON.stringify({ by: actor.userId, userId: target.person.userId, organizationId, app: target.metadata.app, clientId: target.grant.clientId }))
}
