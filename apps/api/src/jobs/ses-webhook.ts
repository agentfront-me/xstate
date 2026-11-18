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
// - Mail sent through POST /v1/emails also has a row per recipient in the send log; every event updates that
//   recipient's status (emails/service.ts recordDeliveryEvent), which is what GET /v1/emails/:id reports.
// - When an event suspends the sender, the owners and admins get an email saying so (emails/notices.ts).
//
// Handles SES identity notifications ("notificationType") and configuration-set events ("eventType").

import type { Context } from 'hono'
import * as addressesDb from '../db/addresses'
import * as mailboxesDb from '../db/mailboxes'
import { store } from '../mailbox/stub'
import * as eventsDb from '../db/email-events'
import * as sendingDb from '../db/sending'
import { notifySuspension } from '../emails/notices'
import { recordDeliveryEvent } from '../emails/service'
import { evaluateSender } from '../mailserver'
import { isSnsUrl, verifySnsMessage, type SnsMessage } from './sns'

type SesNotification = {
  notificationType?: string
  eventType?: string
  /** `commonHeaders` is only there when the notifications are set to include the original headers. */
  mail?: { messageId?: string; source?: string; timestamp?: string; commonHeaders?: { messageId?: string } }
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
  // Our own Message-ID, when SES passes it on: the surest way to find the message in the API's send log.
  const ourMessageId = n.mail?.commonHeaders?.messageId?.replace(/^<|>$/g, '') || null
  /** Best effort: the send log is a report, and must never make SNS redeliver an event that was recorded. */
  const logStatus = (status: 'delivered' | 'bounced' | 'complained', list: { address: string; detail: string | null }[]) =>
    Promise.all(list.map((r) => recordDeliveryEvent(c.env, { kind: status, sender, recipient: r.address, messageId: ourMessageId, detail: r.detail }))).catch(
      (err) => console.error('ses-webhook: updating the send log failed', err),
    )

  if (kind === 'delivery') {
    await logStatus('delivered', (n.delivery?.recipients ?? []).map((address) => ({ address, detail: null })))
    await logToStore(c.env, owner?.mailbox_id ?? null, 'ses_delivered', n.mail?.messageId ?? null, (n.delivery?.recipients ?? []).map((address) => ({ address, detail: null })))
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
  await logStatus(kind === 'bounce' ? 'bounced' : 'complained', recipients)
  await logToStore(c.env, owner?.mailbox_id ?? null, kind === 'bounce' ? 'bounced' : 'complained', n.mail?.messageId ?? null, recipients, subtype)

  // Suspend the sender if this pushed it over the line. A failure here mustn't make SNS redeliver the event.
  let suspended: string | null = null
  if (owner) {
    suspended = await evaluateSender(c.env, owner.organization_id, owner.mailbox_id).catch((err) => {
      console.error('ses-webhook: evaluating sender failed', err)
      return null
    })
  }
  if (owner && (suspended === 'mailbox' || suspended === 'organization')) {
    c.executionCtx.waitUntil(
      notifySuspension(c.env, owner.organization_id, owner.mailbox_id, suspended).catch((err) => console.error('ses-webhook: suspension email failed', err)),
    )
  }
  return c.json({ recorded: recipients.length, kind, suspended })
}

/**
 * Adds an SES event to the sending mailbox's delivery log when the store holds its mail (mailbox/store.ts), matched
 * to the Sent copy by SES's message id. Best effort: the event is recorded in D1 either way.
 */
async function logToStore(
  env: Env,
  mailboxId: string | null,
  step: 'ses_delivered' | 'bounced' | 'complained',
  sesId: string | null,
  recipients: { address: string; detail: string | null }[],
  subtype: string | null = null,
): Promise<void> {
  if (!mailboxId || !sesId || !recipients.length) return
  try {
    const mailbox = await mailboxesDb.find(env.DB, mailboxId)
    if (mailbox?.backend !== 'store') return
    await (await store(env, mailbox.id)).logDelivery(
      recipients.map((r) => ({ step, sesId, address: r.address, detail: { ...(r.detail && { detail: r.detail }), ...(subtype && { type: subtype }) } })),
    )
  } catch (err) {
    console.error('ses-webhook: delivery log failed', err)
  }
}
