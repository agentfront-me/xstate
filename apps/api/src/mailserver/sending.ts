// Outbound sending limits and abuse suspension.
//
// Every customer's outside mail leaves through one Amazon SES account. SES reviews the account at about a 5% bounce
// rate or a 0.1% complaint rate and can pause it, which would stop mail for everyone. Two defences:
//
// 1. Caps. email_send counts outside recipients (mail between xstate domains stays on Stalwart and isn't counted)
//    per mailbox and per organization, per hour and per day (LIMITS), and refuses past them. Mail apps that send
//    over SMTP never reach the API; Stalwart's own throttles cap them (scripts/stalwart-limits.sh).
// 2. Suspension. After each SES bounce or complaint, the mailbox's and organization's last 7 days are checked
//    against SUSPEND, well below SES's own thresholds. A suspended mailbox (or every mailbox of a suspended
//    organization) is refused by email_send, and its Stalwart account loses its sending permissions, which also
//    blocks SMTP. Reading mail keeps working.
//
// D1 (sending_suspensions) is the source of truth; syncSendingBlocks makes Stalwart match it, right after a
// suspension and from the hourly cron. To lift one, set lifted_at (see docs/stalwart-api.md); the next hourly run
// gives the accounts their sending back.

import * as sendingDb from '../db/sending'
import type { MailboxRow } from '../db/mailboxes'
import { isAdmin, loadMember } from './access'
import { EmailError, forbidden } from './errors'
import { calendarOverLimit, judge, LIMITS, overLimit, SUSPEND } from './sending-rules'
import { setSendingBlocked } from './stalwart/accounts'
import type { Actor, EmailEnv } from './types'

const SUPPORT = 'support@xstate.io'

/**
 * Reserves `outside` recipients against the caps before a send, or throws: 403 sending_suspended, 429
 * send_limit_reached. Call the returned release() if the send then fails, so it doesn't count.
 */
export async function reserveSend(
  env: EmailEnv,
  mailbox: Pick<MailboxRow, 'id' | 'organization_id'>,
  recipients: string[],
): Promise<{ release: () => Promise<void> }> {
  const db = env.DB
  const outside = await countOutside(db, recipients)
  const now = Date.now()
  const id = crypto.randomUUID()
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()

  // One batch runs as one transaction: two sends at the same moment can't both slip under the cap.
  const [suspended, , used] = await db.batch([
    sendingDb.activeFor(db, mailbox.organization_id, mailbox.id),
    outside ? sendingDb.logSend(db, { id, organizationId: mailbox.organization_id, mailboxId: mailbox.id, recipients: outside, createdAt: new Date(now).toISOString() }) : db.prepare('SELECT 1'),
    sendingDb.usage(db, mailbox.organization_id, mailbox.id, hourAgo, dayAgo),
  ])
  const release = async () => {
    if (outside) await db.batch([sendingDb.unlogSend(db, id)]).catch((err) => console.error('sending: release failed', err))
  }

  const suspension = (suspended!.results as sendingDb.SuspensionRow[])[0]
  if (suspension) {
    await release()
    const who = suspension.mailbox_id ? 'This mailbox' : 'Your organization'
    throw new EmailError(
      'sending_suspended',
      `${who} can't send mail right now because too much of its recent mail ${suspension.reason === 'complaints' ? 'was marked as spam' : 'bounced'}. ` +
        `Contact ${SUPPORT} to have it reviewed.`,
      403,
    )
  }

  const u = (used!.results as sendingDb.Usage[])[0]!
  const over = overLimit(u)
  if (over) {
    await release()
    throw new EmailError('send_limit_reached', `Sending limit reached: at most ${over}. Try again later.`, 429)
  }
  return { release }
}

/**
 * Reserves invitation emails (invites, updates, cancellations, answers: one per recipient, internal ones included)
 * against CALENDAR_LIMITS before a calendar change, or throws 429 invite_limit_reached. Stalwart would otherwise drop
 * them past its throttles without the API knowing. Call release() if the change then fails.
 */
export async function reserveCalendarSends(
  env: EmailEnv,
  mailbox: Pick<MailboxRow, 'id' | 'organization_id'>,
  recipients: string[],
): Promise<{ release: () => Promise<void> }> {
  const db = env.DB
  const id = crypto.randomUUID()
  const now = Date.now()
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString()
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const unique = [...new Set(recipients.map((r) => r.toLowerCase()))]

  // One batch is one transaction: two changes at the same moment can't both slip under the cap.
  const [, used] = await db.batch([
    sendingDb.logCalendarSends(db, { id, organizationId: mailbox.organization_id, mailboxId: mailbox.id, recipients: unique, createdAt: new Date(now).toISOString() }),
    sendingDb.calendarUsage(db, mailbox.id, unique, hourAgo, dayAgo),
  ])
  const release = async () => {
    await db.batch([sendingDb.unlogCalendarSends(db, id)]).catch((err) => console.error('calendar: release failed', err))
  }
  const over = calendarOverLimit((used!.results as sendingDb.CalendarUsage[])[0]!)
  if (over) {
    await release()
    throw new EmailError(
      'invite_limit_reached',
      `Invitation limit reached: at most ${over}. Save without emailing guests, or try again later.`,
      429,
    )
  }
  return { release }
}

