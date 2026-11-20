// The part of an email address before the @, as xstate accepts it for new mailboxes and addresses.

/** Letters, numbers, dots, dashes and underscores, starting and ending with a letter or number. */
export const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

export const isLocalPart = (value: string) => LOCAL_PART_RE.test(value) && !value.includes('..')

/** What someone typed as an address name: lower case, spaces as dots. */
export const localOf = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '.')

/** Suggests a mailbox name from a full name: "Jordan Lee" → "jordan". Empty when nothing usable is left. */
export function localPartFromName(name: string | null | undefined): string {
  return localOf((name ?? '').trim().split(/\s+/)[0] ?? '')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/^[._-]+|[._-]+$/g, '')
}
