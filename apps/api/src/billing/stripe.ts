// Stripe behind BillingProvider (./provider.ts). REST calls with fetch (no SDK), Checkout for buying, the Customer
// Portal for invoices, the card and cancelling, and webhooks checked with Stripe-Signature (./stripe-events.ts).
//
// Prices are found by lookup key (xstate_growth_base, xstate_growth_extra_100; scripts/billing-catalog.mjs), so test
// and live mode need no price ids in config. Secrets: STRIPE_SECRET_KEY (sk_test_… / sk_live_…) and
// STRIPE_WEBHOOK_SECRET (whsec_…, the endpoint's signing secret).

import { ProviderError, WebhookRejected, type BillingEvent, type BillingProvider, type OrgForBilling, type Subscription } from './provider'
import { extraItem, formEncode, isXstate, LOOKUP, STRIPE_VERSION, toEvents, toSubscription, verifyStripeSignature, type StripeEvent, type StripeSubscription } from './stripe-events'

export type StripeEnv = { STRIPE_SECRET_KEY?: string; STRIPE_WEBHOOK_SECRET?: string }

const API = 'https://api.stripe.com/v1'

/** Cached per isolate: the price ids and portal configuration don't change while a Worker runs. */
let prices: { key: string; base: string; extra: string } | null = null
let portalConfig: { key: string; id: string | null } | null = null

export function stripeProvider(env: StripeEnv): BillingProvider | null {
  const secret = env.STRIPE_SECRET_KEY
  // "off" (or any placeholder) keeps billing unavailable until a real key is set.
  if (!secret?.startsWith('sk_')) return null

  async function call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params?: Record<string, unknown>): Promise<T> {
    const body = params ? formEncode(params) : ''
    const url = method === 'POST' || !body ? `${API}${path}` : `${API}${path}?${body}`
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${secret}`, 'Stripe-Version': STRIPE_VERSION, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: method === 'POST' ? body : undefined,
    })
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
    if (!res.ok) throw new ProviderError(res.status, json?.error?.message ?? `Stripe answered ${res.status}`)
    return json as T
  }

  async function priceIds(): Promise<{ base: string; extra: string }> {
    if (prices && prices.key === secret) return { base: prices.base, extra: prices.extra }
    const list = await call<{ data: { id: string; lookup_key: string }[] }>('GET', '/prices', {
      lookup_keys: [LOOKUP.base, LOOKUP.extra],
      active: 'true',
    })
    const base = list.data.find((p) => p.lookup_key === LOOKUP.base)?.id
    const extra = list.data.find((p) => p.lookup_key === LOOKUP.extra)?.id
    if (!base || !extra) throw new ProviderError(500, 'Stripe has no Growth prices yet: run scripts/billing-catalog.mjs')
    prices = { key: secret!, base, extra }
    return { base, extra }
  }

  /** The portal configuration billing-catalog.mjs made (metadata xstate=growth); null falls back to the default. */
  async function portalConfiguration(): Promise<string | null> {
    if (portalConfig && portalConfig.key === secret) return portalConfig.id
    const list = await call<{ data: { id: string; active: boolean; metadata?: Record<string, string> } [] }>('GET', '/billing_portal/configurations', {
      limit: 100,
    })
    const id = list.data.find((c) => c.active && c.metadata?.xstate === 'growth')?.id ?? null
    portalConfig = { key: secret!, id }
    return id
  }

  const getSub = (id: string) => call<StripeSubscription>('GET', `/subscriptions/${id}`)

  return {
    name: 'stripe',

    async checkout(org: OrgForBilling, extraHundreds, urls) {
      const ids = await priceIds()
      // Stripe fills in {CHECKOUT_SESSION_ID}; the app routes in the hash, so it goes in the query before it.
      const [path = urls.success, hash = ''] = urls.success.split('#')
      const success = `${path}${path.includes('?') ? '&' : '?'}checkout_session={CHECKOUT_SESSION_ID}${hash ? `#${hash}` : ''}`
      const items: { price: string; quantity: number }[] = [{ price: ids.base, quantity: 1 }]
      if (extraHundreds > 0) items.push({ price: ids.extra, quantity: extraHundreds })
      const session = await call<{ url: string }>('POST', '/checkout/sessions', {
        mode: 'subscription',
        line_items: items,
        success_url: success,
        cancel_url: urls.cancel,
        client_reference_id: org.id,
        ...(org.customerId ? { customer: org.customerId } : org.ownerEmail ? { customer_email: org.ownerEmail } : {}),
        metadata: { organizationId: org.id },
        subscription_data: { metadata: { organizationId: org.id }, description: `xstate Growth for ${org.name}` },
        allow_promotion_codes: 'true',
      })
      return { url: session.url }
    },

    async confirmCheckout(sessionId) {
      const session = await call<{ client_reference_id: string | null; subscription: string | null; status: string }>(
        'GET',
        `/checkout/sessions/${encodeURIComponent(sessionId)}`,
      )
      if (!session.subscription) return { organizationId: session.client_reference_id, subscription: null }
      const sub = toSubscription(await getSub(session.subscription), new Date().toISOString())
      return { organizationId: session.client_reference_id, subscription: { ...sub, organizationId: sub.organizationId ?? session.client_reference_id } }
    },

    async portal(customerId, returnUrl) {
      const configuration = await portalConfiguration()
      const session = await call<{ url: string }>('POST', '/billing_portal/sessions', {
        customer: customerId,
        return_url: returnUrl,
        ...(configuration ? { configuration } : {}),
      })
      return { url: session.url }
    },

    async setExtraHundreds(subscriptionId, extraHundreds): Promise<Subscription> {
      const ids = await priceIds()
      const item = extraItem(await getSub(subscriptionId))
      // Charged or credited now, on an invoice of its own.
      const proration = { proration_behavior: 'always_invoice' }
      if (extraHundreds > 0 && item) await call('POST', `/subscription_items/${item.id}`, { quantity: extraHundreds, ...proration })
      else if (extraHundreds > 0) await call('POST', '/subscription_items', { subscription: subscriptionId, price: ids.extra, quantity: extraHundreds, ...proration })
      else if (item) await call('DELETE', `/subscription_items/${item.id}`, proration)
      return toSubscription(await getSub(subscriptionId), new Date().toISOString())
    },

    async getSubscription(subscriptionId) {
      return toSubscription(await getSub(subscriptionId), new Date().toISOString())
    },

    async verifyWebhook(request): Promise<BillingEvent[]> {
      if (!env.STRIPE_WEBHOOK_SECRET?.startsWith('whsec_')) throw new WebhookRejected(401, 'STRIPE_WEBHOOK_SECRET is not set')
      const payload = await request.text()
      const ok = await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, request.headers.get('Stripe-Signature') ?? '', payload)
      if (!ok) throw new WebhookRejected(401, 'Signature does not match')
      let event: StripeEvent
      try {
        event = JSON.parse(payload) as StripeEvent
      } catch {
        throw new WebhookRejected(400, 'Body is not JSON')
      }
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object as { client_reference_id: string | null; subscription: string | null }
        if (!session.subscription) return []
        const raw = await getSub(session.subscription)
        // The account also sells other products; only xstate Growth checkouts matter here.
        if (!isXstate(raw)) return []
        const sub = toSubscription(raw, new Date(event.created * 1000).toISOString())
        return [{ kind: 'subscription', id: event.id, subscription: { ...sub, organizationId: sub.organizationId ?? session.client_reference_id } }]
      }
      return toEvents(event)
    },
  }
}
