// Password hashing with PBKDF2-SHA256 from Web Crypto. Stored as `pbkdf2-sha256$<iterations>$<salt>$<hash>`
// (base64), so the iteration count can be raised later without breaking existing hashes.

// The most Workers' Web Crypto allows for PBKDF2.
const ITERATIONS = 100_000
const SALT_BYTES = 16
const HASH_BITS = 256

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(password, salt, ITERATIONS)
  return `pbkdf2-sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split('$')
  if (scheme !== 'pbkdf2-sha256' || !iterations || !salt || !hash) return false
  const expected = fromBase64(hash)
  const actual = await derive(password, fromBase64(salt), Number(iterations))
  return actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected)
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BITS)
  return new Uint8Array(bits)
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
}
