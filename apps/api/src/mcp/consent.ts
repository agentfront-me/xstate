// The consent step of connecting an app (docs/mcp-server-plan.md). /authorize (mcp/oauth.ts) keeps the app's request
// here and sends the person to the app's /connect page, which shows it, asks what the app may do, and posts the
// answer with the person's session token. The session proves who approves; a request id alone can do nothing.

import { authorizationErrorRedirect, type AuthRequest, type ConsentDescription } from '@cloudflare/workers-oauth-provider'
import { getMe } from '../auth/service'
import type { Actor } from '../auth/types'
import { ApiError } from '../errors'
import { isAdmin, loadMember, readableMailboxes } from '../mailserver/access'
import { oauthApi } from './oauth'
import { scopesFor, type Choices } from './scopes'
import type { Grant } from './tools'
import { noBackground, track, type Background } from '../analytics/events'

type Pending = { request: AuthRequest; app: ConsentDescription }

const PENDING_TTL_SECONDS = 600
const key = (id: string) => `xstate-connect:${id}`

/** Keeps a validated authorization request for the consent page. Returns its id: 256 random bits. */
export async function savePending(env: Pick<Env, 'OAUTH_KV'>, pending: Pending): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  await env.OAUTH_KV.put(key(id), JSON.stringify(pending), { expirationTtl: PENDING_TTL_SECONDS })
  return id
}

async function loadPending(env: Pick<Env, 'OAUTH_KV'>, id: string): Promise<Pending> {
  const pending = await env.OAUTH_KV.get<Pending>(key(id), 'json')
  if (!pending) {
    throw new ApiError('request_expired', 'This sign-in request has expired or was already answered. Start connecting again from your app.', 404)
  }
  return pending
}

/** What the consent page shows: who is asking, and what this person could give them in each organization. */
export async function describeRequest(env: Env, actor: Actor, id: string) {
  const { app } = await loadPending(env, id)
  const { user, organizations } = await getMe(env, actor)
  const choices = await Promise.all(
    organizations.map(async (organization) => {
      // Organizations they have joined; an invite not yet accepted isn't listed (getMe, loadMember).
      const member = await loadMember(env, organization.id, actor.userId)
      const mailboxes = await readableMailboxes(env, actor, organization.id)
      return {
        id: organization.id,
        name: organization.name,
        canSetup: isAdmin(member),
        mailboxes: mailboxes.map((mailbox) => ({ id: mailbox.id, address: mailbox.address, kind: mailbox.kind, name: mailbox.display_name })),
      }
    }),
  )
  return {
    app: {
      name: app.clientName,
      // Set only for an app that published its details at this domain; otherwise the name is whatever it claimed.
      domain: app.clientDomain ?? null,
      // Where the access goes once approved, and whether that is a program on the person's own computer.
      redirectHost: app.redirectHost,
      local: app.redirectIsLoopback,
    },
    user: { email: user.email },
    organizations: choices,
  }
}

/**
 * Approves a request: checks every choice against what this person can really do, replaces an earlier connection
 * of the same app to the same organization, and returns the address that takes the browser back to the app.
 */
export async function approveRequest(
  env: Env,
  actor: Actor,
  id: string,
  input: { organizationId: string; mailboxIds: string[] } & Choices,
  background: Background = noBackground,
): Promise<{ redirectTo: string }> {
  const { request, app } = await loadPending(env, id)
  const member = await loadMember(env, input.organizationId, actor.userId)
  if (input.setup && !isAdmin(member)) throw new ApiError('forbidden', 'Only owners and admins can let an app manage domains and mailboxes', 403)
  const readable = new Set((await readableMailboxes(env, actor, input.organizationId)).map((mailbox) => mailbox.id))
  const mailboxIds = [...new Set(input.mailboxIds)]
  if (mailboxIds.some((mailboxId) => !readable.has(mailboxId))) throw new ApiError('mailbox_not_found', 'Mailbox not found', 404)

  // Works once: gone before anything is granted, so a second submit finds nothing.
  await env.OAUTH_KV.delete(key(id))

  const oauth = oauthApi(env)
  const scopes = scopesFor(input)
  const grant: Grant = { userId: actor.userId, organizationId: input.organizationId, scopes, mailboxIds, app: app.clientName }
  // The library would revoke this person's every grant for the app, including ones to other organizations. Ours:
  // only the connection this one replaces (same app, same place it sends access, same organization).
  const earlier = await oauth.listUserGrants(actor.userId, { limit: 1000 })
  const replaced = earlier.items.filter(
    (g) => g.clientId === request.clientId && g.redirectUri === request.redirectUri && (g.metadata as GrantMetadata | null)?.organizationId === input.organizationId,
  )
  const { redirectTo } = await oauth.completeAuthorization({
    request,
    userId: actor.userId,
    // Readable without the token (props aren't): what Settings → Connected apps lists.
    metadata: { organizationId: input.organizationId, app: app.clientName, appDomain: app.clientDomain ?? null, mailboxIds } satisfies GrantMetadata,
    scope: scopes,
    props: grant,
    revokeExistingGrants: false,
  })
  await Promise.all(replaced.map((g) => oauth.revokeGrant(g.id, actor.userId)))
  console.log('mcp connected', JSON.stringify({ userId: actor.userId, organizationId: input.organizationId, app: app.clientName, appDomain: app.clientDomain ?? null, scopes, mailboxes: mailboxIds.length, replaced: replaced.length }))
  track(env, background, actor.userId, input.organizationId, 'AI App Connected', { client_name: app.clientName, scopes: [...scopes] })
  return { redirectTo }
}

/** Declines a request and returns the address that tells the app so. Needs a session like approving does. */
export async function denyRequest(env: Env, id: string): Promise<{ redirectTo: string }> {
  const { request } = await loadPending(env, id)
  await env.OAUTH_KV.delete(key(id))
  return { redirectTo: authorizationErrorRedirect(request, 'access_denied', 'The person declined') }
}

export type GrantMetadata = { organizationId: string; app: string; appDomain: string | null; mailboxIds: string[] }
