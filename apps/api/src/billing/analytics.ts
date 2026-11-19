// Money events for xstate's own analytics (docs/analytics-events.md), from the provider's payment webhooks turned into
// neutral BillingEvents (./provider.ts): "Order Completed" (the only event with revenue), "Payment Failed" and
// "Order Refunded". They are recorded for the organization's owner.
//
// Providers may deliver an event more than once, so each payment and refund is recorded once (analytics_sent, D1
// migration 0044). Amounts arrive in minor units less tax; revenue is sent in major units.

import { track, type Background } from '../analytics/events'
import { growthSize, type Plan } from './plans'
import type { BillingEvent } from './provider'
import type { BillingEnv } from './service'

type Payment = Extract<BillingEvent, { kind: 'payment' }>
type Org = { id: string; owner_id: string; plan: Plan; extra_hundreds: number | null }

/** Never throws: analytics mustn't make the provider retry. */
export async function recordPayment(env: BillingEnv, background: Background, provider: string, event: Payment): Promise<void> {
  try {
    const org = await orgOf(env, provider, event)
    if (!org) return
    const size = org.plan === 'growth' ? growthSize(org.extra_hundreds ?? 0) : null
    if (event.status === 'paid') {
      if (event.amount <= 0 || !(await firstTime(env, `${provider}:${event.paymentId}:completed`))) return
      track(env, background, org.owner_id, org.id, 'Order Completed', {
        revenue: event.amount / 100,
        currency: event.currency.toUpperCase(),
        plan: org.plan === 'free' ? null : org.plan,
        size,
        billing_reason: event.reason,
        transaction_id: event.paymentId,
      })
    } else if (event.status === 'failed') {
      track(env, background, org.owner_id, org.id, 'Payment Failed', { plan: org.plan, size })
    } else if (event.status === 'refunded') {
      if (event.amount <= 0 || !(await firstTime(env, `${provider}:${event.id}:refund`))) return
      track(env, background, org.owner_id, org.id, 'Order Refunded', {
        refund_amount: event.amount / 100,
        currency: event.currency.toUpperCase(),
        transaction_id: event.paymentId,
        full_refund: event.fullRefund,
      })
    }
  } catch (err) {
    console.error('analytics: payment event', provider, event.id, err)
  }
}

async function orgOf(env: BillingEnv, provider: string, event: Payment): Promise<Org | null> {
  const columns = 'id, owner_id, plan, extra_hundreds'
  if (event.organizationId) {
    const org = await env.DB.prepare(`SELECT ${columns} FROM organizations WHERE id = ?`).bind(event.organizationId).first<Org>()
    if (org) return org
  }
  if (event.subscriptionId) {
    const org = await env.DB.prepare(`SELECT ${columns} FROM organizations WHERE billing_provider = ? AND billing_subscription_id = ?`)
      .bind(provider, event.subscriptionId)
      .first<Org>()
    if (org) return org
  }
  if (!event.customerId) return null
  return env.DB.prepare(`SELECT ${columns} FROM organizations WHERE billing_provider = ? AND billing_customer_id = ?`)
    .bind(provider, event.customerId)
    .first<Org>()
}

/** Claims `key`; false when it was claimed before, or when the table isn't there (no event beats a double count). */
async function firstTime(env: BillingEnv, key: string): Promise<boolean> {
  try {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO analytics_sent (key, created_at) VALUES (?, ?)').bind(key, new Date().toISOString()).run()
    return r.meta.changes > 0
  } catch (err) {
    console.error('analytics: analytics_sent unavailable (apply D1 migration 0044)', err)
    return false
  }
}
