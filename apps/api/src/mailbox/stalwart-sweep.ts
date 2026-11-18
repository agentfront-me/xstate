// Mail and invitations Stalwart delivered inside itself to a store-held mailbox's old account, moved into the store
// (docs/mailbox-store-plan.md, "Mail from Stalwart mailboxes to store-held ones"). Until Stalwart's routing rule
// (mailserver/stalwart/routing.ts) covers a domain, mail to it from Stalwart mailboxes lands there instead of going
// out through SES. Run hourly: each mailbox remembers how far it has got, messages the store already has (same
// Message-ID) are skipped, and the rest are delivered as received mail (mailbox/receive.ts deliverSwept). Sent,
// Drafts and Trash are left alone.

import * as mailboxesDb from '../db/mailboxes'
import * as stalwartMail from '../mailserver/stalwart/mail'
import { sweepStalwartCalendar } from './calendar-store'
import { deliverSwept, type ReceiveEnv } from './receive'
import { store } from './stub'

/** Folders whose mail is received mail. */
const RECEIVED_ROLES = new Set(['inbox', 'junk', 'archive'])
/** The first sweep of a mailbox starts here: before any mailbox moved to the store. */
const BEGINNING = '2026-11-01T00:00:00Z'

export type SweepResult = { mailboxes: number; swept: number; skipped: number; events: number; failed: number }

export async function sweepHeld(env: ReceiveEnv): Promise<SweepResult> {
  const result: SweepResult = { mailboxes: 0, swept: 0, skipped: 0, events: 0, failed: 0 }
  for (const { id } of await mailboxesDb.heldByStore(env.DB)) {
    const mailbox = await mailboxesDb.find(env.DB, id)
    if (!mailbox?.stalwart_id) continue
    result.mailboxes++
    try {
      const stub = await store(env, mailbox.id)
      const accountId = mailbox.stalwart_id
      const folders = (await stalwartMail.getFolders(env, [accountId])).get(accountId) ?? []
      const received = folders.filter((f) => !f.role || RECEIVED_ROLES.has(f.role)).map((f) => f.id)
      const since = (await stub.sweptUntil()) ?? BEGINNING
      const found = await stalwartMail.receivedSince(env, accountId, received, since)
      const known = new Set(await stub.knownMessageIds(found.flatMap((m) => m.messageId ?? [])))
      let until = since
      for (const m of found) {
        if (m.messageId?.some((id) => known.has(id))) {
          result.skipped++
        } else {
          const res = await stalwartMail.downloadBlob(env, accountId, m.blobId, 'message.eml', 'message/rfc822')
          const raw = new Uint8Array(await res.arrayBuffer())
          const delivered = await deliverSwept(env, mailbox, raw, { accountId, emailId: m.id, receivedAt: m.receivedAt, source: m.from?.[0]?.email ?? null })
          if (delivered.duplicate) result.skipped++
          else result.swept++
        }
        if (m.receivedAt > until) until = m.receivedAt
      }
      if (until !== since) await stub.sweptUntil(until)
      result.events += await sweepStalwartCalendar(env, mailbox)
    } catch (err) {
      result.failed++
      console.error(`stalwart-sweep for ${id} failed`, err)
    }
  }
  return result
}
