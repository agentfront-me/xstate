// Connectors: any MCP server by URL, added once per organization (docs/agents-plan.md, Phase 4).
//
// Credentials stay here, not in agents: header values (which may reference organization secrets as {{secret.NAME}})
// and OAuth tokens are encrypted in D1. Each discovery or tool call opens a short MCP connection (Streamable HTTP) with
// those credentials and closes it; nothing is cached in an agent's Durable Object. OAuth follows the MCP authorization
// spec through the SDK's `auth()`: discovery, dynamic client registration, PKCE, and token refresh on a 401.
//
// Owners and admins add and change connectors; anyone who manages agents can see them and pick their tools.

import { auth, Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import type { OAuthClientMetadata, OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client'
import type { Context } from 'hono'
import type { Actor } from '../auth/types'
import * as db from '../db/agents'
import { ApiError } from '../errors'
import { isAdmin, loadMember } from '../mailserver/access'
import { requireAdmin } from './providers'
import { seal, unseal } from './seal'
import { parseConfig } from './config'

export type ConnectorAuth = 'none' | 'headers' | 'oauth'
export type ConnectorStatus = 'connected' | 'needs_auth' | 'error'
export type ConnectorTool = { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean }

type Row = {
  id: string
  organization_id: string
  name: string
  url: string
  auth: ConnectorAuth
  headers_encrypted: string | null
  header_names: string
  secret_refs: string
  oauth_encrypted: string | null
  status: ConnectorStatus
  status_detail: string | null
  tools: string
  created_at: string
  updated_at: string
  checked_at: string | null
}

export type Connector = {
  id: string
  name: string
  url: string
  auth: ConnectorAuth
  headerNames: string[]
  secretRefs: string[]
  status: ConnectorStatus
  statusDetail: string | null
  tools: ConnectorTool[]
  createdAt: string
  checkedAt: string | null
  /** Agents that use at least one of its tools. */
  usedBy: number
}

type OAuthState = {
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  verifier?: string
  /** Pending sign-in: the nonce in the state parameter, so a callback can't be replayed or forged. */
  nonce?: string
}

const SECRET_REF = /\{\{\s*secret\.([A-Z][A-Z0-9_]*)\s*\}\}/g
const MAX_TOOLS = 200
const TIMEOUT_MS = 30_000

const present = (r: Row, usedBy = 0): Connector => ({
  id: r.id,
  name: r.name,
  url: r.url,
  auth: r.auth,
  headerNames: JSON.parse(r.header_names) as string[],
  secretRefs: JSON.parse(r.secret_refs) as string[],
  status: r.status,
  statusDetail: r.status_detail,
  tools: JSON.parse(r.tools) as ConnectorTool[],
  createdAt: r.created_at,
  checkedAt: r.checked_at,
  usedBy,
})

export async function findRow(env: Env, connectorId: string): Promise<Row | null> {
  return env.DB.prepare('SELECT * FROM connectors WHERE id = ?').bind(connectorId).first<Row>()
}

async function listRows(env: Env, organizationId: string): Promise<Row[]> {
  const { results } = await env.DB.prepare('SELECT * FROM connectors WHERE organization_id = ? ORDER BY created_at').bind(organizationId).all<Row>()
  return results
}

async function canView(env: Env, actor: Actor, organizationId: string) {
  const member = await loadMember(env, organizationId, actor.userId)
  if (!isAdmin(member) && !member.permissions.org.includes('agents.manage')) {
    throw new ApiError('forbidden', 'Only owners, admins and people who manage agents can see connectors', 403)
  }
}

async function adminRow(env: Env, actor: Actor, organizationId: string, connectorId: string): Promise<Row> {
  await requireAdmin(env, actor, organizationId)
  const row = await findRow(env, connectorId)
  if (!row || row.organization_id !== organizationId) throw new ApiError('not_found', 'No such connector', 404)
  return row
}

/** Connectors are reached over HTTPS; plain http only to localhost outside production. */
function checkUrl(env: Env, raw: string): string {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ApiError('invalid_url', 'Enter the server’s full URL, like https://mcp.example.com/mcp')
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && env.ENVIRONMENT !== 'production')) {
    throw new ApiError('invalid_url', 'Connectors must use https://')
  }
  if (local && env.ENVIRONMENT === 'production') throw new ApiError('invalid_url', 'That address isn’t reachable from xstate')
  url.hash = ''
  return url.toString()
}

