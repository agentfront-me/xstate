// POST /webhooks/ses: Amazon SES bounce and complaint notifications, delivered by SNS (topic in SES_SNS_TOPIC_ARNS).
//
// - SubscriptionConfirmation: confirmed by fetching SNS's SubscribeURL, once the signature checks out.
// - Notification: an SES bounce or complaint. Recorded in email_events against the sending mailbox. A permanent
//   bounce suppresses the address for everyone (it doesn't exist); a complaint suppresses it for the sending
//   organization. email_send then refuses those recipients with a clear error instead of sending more bounces.
// - Delivery: counted per sending mailbox per day (delivery_counts), the denominator for bounce and complaint rates.
// - After a bounce or complaint, the sender's last 7 days are checked and the mailbox or its whole organization is
//   suspended when they cross the thresholds in mailserver/sending.ts.
//
// Handles SES identity notifications ("notificationType") and configuration-set events ("eventType").

import type { Context } from 'hono'
import * as addressesDb from '../db/addresses'
import * as eventsDb from '../db/email-events'
import * as sendingDb from '../db/sending'
import { evaluateSender } from '../mailserver'
import { isSnsUrl, verifySnsMessage, type SnsMessage } from './sns'

type SesNotification = {
  notificationType?: string
  eventType?: string
  mail?: { messageId?: string; source?: string; timestamp?: string }
  bounce?: {
    bounceType?: string
    bounceSubType?: string
    bouncedRecipients?: { emailAddress: string; diagnosticCode?: string }[]
    timestamp?: string
  }
  delivery?: { recipients?: string[]; timestamp?: string }
  complaint?: { complainedRecipients?: { emailAddress: string }[]; complaintFeedbackType?: string; timestamp?: string }
}

export async function handleSesWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  let message: SnsMessage
  try {
    message = JSON.parse(await c.req.text()) as SnsMessage
  } catch {
    return c.json({ error: { code: 'invalid_json', message: 'Body is not JSON' } }, 400)
  }
  const topics = (c.env.SES_SNS_TOPIC_ARNS ?? '').split(',').map((t) => t.trim()).filter(Boolean)
  if (!topics.includes(message.TopicArn)) {
    return c.json({ error: { code: 'unknown_topic', message: 'Topic not accepted' } }, 403)
  }
  if (!(await verifySnsMessage(message).catch(() => false))) {
    return c.json({ error: { code: 'invalid_signature', message: 'SNS signature did not verify' } }, 401)
  }

  if (message.Type === 'SubscriptionConfirmation') {
    if (!isSnsUrl(message.SubscribeURL)) return c.json({ error: { code: 'invalid_subscribe_url', message: 'Bad SubscribeURL' } }, 400)
    const res = await fetch(message.SubscribeURL!)
    console.log(`ses-webhook: confirmed subscription to ${message.TopicArn} (${res.status})`)
    return c.json({ confirmed: res.ok }, res.ok ? 200 : 502)
  }
  if (message.Type !== 'Notification') return c.json({ ignored: message.Type })

  let n: SesNotification
  try {
    n = JSON.parse(message.Message) as SesNotification
  } catch {
    return c.json({ ignored: 'not an SES notification' })
  }
  const kind = (n.notificationType ?? n.eventType ?? '').toLowerCase()
  if (kind !== 'bounce' && kind !== 'complaint' && kind !== 'delivery') return c.json({ ignored: kind || 'unknown' })

  const sender = (n.mail?.source ?? '').toLowerCase()
  const owner = sender ? await addressesDb.findByAddress(c.env.DB, sender) : null

  if (kind === 'delivery') {
    // A notification SNS redelivers is counted twice; that only makes rates look slightly better, never worse.
    const count = n.delivery?.recipients?.length ?? 0
    if (!owner || !count) return c.json({ ignored: 'delivery from an unknown sender' })
    const day = (n.delivery?.timestamp ?? new Date().toISOString()).slice(0, 10)
    await c.env.DB.batch([
      sendingDb.addDelivered(c.env.DB, { mailboxId: owner.mailbox_id, organizationId: owner.organization_id, day, count }),
    ])
    return c.json({ recorded: count, kind })
  }
  const now = new Date().toISOString()
  const writes: D1PreparedStatement[] = []

  const recipients =
    kind === 'bounce'
      ? (n.bounce?.bouncedRecipients ?? []).map((r) => ({ address: r.emailAddress, detail: r.diagnosticCode ?? null }))
      : (n.complaint?.complainedRecipients ?? []).map((r) => ({ address: r.emailAddress, detail: n.complaint?.complaintFeedbackType ?? null }))
  const subtype = kind === 'bounce' ? (n.bounce?.bounceType ?? null) : (n.complaint?.complaintFeedbackType ?? null)

  recipients.forEach((r, i) => {
    writes.push(
      eventsDb.insertEvent(c.env.DB, {
        id: recipients.length > 1 ? `${message.MessageId}:${i}` : message.MessageId,
        organizationId: owner?.organization_id ?? null,
        mailboxId: owner?.mailbox_id ?? null,
        type: kind,
        subtype,
        sender,
        recipient: r.address.toLowerCase(),
        detail: r.detail,
        sesMessageId: n.mail?.messageId ?? null,
        createdAt: now,
      }),
    )
    // Transient bounces (mailbox full, greylisting) are recorded but don't stop future mail.
    if (kind === 'bounce' && n.bounce?.bounceType === 'Permanent') {
      writes.push(eventsDb.suppress(c.env.DB, { address: r.address, organizationId: '', reason: 'bounce', detail: r.detail, createdAt: now }))
    }
    if (kind === 'complaint' && owner) {
      writes.push(
        eventsDb.suppress(c.env.DB, { address: r.address, organizationId: owner.organization_id, reason: 'complaint', detail: r.detail, createdAt: now }),
      )
    }
  })
  if (writes.length) await c.env.DB.batch(writes)

  // Suspend the sender if this pushed it over the line. A failure here mustn't make SNS redeliver the event.
  let suspended: string | null = null
  if (owner) {
    suspended = await evaluateSender(c.env, owner.organization_id, owner.mailbox_id).catch((err) => {
      console.error('ses-webhook: evaluating sender failed', err)
      return null
    })
  }
  return c.json({ recorded: recipients.length, kind, suspended })
}
