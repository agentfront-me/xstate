// POST /webhooks/billing/:provider: the payment provider's notifications. The provider's own file checks the
// signature and turns the delivery into neutral BillingEvents (./provider.ts); subscriptions are mirrored onto the
// organization (service.applySubscription, idempotent and ordered, so retries and out-of-order deliveries are safe)
// and payments feed xstate's own analytics (./analytics.ts) after the response.
// Anything but a 2xx makes the provider retry, so failures answer 500.

import type { Context } from 'hono'
import { recordPayment } from './analytics'
import { providerFor, WebhookRejected } from './provider'
import { applySubscription, type BillingEnv } from './service'

export async function handleBillingWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env as unknown as BillingEnv
  const provider = providerFor(env)
  if (!provider || provider.name !== c.req.param('provider')) {
    return c.json({ error: { code: 'not_configured', message: 'Billing is not set up for this provider' } }, 404)
  }
  let events
  try {
    events = await provider.verifyWebhook(c.req.raw)
  } catch (err) {
    if (err instanceof WebhookRejected) return c.json({ error: { code: 'rejected', message: err.message } }, err.status)
    console.error('billing webhook: verification failed', err)
    return c.json({ error: { code: 'internal', message: 'Could not read the event' } }, 500)
  }
  const background = (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise)
  for (const event of events) {
    try {
      if (event.kind === 'subscription') {
        const organizationId = await applySubscription(env, provider.name, event.subscription, background)
        console.log('billing webhook', JSON.stringify({ provider: provider.name, id: event.id, organizationId }))
      } else {
        background(recordPayment(env, background, provider.name, event))
      }
    } catch (err) {
      console.error('billing webhook failed', provider.name, event.id, err)
      return c.json({ error: { code: 'internal', message: 'Could not process the event' } }, 500)
    }
  }
  return c.json({ received: true })
}
