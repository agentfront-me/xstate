// Money events for xstate's own analytics (docs/analytics-events.md), from Paddle's transaction and adjustment
// webhooks: "Order Completed" (the only event with revenue), "Payment Failed" and "Order Refunded". They are
// recorded for the organization's owner.
//
// Paddle may deliver an event more than once, so each payment and refund is recorded once (analytics_sent, D1
// migration 0044). Amounts arrive as strings in minor units; revenue is the total less tax, in major units.

import { track, type Background } from '../analytics/events'
import { getTransaction } from './paddle'
import { planOfPrice, priceIds } from './plans'
import type { BillingEnv } from './service'

type Totals = { subtotal?: string; discount?: string; tax?: string; total?: string }

type PaddleTransactionEvent = {
  id: string
  status: string
  origin?: string
  subscription_id: string | null
  currency_code?: string
  custom_data: Record<string, unknown> | null
  items?: { price: { id: string } | null; quantity: number }[]
  details?: { totals?: Totals } | null
}

type PaddleAdjustmentEvent = {
  id: string
  action: string
  type?: 'full' | 'partial'
  status: string
  transaction_id: string
  subscription_id: string | null
  currency_code?: string
  totals?: Totals | null
}

type Org = { id: string; owner_id: string; plan: 'free' | 'pro' | 'team'; billing_interval: 'month' | 'year' | null; billed_seats: number | null }

/** Handles the transaction and adjustment events. Never throws: analytics mustn't make Paddle retry. */
export async function recordMoneyEvent(env: BillingEnv, background: Background, eventType: string, data: unknown): Promise<void> {
  try {
    if (eventType === 'transaction.completed') await orderCompleted(env, background, data as PaddleTransactionEvent)
    else if (eventType === 'transaction.payment_failed') await paymentFailed(env, background, data as PaddleTransactionEvent)
    else if (eventType === 'adjustment.created' || eventType === 'adjustment.updated') await orderRefunded(env, background, data as PaddleAdjustmentEvent)
  } catch (err) {
    console.error('analytics: paddle event', eventType, err)
  }
}

async function orderCompleted(env: BillingEnv, background: Background, txn: PaddleTransactionEvent): Promise<void> {
  const totals = txn.details?.totals
  const revenue = minor(totals?.total) - minor(totals?.tax)
  if (revenue <= 0) return
  const org = await orgOf(env, txn.custom_data, txn.subscription_id)
  if (!org || !(await firstTime(env, `paddle:${txn.id}:completed`))) return
  const ids = priceIds(env.PADDLE_PRICES)
  const item = txn.items?.find((i) => i.price)
  const priced = ids && item?.price ? planOfPrice(ids, item.price.id) : null
  track(env, background, org.owner_id, org.id, 'Order Completed', {
    revenue: revenue / 100,
    currency: (txn.currency_code ?? 'USD').toUpperCase(),
    plan: priced?.plan ?? null,
    interval: priced?.interval ?? null,
    seats: item?.quantity ?? null,
    billing_reason: reasonOf(txn.origin),
    transaction_id: txn.id,
  })
}

async function paymentFailed(env: BillingEnv, background: Background, txn: PaddleTransactionEvent): Promise<void> {
  const org = await orgOf(env, txn.custom_data, txn.subscription_id)
  if (!org) return
  track(env, background, org.owner_id, org.id, 'Payment Failed', { plan: org.plan, interval: org.billing_interval, seats: org.billed_seats })
}

async function orderRefunded(env: BillingEnv, background: Background, adj: PaddleAdjustmentEvent): Promise<void> {
  // Refunds wait for Paddle's approval (adjustment.updated); credits are approved when created.
  if (adj.action !== 'refund' || adj.status !== 'approved') return
  const amount = minor(adj.totals?.total) - minor(adj.totals?.tax)
  if (amount <= 0) return
  // A refund names its transaction; one outside a subscription is traced through it to the organization.
  let org = await orgOf(env, null, adj.subscription_id)
  if (!org) {
    const txn = await getTransaction(env, adj.transaction_id).catch(() => null)
    if (txn) org = await orgOf(env, txn.custom_data, txn.subscription_id)
  }
  if (!org || !(await firstTime(env, `paddle:${adj.id}:refund`))) return
  track(env, background, org.owner_id, org.id, 'Order Refunded', {
    refund_amount: amount / 100,
    currency: (adj.currency_code ?? 'USD').toUpperCase(),
    transaction_id: adj.transaction_id,
    full_refund: adj.type === 'full',
  })
}

/** Paddle's origin: a first checkout, a renewal, or a mid-period change (seats or plan, prorated). */
function reasonOf(origin: string | undefined): 'new' | 'renewal' | 'change' | 'other' {
  if (origin === 'web') return 'new'
  if (origin === 'subscription_recurring') return 'renewal'
  if (origin === 'subscription_update' || origin === 'subscription_charge') return 'change'
  return 'other'
}

function minor(amount: string | undefined): number {
  const n = Number(amount ?? 0)
  return Number.isFinite(n) ? n : 0
}

async function orgOf(env: BillingEnv, customData: Record<string, unknown> | null, subscriptionId: string | null): Promise<Org | null> {
  const columns = 'id, owner_id, plan, billing_interval, billed_seats'
  const claimed = typeof customData?.organizationId === 'string' ? customData.organizationId : null
  if (claimed) {
    const org = await env.DB.prepare(`SELECT ${columns} FROM organizations WHERE id = ?`).bind(claimed).first<Org>()
    if (org) return org
  }
  if (!subscriptionId) return null
  return env.DB.prepare(`SELECT ${columns} FROM organizations WHERE paddle_subscription_id = ?`).bind(subscriptionId).first<Org>()
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
