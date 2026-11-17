// POST /webhooks/ses-inbound: Amazon SES received a message for a domain whose MX points at it, and SNS (topic in
// SES_INBOUND_TOPIC_ARN) says so (docs/mailbox-store-plan.md, phase 2 step 1).
//
// - SubscriptionConfirmation: confirmed by fetching SNS's SubscribeURL, once the signature checks out.
// - Notification: an SES "Received" notification, queued on MAIL_IN for mailbox/receive.ts. Answered at once; SNS
//   retries anything that doesn't get a 2xx.
//
// Local development (SES_MODE "fake", never in production) skips the topic and signature checks, so
// scripts/mail-in-fake.mjs can post a made-up notification that carries a small message itself.

import type { Context } from 'hono'
import { inboundJob, type InboundJob } from '../mailbox/inbound'
import { isSnsUrl, verifySnsMessage, type SnsMessage } from './sns'

export async function handleSesInbound(c: Context<{ Bindings: Env }>): Promise<Response> {
  let message: SnsMessage
  try {
    message = JSON.parse(await c.req.text()) as SnsMessage
  } catch {
    return c.json({ error: { code: 'invalid_json', message: 'Body is not JSON' } }, 400)
  }
  const fake = (c.env.SES_MODE as string) === 'fake' && (c.env.ENVIRONMENT as string) !== 'production'
  if (!fake) {
    const topic = c.env.SES_INBOUND_TOPIC_ARN
    if (!topic) return c.json({ error: { code: 'not_configured', message: 'Receiving is not set up' } }, 404)
    if (message.TopicArn !== topic) return c.json({ error: { code: 'unknown_topic', message: 'Topic not accepted' } }, 403)
    if (!(await verifySnsMessage(message).catch(() => false))) {
      return c.json({ error: { code: 'invalid_signature', message: 'SNS signature did not verify' } }, 401)
    }
  }

  if (message.Type === 'SubscriptionConfirmation') {
    if (!isSnsUrl(message.SubscribeURL)) return c.json({ error: { code: 'invalid_subscribe_url', message: 'Bad SubscribeURL' } }, 400)
    const res = await fetch(message.SubscribeURL!)
    console.log(`ses-inbound: confirmed subscription to ${message.TopicArn} (${res.status})`)
    return c.json({ confirmed: res.ok }, res.ok ? 200 : 502)
  }
  if (message.Type !== 'Notification') return c.json({ ignored: message.Type })

  let job: InboundJob | null = null
  try {
    job = inboundJob(JSON.parse(message.Message))
  } catch {
    // not JSON: ignored below
  }
  if (!job) return c.json({ ignored: 'not a received message' })
  if (!job.content && !(job.bucket && job.key)) {
    // A message too large to carry and not saved anywhere: the receipt rule is missing its S3 action.
    console.error('ses-inbound: notification without the message or its S3 location', job.sesId)
    return c.json({ ignored: 'no message' })
  }
  await c.env.MAIL_IN.send(job)
  return c.json({ queued: job.sesId })
}
