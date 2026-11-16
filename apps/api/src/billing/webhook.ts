// POST /webhooks/paddle: Paddle's notifications for this environment's destination, signed with
// PADDLE_WEBHOOK_SECRET. Subscription events are mirrored onto the organization (service.applySubscription), which
// is idempotent and ignores reports older than the stored one, so retries and out-of-order deliveries are safe.
// Anything but a 2xx makes Paddle retry (live: for about 3 days), so failures answer 500.

import type { Context } from 'hono'
import { verifySignature, type PaddleSubscription } from './paddle'
import { applySubscription, type BillingEnv } from './service'

type PaddleEvent = { event_id: string; event_type: string; occurred_at: string; data: unknown }

export async function handlePaddleWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env as unknown as BillingEnv
  const raw = await c.req.text()
  const signature = c.req.header('Paddle-Signature') ?? ''
  if (!env.PADDLE_WEBHOOK_SECRET) {
    console.error('billing webhook: PADDLE_WEBHOOK_SECRET is not set')
    return c.json({ error: { code: 'not_configured', message: 'Billing is not set up' } }, 503)
  }
  if (!(await verifySignature(env.PADDLE_WEBHOOK_SECRET, signature, raw))) {
    return c.json({ error: { code: 'bad_signature', message: 'Signature does not match' } }, 401)
  }
  let event: PaddleEvent
  try {
    event = JSON.parse(raw) as PaddleEvent
  } catch {
    return c.json({ error: { code: 'invalid_json', message: 'Body is not JSON' } }, 400)
  }
  try {
    if (event.event_type.startsWith('subscription.')) {
      const organizationId = await applySubscription(env, event.data as PaddleSubscription, event.occurred_at)
      console.log('billing webhook', JSON.stringify({ event: event.event_type, id: event.event_id, organizationId }))
    }
    return c.json({ received: true })
  } catch (err) {
    console.error('billing webhook failed', event.event_type, event.event_id, err)
    return c.json({ error: { code: 'internal', message: 'Could not process the event' } }, 500)
  }
}
