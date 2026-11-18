// Email from xstate itself (invites), not from a customer's mailbox. It's sent like any other message, from the
// xstate mailbox whose address is SYSTEM_MAIL_FROM (for example no-reply@xstate.com, a mailbox in xstate's own
// organization), so it goes out through SES with that domain's DKIM and lands in its Sent folder (mailbox/outbound.ts).
//
// When SYSTEM_MAIL_FROM is empty or isn't an xstate mailbox, nothing is sent and callers are told so: local dev
// and new environments keep working, and the caller decides what to show instead.

import * as addressesDb from '../db/addresses'
import * as mailboxesDb from '../db/mailboxes'
import { ulid } from '../mailbox/inbound'
import { sendFromStore, type OutboundEnv } from '../mailbox/outbound'
import type { EmailEnv } from './types'

export type SystemMailEnv = EmailEnv & Pick<Env, 'SYSTEM_MAIL_FROM'>

export type SystemMessage = {
  to: { name: string | null; email: string }
  replyTo?: { name: string | null; email: string }
  subject: string
  text: string
  html: string
}

export type SystemMailResult = { sent: true } | { sent: false; reason: string }

/** The name people see on xstate's own mail. */
const FROM_NAME = 'xstate'

export async function sendSystemEmail(env: SystemMailEnv, message: SystemMessage): Promise<SystemMailResult> {
  const from = env.SYSTEM_MAIL_FROM?.trim().toLowerCase()
  if (!from) return { sent: false, reason: 'SYSTEM_MAIL_FROM is not set' }
  const address = await addressesDb.findByAddress(env.DB, from)
  const mailbox = address && (await mailboxesDb.find(env.DB, address.mailbox_id))
  if (!mailbox) return { sent: false, reason: `${from} is not an xstate mailbox` }
  // Sent as the API sends (it already allows a Reply-To and a chosen name); the Sent copy is kept.
  await sendFromStore(
    env as OutboundEnv,
    mailbox,
    {
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      api: {
        from: { email: from, name: FROM_NAME },
        ...(message.replyTo && { replyTo: [message.replyTo] }),
        messageId: `${ulid()}@${from.split('@')[1]}`,
        keepCopy: true,
      },
    },
    { recipients: [message.to], fromEmail: from, fromName: FROM_NAME },
  )
  return { sent: true }
}
