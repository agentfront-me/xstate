// Email from xstate itself (invites), not from a customer's mailbox. It's sent through Stalwart like any other
// message, from the xstate mailbox whose address is SYSTEM_MAIL_FROM (for example no-reply@xstate.io, a mailbox
// in xstate's own organization), so it goes out through SES with that domain's DKIM and lands in its Sent folder.
//
// When SYSTEM_MAIL_FROM is empty or isn't an xstate mailbox, nothing is sent and callers are told so: local dev
// and new environments keep working, and the caller decides what to show instead.

import * as addressesDb from '../db/addresses'
import * as mailboxesDb from '../db/mailboxes'
import * as jmap from './stalwart/mail'
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
  const accountId = mailbox.stalwart_id

  const [folders, identities] = await Promise.all([
    jmap.getFolders(env, [accountId]).then((m) => m.get(accountId) ?? []),
    jmap.getIdentities(env, accountId),
  ])
  const draftsId = folders.find((f) => f.role === 'drafts')?.id
  const sentId = folders.find((f) => f.role === 'sent')?.id
  if (!draftsId || !sentId) return { sent: false, reason: `${from} has no Drafts or Sent folder` }
  const identityId =
    identities.find((i) => i.email.toLowerCase() === from)?.id ?? (await jmap.createIdentity(env, accountId, { name: FROM_NAME, email: from }))

  await jmap.submitEmail(env, accountId, {
    identityId,
    draftsId,
    sentId,
    email: {
      from: [{ name: FROM_NAME, email: from }],
      to: [message.to],
      ...(message.replyTo && { replyTo: [message.replyTo] }),
      subject: message.subject,
      bodyStructure: {
        type: 'multipart/alternative',
        subParts: [
          { partId: 'text', type: 'text/plain' },
          { partId: 'html', type: 'text/html' },
        ],
      },
      bodyValues: { text: { value: message.text }, html: { value: message.html } },
    },
  })
  return { sent: true }
}