type HeaderInput = { name: string; value: string }

function checkHeaders(headers: HeaderInput[]): HeaderInput[] {
  const out: HeaderInput[] = []
  for (const h of headers) {
    const name = h.name.trim()
    if (!name && !h.value) continue
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new ApiError('invalid_header', `“${name}” isn’t a valid header name`)
    if (/^(host|content-length|content-type|accept|mcp-session-id|mcp-protocol-version)$/i.test(name)) {
      throw new ApiError('invalid_header', `${name} is set by xstate`)
    }
    out.push({ name, value: h.value })
  }
  return out
}

const refsOf = (headers: HeaderInput[]) => [...new Set(headers.flatMap((h) => [...h.value.matchAll(SECRET_REF)].map((m) => m[1]!)))]

// ---------------------------------------------------------------------------------------------------------------
// Managing connectors

export async function list(env: Env, actor: Actor, organizationId: string): Promise<Connector[]> {
  await canView(env, actor, organizationId)
  const rows = await listRows(env, organizationId)
  const used = new Map<string, number>()
  for (const agent of await db.listAgents(env.DB, organizationId)) {
    for (const [id, tools] of Object.entries(parseConfig(agent.draft).tools.connectors)) if (tools.length) used.set(id, (used.get(id) ?? 0) + 1)
  }
  return rows.map((r) => present(r, used.get(r.id) ?? 0))
}

/**
 * Adds a connector and discovers its tools. An OAuth connector comes back with `authUrl` to sign in at; it shows
 * "Needs sign-in" until that's done.
 */
export async function create(
  env: Env,
  actor: Actor,
  organizationId: string,
  input: { name: string; url: string; auth: ConnectorAuth; headers?: HeaderInput[] },
): Promise<{ connector: Connector; authUrl?: string }> {
  await requireAdmin(env, actor, organizationId)
  const name = input.name.trim().slice(0, 80)
  if (!name) throw new ApiError('invalid_name', 'Give the connector a name')
  const url = checkUrl(env, input.url)
  const headers = input.auth === 'headers' ? checkHeaders(input.headers ?? []) : []
  await checkSecretsExist(env, organizationId, refsOf(headers))
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO connectors (id, organization_id, name, url, auth, headers_encrypted, header_names, secret_refs, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      organizationId,
      name,
      url,
      input.auth,
      headers.length ? await seal(env, JSON.stringify(headers)) : null,
      JSON.stringify(headers.map((h) => h.name)),
      JSON.stringify(refsOf(headers)),
      input.auth === 'oauth' ? 'needs_auth' : 'connected',
      actor.userId,
      now,
      now,
    )
    .run()
  const row = (await findRow(env, id))!
  if (input.auth === 'oauth') {
    // A server that can't start sign-in still gets saved, with the reason as its status, so it can be retried.
    const authUrl = await beginOAuth(env, row).catch(() => null)
    return { connector: present((await findRow(env, id))!), ...(authUrl && { authUrl }) }
  }
  await discover(env, row)
  return { connector: present((await findRow(env, id))!) }
}

export async function update(
  env: Env,
  actor: Actor,
  organizationId: string,
  connectorId: string,
  input: { name?: string; url?: string; headers?: HeaderInput[] },
): Promise<Connector> {
  const row = await adminRow(env, actor, organizationId, connectorId)
  const sets: string[] = []
  const values: unknown[] = []
  if (input.name !== undefined) {
    sets.push('name = ?')
    values.push(input.name.trim().slice(0, 80) || row.name)
  }
  if (input.url !== undefined) {
    sets.push('url = ?')
    values.push(checkUrl(env, input.url))
  }
  if (input.headers !== undefined && row.auth === 'headers') {
    const headers = checkHeaders(input.headers)
    await checkSecretsExist(env, organizationId, refsOf(headers))
    sets.push('headers_encrypted = ?', 'header_names = ?', 'secret_refs = ?')
    values.push(headers.length ? await seal(env, JSON.stringify(headers)) : null, JSON.stringify(headers.map((h) => h.name)), JSON.stringify(refsOf(headers)))
  }
  if (sets.length) {
    sets.push('updated_at = ?')
    values.push(new Date().toISOString())
    await env.DB.prepare(`UPDATE connectors SET ${sets.join(', ')} WHERE id = ?`).bind(...values, row.id).run()
  }
  const fresh = (await findRow(env, row.id))!
  if (input.url !== undefined || input.headers !== undefined) await discover(env, fresh)
  return present((await findRow(env, row.id))!)
}

