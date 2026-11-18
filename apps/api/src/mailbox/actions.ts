// What a change to a message does in a mailbox whose mail the store holds (docs/mailbox-store-plan.md, phase 2
// step 2): which messages it touches and how, with the same rules as Stalwart mailboxes (mailserver/stalwart/mail.ts
// updateThreadOf). No runtime imports, so `pnpm test` runs it directly under Node. The store applies the plan.

import type { StoreFolderRole } from './query'

/** A change from email_update_message: one message, or with `thread` its conversation. */
export type StoreUpdate = {
  id: string
  seen?: boolean
  pinned?: boolean
  folder?: StoreFolderRole
  thread?: boolean
  /** A move the system makes (an infected message to Junk), not a person: it doesn't teach the spam filter. */
  system?: boolean
}

/** A message of the conversation as the store has it. */
export type UpdateRow = { n: number; id: string; folder: StoreFolderRole | null; seen: boolean; pinned: boolean }

/** What changes for one message; only the fields that actually differ. */
export type RowChange = { n: number; seen?: boolean; pinned?: boolean; folder?: StoreFolderRole }

/**
 * The changes for `update`, given the chosen message's conversation (`rows`; just the message without `thread`):
 * `seen` applies to the whole conversation, a move only to its messages in the same folder as the chosen one (so
 * archiving from the Inbox leaves sent replies in Sent), and `pinned` only to the chosen message. Null when the
 * chosen message isn't among the rows.
 */
export function planUpdate(rows: UpdateRow[], update: StoreUpdate): RowChange[] | null {
  const chosen = rows.find((r) => r.id === update.id)
  if (!chosen) return null
  const changes: RowChange[] = []
  for (const r of update.thread ? rows : [chosen]) {
    const c: RowChange = { n: r.n }
    if (update.seen !== undefined && r.seen !== update.seen) c.seen = update.seen
    if (r === chosen && update.pinned !== undefined && r.pinned !== update.pinned) c.pinned = update.pinned
    if (update.folder && r.folder === chosen.folder && r.folder !== update.folder) c.folder = update.folder
    if (c.seen !== undefined || c.pinned !== undefined || c.folder) changes.push(c)
  }
  return changes
}

/** Messages stay in Trash this long, then are deleted for good. */
export const TRASH_DAYS = 30
