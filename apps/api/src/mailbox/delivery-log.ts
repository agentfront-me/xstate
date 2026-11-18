// The delivery log (docs/mailbox-store-plan.md, phase 2 step 4d): what support reads to answer "where is my email"
// for mailboxes whose mail the store holds. Each mailbox's store keeps one line per step its messages took (received
// and where it went, scanned, sent, delivered, bounced, complained, refused); received mail that reached no mailbox
// is in D1 (`mail_drops`). Ids, addresses and outcomes only, never content; both are kept 30 days. Owners and admins
// only, like the sending status.

import * as dropsDb from '../db/mail-drops'
import * as mailboxesDb from '../db/mailboxes'
import { loadMember, isAdmin } from '../mailserver/access'
import { EmailError, forbidden } from '../mailserver/errors'
import type { Actor, EmailEnv } from '../mailserver/types'
import type { DeliveryLine, DeliveryStep } from './store'
import { store } from './stub'

/** Delivery-log lines and drops are kept this long. */
export const DELIVERY_LOG_DAYS = 30

export type DeliveryLogEntry = {
  at: string
  /** The mailbox the line is from; null for mail that reached no mailbox. */
  mailboxId: string | null
  mailbox: string | null
  step: DeliveryStep | 'dropped'
  emailId: string | null
  sesId: string | null
  /** The other party: the sender of received mail, a recipient of sent mail, or the address a drop was for. */
  address: string | null
  detail: Record<string, unknown>
}

export async function deliveryLog(
  env: EmailEnv,
  actor: Actor,
  organizationId: string,
  input: { mailboxId?: string; query?: string; limit: number },
): Promise<{ entries: DeliveryLogEntry[] }> {
  if (!isAdmin(await loadMember(env, organizationId, actor.userId))) throw forbidden('Only owners and admins can read the delivery log')
  const query = input.query?.trim() || null
  const held = (await mailboxesDb.heldByStore(env.DB)).filter((m) => m.organization_id === organizationId)
  let mailboxIds = held.map((m) => m.id)
  if (input.mailboxId) {
    const mailbox = await mailboxesDb.find(env.DB, input.mailboxId)
    if (!mailbox || mailbox.organization_id !== organizationId) throw new EmailError('mailbox_not_found', 'Mailbox not found', 404)
    // Only mailboxes on the new mail path have a delivery log.
    mailboxIds = mailboxIds.filter((id) => id === mailbox.id)
  }

  const fromStores = await Promise.all(
    mailboxIds.map(async (id) => {
      const mailbox = await mailboxesDb.find(env.DB, id)
      // Plain JSON across the RPC; its typing can't carry `Record<string, unknown>`, so it is restated here.
      const lines = (await (await store(env, id)).deliveryLog(query, input.limit)) as unknown as (DeliveryLine & { at: string })[]
      return lines.map((l): DeliveryLogEntry => ({ ...l, mailboxId: id, mailbox: mailbox?.address ?? null, emailId: l.emailId ?? null, sesId: l.sesId ?? null, address: l.address ?? null, detail: l.detail ?? {} }))
    }),
  )
  // Drops belong to no mailbox: shown when the whole organization is asked for.
  const drops = input.mailboxId
    ? []
    : (await dropsDb.list(env.DB, organizationId, query, input.limit)).map(
        (d): DeliveryLogEntry => ({
          at: d.at.replace(/\.\d{3}Z$/, 'Z'),
          mailboxId: null,
          mailbox: null,
          step: 'dropped',
          emailId: null,
          sesId: d.ses_id,
          address: d.recipient,
          detail: { reason: d.reason, from: d.sender },
        }),
      )
  const entries = [...fromStores.flat(), ...drops].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, input.limit)
  return { entries }
}
