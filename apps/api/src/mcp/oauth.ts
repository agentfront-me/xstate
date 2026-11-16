// Sign-in for connected apps (docs/mcp-server-plan.md). xstate is its own OAuth authorization server: an AI app is
// given <MCP_URL>/mcp, discovers the endpoints below, sends the person to /authorize, and ends up with a token tied
// to exactly what they allowed on the consent page (the app's /connect). Clients, grants and tokens live in
// OAUTH_KV, managed by @cloudflare/workers-oauth-provider.
//
// Everything here is served on the MCP host only (mcp.xstate.com), never on api.xstate.com:
//   /mcp                                      the MCP server (mcp/server.ts), for a valid token
//   /.well-known/oauth-protected-resource/mcp which authorization server to use
//   /.well-known/oauth-authorization-server   its endpoints
//   /authorize                                checks the request, then hands over to the consent page
//   /oauth/token, /oauth/register             tokens, refresh and revocation; registration for older clients

import { AuthorizationError, CimdFetchError, OAuthAuthorizationServer, OAuthResourceServer, type OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { MCP_SCOPES } from '../operations/define'
import { savePending } from './consent'
import { serveMcp } from './server'
import type { Grant } from './tools'

const HOUR = 60 * 60
const DAY = 24 * HOUR
/** A connection ends this long after the app last renewed its access (refreshTokenIdleTTL below). */
export const CONNECTION_IDLE_SECONDS = 30 * DAY

type Roles = { authorization: OAuthAuthorizationServer<Env>; resource: OAuthResourceServer<Env, Grant> }
// Built once per isolate. Keyed by MCP_URL only so local dev on another port gets its own.
const built = new Map<string, Roles>()

function roles(env: Env): Roles {
  const issuer = (env.MCP_URL as string).replace(/\/$/, '')
  let made = built.get(issuer)
  if (made) return made
  const resource = `${issuer}/mcp`
  const authorization = new OAuthAuthorizationServer<Env>({
    issuer,
    resources: [resource],
    // The catalogue. The resource names none as required, so apps ask for nothing and the consent page decides.
    scopesSupported: MCP_SCOPES.filter((scope) => scope !== 'profile'),
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: HOUR,
    // A connection lasts while it's used: 30 days from the last refresh, not from sign-in.
    refreshTokenTTL: 30 * DAY,
    refreshTokenIdleTTL: CONNECTION_IDLE_SECONDS,
  })
  made = {
    authorization,
    resource: new OAuthResourceServer<Env, Grant>({
      resourceMetadata: { resource, authorization_servers: [issuer] },
      validateToken: (e) => (res, token) => authorization.validateToken<Grant>(res, token, e),
      handler: {
        fetch: (request, e, ctx) => serveMcp(request, e, ctx, ctx.props, { clientId: ctx.auth.clientId ?? 'unknown' }, new URL(issuer).hostname),
      },
    }),
  }
  built.set(issuer, made)
  return made
}

/** The library's helpers: complete or refuse an authorization, list and revoke a person's connections. */
export const oauthApi = (env: Env): OAuthHelpers => roles(env).authorization.getOAuthApi(env)

/** Hourly: remove grants and tokens that expired or lost their client (KV's own expiry does most of it). */
export const purgeOAuth = (env: Env) => roles(env).authorization.purgeExpiredData(env)

/**
 * Answers a request to the MCP host, or returns null when it isn't one (the API handles it).
 *
 * In production the host decides, and mcp.xstate.com serves nothing but the paths above. In local development one
 * address serves both, and `wrangler dev` reports the production host (the first route) instead of the address
 * that was called, so there the path decides and the request is put back on MCP_URL, which the OAuth library
 * checks every request against.
 */
export function handleMcpHost(incoming: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response | null {
  const mcp = new URL(env.MCP_URL)
  const called = new URL(incoming.url)
  const local = (env.ENVIRONMENT as string) !== 'production'
  if (!local && called.host !== mcp.host) return null
  const path = called.pathname
  const ours = path === '/mcp' || path === '/authorize' || path.startsWith('/oauth/') || path.startsWith('/.well-known/oauth-')
  if (!ours) {
    if (local) return null
    return Response.json({ error: { code: 'not_found', message: `The xstate MCP server is at ${mcp.origin}/mcp` } }, { status: 404 })
  }
  let request = incoming
  if (local) {
    request = new Request(`${mcp.origin}${path}${called.search}`, incoming)
    request.headers.set('Host', mcp.host)
  }
  const { authorization, resource } = roles(env)
  if (path === '/mcp' || path.startsWith('/.well-known/oauth-protected-resource')) return resource.fetch(request, env, ctx)
  if (path === '/authorize') return authorize(request, env)
  return authorization.fetch(request, env, ctx)
}

/**
 * The authorization endpoint. Validates the client, its redirect URI and PKCE, keeps the request for 10 minutes
 * and sends the browser to the consent page with its id. The page (and the session that proves who is approving)
 * live in the app, so nothing here sets a cookie or shows a form.
 */
async function authorize(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
  const oauth = oauthApi(env)
  try {
    const authRequest = await oauth.parseAuthRequest(request)
    // Before anything is stored: an app whose metadata can't be fetched never reaches the consent page.
    const app = await oauth.describeConsent(authRequest)
    const id = await savePending(env, { request: authRequest, app })
    // In the hash, like invite links, so the id stays out of server logs.
    return Response.redirect(`${env.APP_URL.replace(/\/$/, '')}/connect/#${id}`, 302)
  } catch (err) {
    // Only once the client and its exact redirect URI are known good may the error go back to the app.
    if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302)
    if (err instanceof AuthorizationError) return plain(`This sign-in link isn't valid: ${err.description}`, 400)
    if (err instanceof CimdFetchError) return plain("xstate couldn't verify the app that sent you here. Try connecting again from the app.", 400)
    throw err
  }
}

const plain = (text: string, status: number) =>
  new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' } })
