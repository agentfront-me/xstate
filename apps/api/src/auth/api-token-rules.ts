// The parts of personal API tokens that need no database: what a token looks like, how it is hashed, when it
// expires and what state it is in. See auth/api-tokens.ts for the rest.

/** What a token may do. One for now; a later API adds a scope, not a new kind of token. */
export const TOKEN_SCOPES = ['mail.send'] as const
export type TokenScope = (typeof TOKEN_SCOPES)[number]

export const TOKEN_PREFIX = 'xst_live_'
/** Active tokens one person may have in one organization. */
export const MAX_TOKENS = 20
/** How long before it ends the owner is emailed. */
export const EXPIRY_NOTICE_DAYS = 7

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

export function newToken(): string {
  // Two random bytes per character keep the modulo bias negligible (65536 % 57 = 49).
  const bytes = crypto.getRandomValues(new Uint16Array(40))
  return TOKEN_PREFIX + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

/** Cheap check before the database is asked: anything else can't be a token. */
export const isToken = (value: string) => /^xst_live_[A-Za-z0-9]{40}$/.test(value)

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** How a token is shown after it was created: never the token itself. */
export const maskToken = (last4: string) => `${TOKEN_PREFIX}…${last4}`

export const EXPIRES_IN = ['30d', '90d', '1y', 'never'] as const
export type ExpiresIn = (typeof EXPIRES_IN)[number]

const DAYS: Record<ExpiresIn, number | null> = { '30d': 30, '90d': 90, '1y': 365, never: null }

export function expiryDate(choice: ExpiresIn, now: Date): string | null {
  const days = DAYS[choice]
  return days === null ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * - active: works.
 * - inactive: its owner can no longer write to any of its mailboxes. Works again if access comes back.
 * - expired, revoked: over for good.
 */
export type TokenState = 'active' | 'inactive' | 'expired' | 'revoked'

export function tokenState(
  token: { revoked_at: string | null; expires_at: string | null },
  usableMailboxes: number,
  now: Date,
): TokenState {
  if (token.revoked_at) return 'revoked'
  if (token.expires_at && token.expires_at <= now.toISOString()) return 'expired'
  return usableMailboxes > 0 ? 'active' : 'inactive'
}
