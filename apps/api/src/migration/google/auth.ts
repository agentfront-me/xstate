// Access tokens for Google APIs through domain-wide delegation: xstate's service account signs a JWT that names
// the Workspace user to act as (`sub`) and the scopes, and Google trades it for a one-hour token, but only if the
// customer's admin added our client ID with those scopes (Admin console → Security → API controls → Domain-wide
// delegation). Signed with WebCrypto (RS256); tokens are cached per isolate until five minutes before expiry.
//
// The key is the service account's JSON key file, stored whole as the GOOGLE_MIGRATION_KEY secret.

/** The service account key is an optional secret (not in wrangler.jsonc's required list), so it's typed here. */
export type GoogleKeyEnv = { GOOGLE_MIGRATION_KEY?: string }

export type ServiceAccount = { clientEmail: string; clientId: string; privateKey: CryptoKey }

/** Why Google refused a token or a call. `status` is Google's HTTP status. */
export type GoogleErrorCode = 'not_configured' | 'not_authorized' | 'no_such_user' | 'rate_limited' | 'forbidden' | 'not_found' | 'google_error' | 'too_large'

export class GoogleError extends Error {
  readonly code: GoogleErrorCode
  readonly status: number
  constructor(code: GoogleErrorCode, message: string, status = 0) {
    super(message)
    this.name = 'GoogleError'
    this.code = code
    this.status = status
  }
}

let account: { raw: string; value: Promise<ServiceAccount> } | null = null

export function serviceAccount(env: GoogleKeyEnv): Promise<ServiceAccount> {
  const raw = env.GOOGLE_MIGRATION_KEY
  if (!raw) throw new GoogleError('not_configured', 'Google import is not set up on this server (GOOGLE_MIGRATION_KEY is missing)')
  if (account?.raw !== raw) account = { raw, value: parseKey(raw) }
  return account.value
}

async function parseKey(raw: string): Promise<ServiceAccount> {
  let json: { client_email?: string; client_id?: string; private_key?: string }
  try {
    json = JSON.parse(raw)
  } catch {
    throw new GoogleError('not_configured', 'GOOGLE_MIGRATION_KEY is not a service account JSON key')
  }
  if (!json.client_email || !json.client_id || !json.private_key) {
    throw new GoogleError('not_configured', 'GOOGLE_MIGRATION_KEY is missing client_email, client_id or private_key')
  }
  const der = Uint8Array.from(atob(json.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0))
  const privateKey = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  return { clientEmail: json.client_email, clientId: json.client_id, privateKey }
}

const tokens = new Map<string, { token: string; expires: number }>()

/** A token to act as `subject` (a Workspace user's email) with `scopes`. */
export async function accessToken(env: GoogleKeyEnv, subject: string, scopes: readonly string[]): Promise<string> {
  const cacheKey = `${subject}|${scopes.join(' ')}`
  const cached = tokens.get(cacheKey)
  if (cached && cached.expires > Date.now() + 5 * 60_000) return cached.token

  const sa = await serviceAccount(env)
  const now = Math.floor(Date.now() / 1000)
  const assertion = await signJwt(sa.privateKey, {
    iss: sa.clientEmail,
    sub: subject,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string }
  if (!res.ok || !body.access_token) {
    // unauthorized_client: our client ID isn't in the domain's delegation list with (all of) these scopes.
    if (body.error === 'unauthorized_client') {
      throw new GoogleError('not_authorized', 'Domain-wide delegation for xstate is missing, or lacks one of these scopes', res.status)
    }
    // invalid_grant: usually no such user in a domain that trusts us (or a suspended one).
    if (body.error === 'invalid_grant') throw new GoogleError('no_such_user', `Google won't let xstate act as ${subject}: ${body.error_description ?? ''}`.trim(), res.status)
    throw new GoogleError('google_error', `Google token request failed (HTTP ${res.status}): ${body.error_description ?? body.error ?? ''}`, res.status)
  }
  tokens.set(cacheKey, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 })
  return body.access_token
}

async function signJwt(key: CryptoKey, claims: Record<string, unknown>): Promise<string> {
  const enc = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))
  const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}`
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input))
  return `${input}.${base64url(new Uint8Array(signature))}`
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** GET a Google API as `token`. Retries twice on rate limits and server errors, then throws GoogleError. */
export async function googleGet<T>(token: string, url: string | URL, options: { maxBytes?: number } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (res.ok) {
      // Too big to hold: say so before reading the body (the caller decides what to do with the item).
      const length = Number(res.headers.get('Content-Length') ?? 0)
      if (options.maxBytes && length > options.maxBytes) {
        await res.body?.cancel()
        throw new GoogleError('too_large', `${length} bytes`, 200)
      }
      return (await res.json()) as T
    }
    const text = await res.text()
    const rateLimited = res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(text))
    if ((rateLimited || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500))
      continue
    }
    if (rateLimited) throw new GoogleError('rate_limited', 'Google is limiting how fast xstate can read. Try again in a minute.', res.status)
    if (res.status === 403) throw new GoogleError('forbidden', `Google refused: ${text.slice(0, 200)}`, res.status)
    if (res.status === 404) throw new GoogleError('not_found', `Google returned 404 for ${String(url).split('?')[0]}`, res.status)
    throw new GoogleError('google_error', `Google returned HTTP ${res.status}: ${text.slice(0, 200)}`, res.status)
  }
}
