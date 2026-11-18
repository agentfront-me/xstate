// Email activity in the audience (docs/analytics-plan.md, phase 3): mail between the organization's mailboxes and
// people already in the audience becomes events on those people: $email_received, $email_replied (received, and
// an answer in a thread: it has In-Reply-To), $email_sent, $email_bounced, $email_complained. Funnels can mix them
// with website events ("Support email to order").
//
// Recorded from the mail-events queue (mailbox/events.ts) for received and sent mail, and from the SES webhook for
// bounces and complaints. Nothing is recorded for mail in Junk, mail with a virus, or mail copied in by an import.
// Events name the mailbox and the address, never the subject or the body, and only members who can read that
// mailbox see them (AudienceStore.listEvents). Never fails the caller: a lost event is logged.

import type { EmailActivity } from './types'

export async function recordEmailActivity(env: Pick<Env, 'AUDIENCE'>, organizationId: string, activity: EmailActivity): Promise<number> {
  if (!activity.addresses.length) return 0
  try {
    return await env.AUDIENCE.get(env.AUDIENCE.idFromName(organizationId)).recordEmail(activity)
  } catch (err) {
    console.error('audience: email activity failed', JSON.stringify({ kind: activity.kind, mailboxId: activity.mailboxId }), err)
    return 0
  }
}

/** The addresses on the other side of a message: who sent it (received) or who it went to (sent). */
export function counterparts(
  direction: 'in' | 'out',
  message: { from: { email: string }[]; to?: { email: string }[]; cc?: { email: string }[]; bcc?: { email: string }[] },
  own: string[],
): string[] {
  const mine = new Set(own.map((a) => a.toLowerCase()))
  const list = direction === 'in' ? message.from : [...(message.to ?? []), ...(message.cc ?? []), ...(message.bcc ?? [])]
  return [...new Set(list.map((a) => a.email.trim().toLowerCase()).filter((a) => a && !mine.has(a)))]
}
