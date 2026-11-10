// Encryption at rest for AI provider keys and organization secrets: AES-GCM under a key derived from
// API_KEYS_ENCRYPTION_KEY (the same setting as audience/keys.ts, with its own HKDF label so the two never share a key).
// Stored as base64 of iv (12 bytes) + ciphertext.

import { ApiError } from '../errors'

let cached: { secret: string; key: Promise<CryptoKey> } | null = null

function aesKey(env: Pick<Env, 'API_KEYS_ENCRYPTION_KEY'>): Promise<CryptoKey> {
  const secret = env.API_KEYS_ENCRYPTION_KEY
  if (!secret) throw new ApiError('keys_not_configured', 'Encryption is not configured on this server', 503)
  if (cached?.secret === secret) return cached.key
  const key = crypto.subtle
    .importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey'])
    .then((material) =>
      crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('xstate agents v1') },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      ),
    )
  cached = { secret, key }
  return key
}

export async function seal(env: Pick<Env, 'API_KEYS_ENCRYPTION_KEY'>, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(plain)))
  const out = new Uint8Array(iv.length + sealed.length)
  out.set(iv)
  out.set(sealed, iv.length)
  let binary = ''
  for (const byte of out) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function unseal(env: Pick<Env, 'API_KEYS_ENCRYPTION_KEY'>, stored: string): Promise<string> {
  const bytes = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0))
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aesKey(env), bytes.slice(12))
  return new TextDecoder().decode(plain)
}