/** How many of these addresses are outside xstate: their domain isn't one of ours, so the mail goes through SES. */
async function countOutside(db: D1Database, recipients: string[]): Promise<number> {
  const domains = recipients.map((r) => r.slice(r.lastIndexOf('@') + 1).toLowerCase())
  const { results } = await db
    .prepare('SELECT name FROM domains WHERE name IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(domains)]))
    .all<{ name: string }>()
  const ours = new Set(results.map((r) => r.name))
  return domains.filter((d) => !ours.has(d)).length
}

/** This organization's caps, what it used in the last hour and day, and its active suspensions. Owners and admins. */
export async function sendingStatus(env: EmailEnv, actor: Actor, organizationId: string) {
  if (!isAdmin(await loadMember(env, organizationId, actor.userId))) throw forbidden('Only owners and admins can see sending status')
  const now = Date.now()
  const [used, suspensions] = await Promise.all([
    sendingDb
      .usage(env.DB, organizationId, null, new Date(now - 3600_000).toISOString(), new Date(now - 86_400_000).toISOString())
      .first<sendingDb.Usage>(),
    sendingDb.listActive(env.DB, organizationId),
  ])
  return {
    limits: LIMITS,
    used: { hour: used?.orgHour ?? 0, day: used?.orgDay ?? 0 },
    suspensions: suspensions.map((s) => ({
      mailboxId: s.mailbox_id,
      reason: s.reason,
      detail: s.detail,
      since: s.created_at,
    })),
  }
}

/**
 * After a bounce or complaint: suspends the mailbox, or its whole organization, when the last 7 days cross SUSPEND.
 * Returns what was suspended, if anything.
 */
export async function evaluateSender(env: EmailEnv, organizationId: string, mailboxId: string): Promise<'mailbox' | 'organization' | null> {
  const since = new Date(Date.now() - SUSPEND.days * 86_400_000).toISOString()
  const [orgRep, boxRep] = await Promise.all([
    sendingDb.reputation(env.DB, organizationId, null, since),
    sendingDb.reputation(env.DB, organizationId, mailboxId, since),
  ])
  const org = judge(orgRep, SUSPEND.organization)
  const box = org ? null : judge(boxRep, SUSPEND.mailbox)
  const verdict = org ?? box
  if (!verdict) return null

  const scope = org ? 'organization' : 'mailbox'
  const added = await sendingDb.suspend(env.DB, {
    id: crypto.randomUUID(),
    organizationId,
    mailboxId: org ? null : mailboxId,
    reason: verdict.reason,
    detail: verdict.detail,
    createdAt: new Date().toISOString(),
  })
  if (!added) return null
  console.warn(`sending: SUSPENDED ${scope} ${org ? organizationId : mailboxId} (org ${organizationId}): ${verdict.detail}`)
  await syncSendingBlocks(env).catch((err) => console.error('sending: blocking in Stalwart failed; the hourly run retries', err))
  return scope
}

/**
 * Makes Stalwart match sending_suspensions: turns sending off for user accounts under an active suspension and back
 * on for those no longer under one. Shared mailboxes have no sign-in of their own, so only the API blocks them.
 */
export async function syncSendingBlocks(env: EmailEnv): Promise<{ blocked: number; unblocked: number; failed: number }> {
  const db = env.DB
  const [want, have] = await Promise.all([sendingDb.accountsToBlock(db), sendingDb.blockedAccounts(db)])
  const wanted = new Map(want.map((a) => [a.stalwart_id, a.organization_id]))
  const current = new Set(have)
  const now = new Date().toISOString()
  const result = { blocked: 0, unblocked: 0, failed: 0 }

  for (const [stalwartId, organizationId] of wanted) {
    if (current.has(stalwartId)) continue
    try {
      const outcome = await setSendingBlocked(env, stalwartId, true)
      if (outcome === 'admin') console.warn(`sending: not blocking administrator account ${stalwartId} in Stalwart (API still refuses it)`)
      await db.batch([sendingDb.addBlock(db, stalwartId, organizationId, now)])
      result.blocked++
    } catch (err) {
      console.error(`sending: blocking ${stalwartId} failed`, err)
      result.failed++
    }
  }
  for (const stalwartId of current) {
    if (wanted.has(stalwartId)) continue
    try {
      await setSendingBlocked(env, stalwartId, false)
      await db.batch([sendingDb.removeBlock(db, stalwartId)])
      result.unblocked++
    } catch (err) {
      console.error(`sending: unblocking ${stalwartId} failed`, err)
      result.failed++
    }
  }
  return result
}

/** Hourly: keep Stalwart in line with the suspensions table, and drop counters nothing reads any more. */
export async function sendingHourly(env: EmailEnv): Promise<void> {
  const now = Date.now()
  await sendingDb.prune(env.DB, new Date(now - 2 * 86_400_000).toISOString(), new Date(now - 30 * 86_400_000).toISOString().slice(0, 10))
  const sync = await syncSendingBlocks(env)
  if (sync.blocked || sync.unblocked || sync.failed) console.log('sending-sync', JSON.stringify(sync))
}
