// Where a copied Gmail message goes, and the date-range search. Pure functions (tested in mail-rules.test.ts).

import type { FolderRole } from '../mailserver/stalwart/mail'

const SYSTEM_FOLDERS: Record<string, FolderRole> = { INBOX: 'inbox', SENT: 'sent', DRAFT: 'drafts', SPAM: 'junk', TRASH: 'trash' }

export type Placement = { skip: string } | { folders: (FolderRole | { label: string })[]; keywords: string[] }

/**
 * Gmail labels → xstate folders and keywords:
 * - INBOX, SENT, DRAFT, SPAM, TRASH → Inbox, Sent, Drafts, Junk, Trash. Spam and trash win over everything else,
 *   so a deleted message doesn't also show in the inbox.
 * - User labels → folders of the same (nested) name; a message with several is in several folders.
 * - No folder label at all (archived) → Archive.
 * - UNREAD → no $seen; STARRED → $flagged; DRAFT → $draft. IMPORTANT and CATEGORY_* tabs are dropped.
 * - Chat messages are skipped.
 */
export function placement(labelIds: string[], userLabels: Set<string>): Placement {
  if (labelIds.includes('CHAT')) return { skip: 'chat' }
  const keywords = [
    ...(labelIds.includes('UNREAD') ? [] : ['$seen']),
    ...(labelIds.includes('STARRED') ? ['$flagged'] : []),
    ...(labelIds.includes('DRAFT') ? ['$draft'] : []),
  ]
  if (labelIds.includes('TRASH')) return { folders: ['trash'], keywords }
  if (labelIds.includes('SPAM')) return { folders: ['junk'], keywords }
  const folders: (FolderRole | { label: string })[] = []
  for (const id of labelIds) {
    if (SYSTEM_FOLDERS[id]) folders.push(SYSTEM_FOLDERS[id])
    else if (userLabels.has(id)) folders.push({ label: id })
  }
  return { folders: folders.length ? folders : ['archive'], keywords }
}

/** Gmail's date-range search for the plan's mail range, or undefined for all mail. */
export function rangeQuery(range: 'all' | '5y' | '3y' | '1y', now = new Date()): string | undefined {
  if (range === 'all') return undefined
  const years = Number(range[0])
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()))
  return `after:${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}
