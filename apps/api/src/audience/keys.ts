// The organization's Publishable Key and Secret Key (migrations/0012_api_keys.sql). One pair per organization, used
// by every public API that acts for the organization: audience tracking today, sending email later.

import { ApiError } from '../errors'

export type KeyRow = {
  organization_id: string
  publishable_key: string
  secret_hash: string
  secret_encrypted: string
  secret_last4: string
  created_at: string
  secret_rolled_at: string
  secret_last_used_at: string | null
}

/** What the dashboard shows. The secret key itself only comes back from reveal and roll. */
export type ApiKeys = {
  publishable: { key: string; createdAt: string }
  secret: { masked: string; createdAt: string; lastUsedAt: string | null }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

function randomToken(length: number): string {
  // Two random bytes per character keep the modulo bias negligible (65536 % 57 = 49).
  const bytes = crypto.getRandomValues(new Uint16Array(length))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

const newPublishable = () => `pk_live_${randomToken(32)}`
const newSecret = () => `sk_live_${randomToken(40)}`

export const isPublishable = (key: string) => /^pk_(live|test)_[A-Za-z0-9]{20,64}$/.test(key)
export const isSecret = (key: string) => /^sk_(live|test)_[A-Za-z0-9]{20,64}$/.test(key)

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------------------------------------------
// Encryption of the secret key at rest

async function aesKey(env: Env): Promise<CryptoKey> {
  const secret = env.API_KEYS_ENCRYPTION_KEY
  if (!secret) throw new ApiError('keys_not_configured', 'API keys are not configured on this server', 503)
  // Any string works as the setting: it's stretched to a 256-bit AES key.
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('xstate api keys v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function encrypt(env: Env, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(plain)))
  const out = new Uint8Array(iv.length + sealed.length)
  out.set(iv)
  out.set(sealed, iv.length)
  return btoa(String.fromCharCode(...out))
}

async function decrypt(env: Env, stored: string): Promise<string> {
  const bytes = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0))
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aesKey(env), bytes.slice(12))
  return new TextDecoder().decode(plain)
}

// ---------------------------------------------------------------------------------------------------------------
// Rows

const mask = (last4: string) => `sk_live_${'•'.repeat(24)}${last4}`

export function present(row: KeyRow): ApiKeys {
  return {
    publishable: { key: row.publishable_key, createdAt: row.created_at },
    secret: { masked: mask(row.secret_last4), createdAt: row.secret_rolled_at, lastUsedAt: row.secret_last_used_at },
  }
}

async function find(db: D1Database, organizationId: string): Promise<KeyRow | null> {
  return db.prepare('SELECT * FROM api_keys WHERE organization_id = ?').bind(organizationId).first<KeyRow>()
}

/** The organization's keys, created on first use. */
export async function ensure(env: Env, organizationId: string): Promise<KeyRow> {
  const existing = await find(env.DB, organizationId)
  if (existing) return existing
  const secret = newSecret()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO api_keys (organization_id, publishable_key, secret_hash, secret_encrypted, secret_last4, created_at, secret_rolled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (organization_id) DO NOTHING`,
  )
    .bind(organizationId, newPublishable(), await sha256Hex(secret), await encrypt(env, secret), secret.slice(-4), now, now)
    .run()
  // Another request may have created them at the same moment: read back whichever row won.
  return (await find(env.DB, organizationId))!
}

export async function revealSecret(env: Env, organizationId: string): Promise<string> {
  return decrypt(env, (await ensure(env, organizationId)).secret_encrypted)
}

/** Replaces the secret key. The old one stops working at once (cached lookups expire within a minute). */
export async function rollSecret(env: Env, organizationId: string): Promise<{ keys: ApiKeys; secret: string }> {
  await ensure(env, organizationId)
  const secret = newSecret()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE api_keys SET secret_hash = ?, secret_encrypted = ?, secret_last4 = ?, secret_rolled_at = ?, secret_last_used_at = NULL
     WHERE organization_id = ?`,
  )
    .bind(await sha256Hex(secret), await encrypt(env, secret), secret.slice(-4), now, organizationId)
    .run()
  secretCache.clear()
  return { keys: present((await find(env.DB, organizationId))!), secret }
}

// ---------------------------------------------------------------------------------------------------------------
// Lookups for the public endpoints. Cached per isolate for a minute so a busy site doesn't hit D1 on every event.

type Cached<T> = { value: T; until: number }
const TTL = 60_000
const publishableCache = new Map<string, Cached<{ organizationId: string; secret: string } | null>>()
const secretCache = new Map<string, Cached<{ organizationId: string; secret: string } | null>>()

function cached<T>(cache: Map<string, Cached<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.until > Date.now()) return Promise.resolve(hit.value)
  return load().then((value) => {
    if (cache.size > 5000) cache.clear()
    cache.set(key, { value, until: Date.now() + TTL })
    return value
  })
}

/** The organization a publishable key belongs to, with its secret key (to check identify() hashes). */
export function byPublishable(env: Env, key: string) {
  if (!isPublishable(key)) return Promise.resolve(null)
  return cached(publishableCache, key, async () => {
    const row = await env.DB.prepare('SELECT * FROM api_keys WHERE publishable_key = ?').bind(key).first<KeyRow>()
    return row ? { organizationId: row.organization_id, secret: await decrypt(env, row.secret_encrypted) } : null
  })
}

/** The organization a secret key belongs to. Records when the key was last used (at most once a minute). */
export async function bySecret(env: Env, key: string) {
  if (!isSecret(key)) return null
  const hash = await sha256Hex(key)
  return cached(secretCache, hash, async () => {
    const row = await env.DB.prepare('SELECT * FROM api_keys WHERE secret_hash = ?').bind(hash).first<KeyRow>()
    if (!row) return null
    await env.DB.prepare('UPDATE api_keys SET secret_last_used_at = ? WHERE organization_id = ?').bind(new Date().toISOString(), row.organization_id).run()
    return { organizationId: row.organization_id, secret: key }
  })
}

/** identify() from a browser must carry HMAC-SHA256(secret key, userId) as hex, made on the customer's server. */
export async function verifyUserHash(secret: string, userId: string, hash: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(hash)) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(userId)))
  const given = Uint8Array.from(hash.match(/../g)!, (h) => parseInt(h, 16))
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected)
}