export async function remove(env: Env, actor: Actor, organizationId: string, connectorId: string): Promise<void> {
  const row = await adminRow(env, actor, organizationId, connectorId)
  await env.DB.prepare('DELETE FROM connectors WHERE id = ?').bind(row.id).run()
}

/** Connects again and refreshes the tool list. Anyone who manages agents may refresh. */
export async function refresh(env: Env, actor: Actor, organizationId: string, connectorId: string): Promise<Connector> {
  await canView(env, actor, organizationId)
  const row = await findRow(env, connectorId)
  if (!row || row.organization_id !== organizationId) throw new ApiError('not_found', 'No such connector', 404)
  await discover(env, row)
  return present((await findRow(env, row.id))!)
}

/** Starts (or restarts) OAuth sign-in. Returns the URL to open, or null when the tokens still work. */
export async function authorize(env: Env, actor: Actor, organizationId: string, connectorId: string) {
  const row = await adminRow(env, actor, organizationId, connectorId)
  if (row.auth !== 'oauth') throw new ApiError('invalid_input', 'This connector doesn’t use sign-in')
  const authUrl = await beginOAuth(env, row, true)
  return { authUrl, connector: present((await findRow(env, row.id))!) }
}

async function checkSecretsExist(env: Env, organizationId: string, names: string[]) {
  if (!names.length) return
  const have = new Set((await db.listSecrets(env.DB, organizationId)).map((s) => s.name))
  const missing = names.filter((n) => !have.has(n))
  if (missing.length) throw new ApiError('unknown_secret', `No secret called ${missing.join(', ')}. Add it in Settings → Secrets first.`)
}

// ---------------------------------------------------------------------------------------------------------------
// Talking to the server

async function setStatus(env: Env, id: string, status: ConnectorStatus, detail: string | null, tools?: ConnectorTool[]) {
  const now = new Date().toISOString()
  if (tools) {
    await env.DB.prepare('UPDATE connectors SET status = ?, status_detail = ?, tools = ?, checked_at = ? WHERE id = ?').bind(status, detail, JSON.stringify(tools), now, id).run()
  } else {
    await env.DB.prepare('UPDATE connectors SET status = ?, status_detail = ?, checked_at = ? WHERE id = ?').bind(status, detail, now, id).run()
  }
}

/** Header values with {{secret.NAME}} filled in; marks those secrets as used. */
async function resolveHeaders(env: Env, row: Row): Promise<Record<string, string>> {
  if (row.auth !== 'headers' || !row.headers_encrypted) return {}
  const headers = JSON.parse(await unseal(env, row.headers_encrypted)) as HeaderInput[]
  const refs = refsOf(headers)
  const secrets = new Map<string, string>()
  if (refs.length) {
    for (const s of await db.listSecrets(env.DB, row.organization_id)) {
      if (refs.includes(s.name)) secrets.set(s.name, await unseal(env, s.value_encrypted))
    }
    const missing = refs.filter((r) => !secrets.has(r))
    if (missing.length) throw new ConnectorError('error', `The secret ${missing.join(', ')} was deleted. Add it again in Settings → Secrets.`)
    await env.DB.prepare(`UPDATE secrets SET last_used_at = ? WHERE organization_id = ? AND name IN (${refs.map(() => '?').join(',')})`)
      .bind(new Date().toISOString(), row.organization_id, ...refs)
      .run()
  }
  return Object.fromEntries(headers.map((h) => [h.name, h.value.replace(SECRET_REF, (_, n: string) => secrets.get(n) ?? '')]))
}

class ConnectorError extends Error {
  constructor(
    readonly status: ConnectorStatus,
    message: string,
  ) {
    super(message)
  }
}

