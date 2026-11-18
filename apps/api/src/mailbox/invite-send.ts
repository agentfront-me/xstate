// Sending invitations, updates, cancellations and answers from a store-held mailbox (docs/mailbox-store-plan.md,
// phase 3b). ./scheduling.ts decides what a change means for whom; this builds each email (./ical-out.ts, ./invite-mail.ts, ./compose.ts) and sends it through
// SES. The caps and suppressed addresses were already checked by mailserver/calendar.ts (withSendingCaps). There is
// no Sent copy; each recipient gets a `sent` line in the delivery log.

import type { MailboxRow } from '../db/mailboxes'
import { mailto } from '../mailserver/calendar-events'
import type { EmailEnv } from '../mailserver/types'
import { buildMessage } from './compose'
import { buildIcs } from './ical-out'
import { ulid } from './inbound'
import { inviteText, methodOf } from './invite-mail'
import { participantOf, type InviteEmail } from './scheduling'
import { sendRaw, type SendEnv } from './ses-send'
import { store } from './stub'

/** Sends the emails, one per entry, and logs each recipient. Throws if SES refuses one. */
export async function sendInvites(env: EmailEnv, mailbox: MailboxRow, emails: InviteEmail[], own: string[]): Promise<void> {
  const stub = await store(env, mailbox.id)
  for (const email of emails) {
    const method = methodOf(email.kind)
    const me = participantOf(email.event, own)
    const from = { name: me?.name ?? mailbox.display_name ?? null, email: mailbox.address }
    const who = method === 'REPLY' ? { name: from.name, email: from.email } : undefined
    const ics = buildIcs({ method, event: email.event, replyFrom: mailto(me?.calendarAddress) ?? mailbox.address, occurrence: email.occurrence })
    const text = inviteText(email.kind, email.event, { occurrence: email.occurrence, who })
    const names = new Map(Object.values(email.event.participants ?? {}).map((p) => [mailto(p.calendarAddress), p.name ?? null]))
    const raw = buildMessage({
      from,
      to: email.to.map((address) => ({ name: names.get(address) ?? null, email: address })),
      subject: text.subject,
      text: text.text,
      html: text.html,
      messageId: `${ulid()}@${mailbox.address.split('@')[1]}`,
      date: new Date(),
      calendar: { method, ics },
    })
    const sesId = await sendRaw(env as EmailEnv & SendEnv, { from: mailbox.address, to: email.to, cc: [], bcc: [], raw })
    await stub.logDelivery(
      email.to.map((address) => ({
        step: 'sent' as const,
        sesId,
        address,
        detail: { invite: method.toLowerCase(), kind: email.kind, uid: email.event.uid ?? null, ...(email.occurrence && { occurrence: email.occurrence }), size: raw.length },
      })),
    )
  }
}
