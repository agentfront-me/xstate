// The parts of app passwords that need no database: what one looks like and how it is hashed. See
// auth/app-passwords.ts for the rest.

/** Active app passwords one person may have in one organization. */
export const MAX_APP_PASSWORDS = 20

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const LENGTH = 16

/** 16 random lowercase letters (75 bits): easy to type on a phone, far too many to guess. */
export function newAppPassword(): string {
  // Two random bytes per letter keep the modulo bias negligible (65536 % 26 = 16).
  const bytes = crypto.getRandomValues(new Uint16Array(LENGTH))
  return Array.from(bytes, (b) => LETTERS[b % LETTERS.length]).join('')
}

/** How it is shown, once: four groups of four. */
export const formatAppPassword = (password: string) => password.match(/.{4}/g)!.join('-')

/**
 * What was typed, as stored: people copy it with the dashes, or type it with spaces or capitals. null when it can't
 * be an app password, so the database isn't asked.
 */
export function normalizeAppPassword(typed: string): string | null {
  const letters = typed.replace(/[\s-]/g, '').toLowerCase()
  return /^[a-z]{16}$/.test(letters) ? letters : null
}

export async function hashAppPassword(password: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