/** Opens an MCP connection with the connector's credentials, runs `fn`, and closes it. */
async function withClient<T>(env: Env, row: Row, fn: (client: Client) => Promise<T>): Promise<T> {
  const headers = await resolveHeaders(env, row)
  const transport = new StreamableHTTPClientTransport(new URL(row.url), {
    requestInit: { headers },
    ...(row.auth === 'oauth' && { authProvider: new D1OAuthProvider(env, row) }),
  })
  const client = new Client({ name: 'xstate', version: '1.0.0' })
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new ConnectorError('error', `${row.name} didn’t answer within 30 seconds`)), TIMEOUT_MS))
  try {
    await Promise.race([client.connect(transport), timer])
    return await Promise.race([fn(client), timer])
  } catch (err) {
    if (err instanceof ConnectorError) throw err
    if (err instanceof UnauthorizedError || /\b401\b|unauthorized/i.test(String(err))) {
      throw new ConnectorError('needs_auth', row.auth === 'oauth' ? `Sign in to ${row.name} again` : `${row.name} rejected the credentials (401)`)
    }
    throw new ConnectorError('error', `${row.name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500))
  } finally {
    await client.close().catch(() => {})
  }
}

/** Lists the server's tools and saves them on the connector, with its status. */
export async function discover(env: Env, row: Row): Promise<void> {
  try {
    const tools = await withClient(env, row, async (client) => {
      const found: ConnectorTool[] = []
      let cursor: string | undefined
      do {
        const page = await client.listTools(cursor ? { cursor } : {})
        for (const t of page.tools) {
          found.push({
            name: t.name,
            ...(t.title && { title: t.title }),
            description: (t.description ?? t.title ?? t.name).slice(0, 2000),
            inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            readOnly: !!t.annotations?.readOnlyHint,
          })
        }
        cursor = page.nextCursor
      } while (cursor && found.length < MAX_TOOLS)
      return found.slice(0, MAX_TOOLS)
    })
    await setStatus(env, row.id, 'connected', null, tools)
  } catch (err) {
    const e = err instanceof ConnectorError ? err : new ConnectorError('error', String(err))
    await setStatus(env, row.id, e.status, e.message)
  }
}

/** Calls one tool for a run. Errors come back as `{ error }` for the model; the connector's status is updated. */
export async function callTool(env: Env, organizationId: string, connectorId: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const row = await findRow(env, connectorId)
  if (!row || row.organization_id !== organizationId) return { error: 'This connector was removed' }
  try {
    const result = await withClient(env, row, (client) => client.callTool({ name: tool, arguments: args }))
    if (row.status !== 'connected') await setStatus(env, row.id, 'connected', null)
    const r = result as { content?: unknown[]; structuredContent?: unknown; isError?: boolean }
    // Text parts are what models read; keep structured content when the server gives it.
    const text = (r.content ?? [])
      .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? (c as { text: string }).text : null))
      .filter((t): t is string => t !== null)
      .join('\n')
    const out = r.structuredContent ?? (text ? tryJson(text) : r.content)
    return r.isError ? { error: typeof out === 'string' ? out : JSON.stringify(out) } : out
  } catch (err) {
    const e = err instanceof ConnectorError ? err : new ConnectorError('error', String(err))
    await setStatus(env, row.id, e.status, e.message)
    return { error: e.message }
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// ---------------------------------------------------------------------------------------------------------------
// OAuth

const callbackUrl = (env: Env) => `${env.API_URL.replace(/\/+$/, '')}/connectors/oauth/callback`

/** The MCP SDK's OAuth client storage, backed by the connector's encrypted `oauth_encrypted` column. */
class D1OAuthProvider implements OAuthClientProvider {
  /** Set by redirectToAuthorization: where the person has to sign in. */
  authUrl: string | null = null
  private cache: OAuthState | null = null

  constructor(
    private env: Env,
    private row: Row,
  ) {}

  get redirectUrl() {
    return callbackUrl(this.env)
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'xstate',
      client_uri: 'https://xstate.com',
      redirect_uris: [callbackUrl(this.env)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    } as OAuthClientMetadata
  }

  private async load(): Promise<OAuthState> {
    if (!this.cache) {
      const fresh = await findRow(this.env, this.row.id)
      this.cache = fresh?.oauth_encrypted ? (JSON.parse(await unseal(this.env, fresh.oauth_encrypted)) as OAuthState) : {}
    }
    return this.cache
  }

  private async save(patch: Partial<OAuthState>) {
    this.cache = { ...(await this.load()), ...patch }
    await this.env.DB.prepare('UPDATE connectors SET oauth_encrypted = ? WHERE id = ?').bind(await seal(this.env, JSON.stringify(this.cache)), this.row.id).run()
  }

  /** The OAuth state parameter: the connector id (to find it in the callback) and a one-time nonce. */
  async state(): Promise<string> {
    const nonce = crypto.randomUUID()
    await this.save({ nonce })
    return `${this.row.id}.${nonce}`
  }

  async clientInformation() {
    return (await this.load()).client
  }
  async saveClientInformation(client: StoredOAuthClientInformation) {
    await this.save({ client })
  }
  async tokens() {
    return (await this.load()).tokens
  }
  async saveTokens(tokens: StoredOAuthTokens) {
    await this.save({ tokens })
  }
  redirectToAuthorization(url: URL) {
    this.authUrl = url.toString()
  }
  async saveCodeVerifier(verifier: string) {
    await this.save({ verifier })
  }
  async codeVerifier() {
    const v = (await this.load()).verifier
    if (!v) throw new Error('No sign-in in progress')
    return v
  }
}

/** Runs discovery and registration and gets the sign-in URL (or confirms existing tokens still work). */
async function beginOAuth(env: Env, row: Row, force = false): Promise<string | null> {
  const provider = new D1OAuthProvider(env, row)
  try {
    const result = await auth(provider, { serverUrl: row.url, forceReauthorization: force })
    if (result === 'AUTHORIZED') {
      await discover(env, row)
      return null
    }
    await setStatus(env, row.id, 'needs_auth', `Sign in to ${row.name} to finish connecting`)
    return provider.authUrl
  } catch (err) {
    const message = `${row.name} sign-in couldn’t start: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500)
    await setStatus(env, row.id, 'error', message)
    throw new ApiError('oauth_failed', message, 502)
  }
}

/** GET /connectors/oauth/callback: the provider sends the person back here after signing in. */
export async function handleOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env
  const back = (params: Record<string, string>) => c.redirect(`${env.APP_URL.replace(/\/+$/, '')}/app/#/settings/connectors?${new URLSearchParams(params)}`)
  const [id, nonce] = (c.req.query('state') ?? '').split('.')
  const code = c.req.query('code')
  const error = c.req.query('error_description') ?? c.req.query('error')
  const row = id ? await findRow(env, id) : null
  if (!row || row.auth !== 'oauth') return back({ error: 'That sign-in link is no longer valid' })
  const provider = new D1OAuthProvider(env, row)
  const saved = row.oauth_encrypted ? (JSON.parse(await unseal(env, row.oauth_encrypted)) as OAuthState) : {}
  if (!nonce || saved.nonce !== nonce) return back({ error: 'That sign-in link is no longer valid. Try connecting again.' })
  if (error || !code) {
    await setStatus(env, row.id, 'needs_auth', `Sign-in was cancelled${error ? `: ${error}` : ''}`)
    return back({ error: `${row.name}: sign-in was cancelled` })
  }
  try {
    const result = await auth(provider, { serverUrl: row.url, authorizationCode: code, iss: c.req.query('iss') })
    if (result !== 'AUTHORIZED') throw new Error('the server asked to sign in again')
    // One use per sign-in.
    const after = JSON.parse(await unseal(env, (await findRow(env, row.id))!.oauth_encrypted!)) as OAuthState
    delete after.nonce
    delete after.verifier
    await env.DB.prepare('UPDATE connectors SET oauth_encrypted = ? WHERE id = ?').bind(await seal(env, JSON.stringify(after)), row.id).run()
    await discover(env, (await findRow(env, row.id))!)
    return back({ connected: row.id })
  } catch (err) {
    const message = `${row.name}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300)
    await setStatus(env, row.id, 'needs_auth', message)
    return back({ error: message })
  }
}
