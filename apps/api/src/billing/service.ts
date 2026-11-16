// Plans and billing (docs/pricing-plan.md). Paddle is the merchant of record: checkout runs in the browser
// (Paddle.js overlay), and the subscription it creates is mirrored onto the organization by the webhook
// (./webhook.ts) or, right after checkout, by confirmCheckout. Only owners and admins can buy or change a plan;
// every member can see which plan the organization is on.
//
// Seats are the organization's people (personal mailboxes). Shared and agent mailboxes are free. Adding or removing a
// person updates the subscription's quantity (prorated now), and the hourly check repairs anything that drifted.

import { ApiError } from '../errors'
import type { Actor } from '../auth/types'
import { isAdmin, loadMember } from '../mailserver/access'
import { forbidden } from '../mailserver/errors'
import {
  createPortalSession,
  environmentOf,
  getSubscription,
  getTransaction,
  PaddleError,
  updateSubscriptionItems,
  type PaddleEnv,
  type PaddleSubscription,
} from './paddle'
import { effectivePlan, planOfPrice, priceIds, PRICES, seatsFor, type Interval, type PaidPlan, type Plan, type PriceIds } from './plans'

export type BillingEnv = Pick<Env, 'DB'> &
  PaddleEnv & {
    /** Client-side token for Paddle.js (test_… in sandbox, live_… in production). Public. */
    PADDLE_CLIENT_TOKEN?: string
    PADDLE_PRICES?: unknown
    PADDLE_WEBHOOK_SECRET?: string
  }

type OrgBillingRow = {
  id: string
  plan: Plan
  billing_interval: Interval | null
  paddle_customer_id: string | null
  paddle_subscription_id: string | null
  subscription_status: string | null
  billed_seats: number | null
  current_period_end: string | null
  scheduled_change: string | null
  billing_event_at: string | null
}

/** Statuses in which the organization has a subscription that still bills. */
const LIVE_STATUSES = ['active', 'trialing', 'past_due']

function config(env: BillingEnv): { prices: PriceIds; clientToken: string; environment: 'production' | 'sandbox' } | null {
  const prices = priceIds(env.PADDLE_PRICES)
  if (!prices || !env.PADDLE_API_KEY || !env.PADDLE_CLIENT_TOKEN) return null
  return { prices, clientToken: env.PADDLE_CLIENT_TOKEN, environment: environmentOf(env.PADDLE_API_KEY) }
}

function requireConfig(env: BillingEnv) {
  const c = config(env)
  if (!c) throw new ApiError('billing_unavailable', 'Billing isn’t set up on this server yet', 503)
  return c
}

async function loadOrg(env: BillingEnv, organizationId: string): Promise<OrgBillingRow | null> {
  return env.DB.prepare(
    `SELECT id, plan, billing_interval, paddle_customer_id, paddle_subscription_id, subscription_status, billed_seats,
            current_period_end, scheduled_change, billing_event_at
       FROM organizations WHERE id = ?`,
  )
    .bind(organizationId)
    .first<OrgBillingRow>()
}

/** People billed as seats: personal mailboxes. */
export async function countPeople(env: Pick<Env, 'DB'>, organizationId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM mailboxes WHERE organization_id = ? AND kind = 'personal'")
    .bind(organizationId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

function hasLiveSubscription(org: OrgBillingRow): boolean {
  return !!org.paddle_subscription_id && LIVE_STATUSES.includes(org.subscription_status ?? '')
}

export type BillingView = {
  plan: Plan
  interval: Interval | null
  status: string | null
  seats: number | null
  people: number
  periodEnd: string | null
  scheduledChange: { action: string; effectiveAt: string } | null
  /** List prices in cents per person, for the plan picker. */
  prices: typeof PRICES
  canManage: boolean
  /** What the browser needs to open Paddle checkout; null when billing isn't set up or a subscription already exists. */
  checkout: {
    environment: 'production' | 'sandbox'
    clientToken: string
    priceIds: PriceIds
    customerId: string | null
    organizationId: string
  } | null
  /** Paddle.js for paying an open transaction (a link from Paddle's emails or portal lands on the billing page).
   *  customerId goes to Paddle.js as pwCustomer, which Paddle Retain needs (payment recovery, cancellation flows). */
  paddle: { environment: 'production' | 'sandbox'; clientToken: string; customerId: string | null } | null
}

export async function getBilling(env: BillingEnv, actor: Actor, organizationId: string): Promise<BillingView> {
  const member = await loadMember(env as never, organizationId, actor.userId)
  const org = await loadOrg(env, organizationId)
  if (!org) throw new ApiError('organization_not_found', 'Organization not found', 404)
  const c = config(env)
  const manage = isAdmin(member)
  return {
    plan: org.plan,
    interval: org.billing_interval,
    status: org.subscription_status,
    seats: org.billed_seats,
    people: await countPeople(env, organizationId),
    periodEnd: org.current_period_end,
    scheduledChange: org.scheduled_change ? (JSON.parse(org.scheduled_change) as BillingView['scheduledChange']) : null,
    prices: PRICES,
    canManage: manage,
    checkout:
      c && manage && !hasLiveSubscription(org)
        ? { environment: c.environment, clientToken: c.clientToken, priceIds: c.prices, customerId: org.paddle_customer_id, organizationId }
        : null,
    paddle: c ? { environment: c.environment, clientToken: c.clientToken, customerId: org.paddle_customer_id } : null,
  }
}

async function requireManager(env: BillingEnv, actor: Actor, organizationId: string): Promise<OrgBillingRow> {
  const member = await loadMember(env as never, organizationId, actor.userId)
  if (!isAdmin(member)) throw forbidden('Only owners and admins can manage billing')
  const org = await loadOrg(env, organizationId)
  if (!org) throw new ApiError('organization_not_found', 'Organization not found', 404)
  return org
}

/**
 * Right after checkout completes in the browser: look the transaction up and apply its subscription, so the plan
 * changes without waiting for the webhook. Paddle creates the subscription a moment after the payment, so this can
 * answer pending; the app then asks again (and the webhook applies it regardless).
 */
export async function confirmCheckout(
  env: BillingEnv,
  actor: Actor,
  organizationId: string,
  transactionId: string,
): Promise<{ pending: boolean; billing?: BillingView }> {
  requireConfig(env)
  await requireManager(env, actor, organizationId)
  const txn = await paddleCall(() => getTransaction(env, transactionId))
  if (txn.custom_data?.organizationId !== organizationId) throw new ApiError('transaction_mismatch', 'That checkout was for another organization', 400)
  if (!txn.subscription_id) return { pending: true }
  const sub = await paddleCall(() => getSubscription(env, txn.subscription_id!))
  await applySubscription(env, sub, sub.updated_at)
  return { pending: false, billing: await getBilling(env, actor, organizationId) }
}

/** Switch between Pro and Team, or monthly and yearly. Charges or credits the difference now. */
export async function changePlan(
  env: BillingEnv,
  actor: Actor,
  organizationId: string,
  plan: PaidPlan,
  interval: Interval,
): Promise<BillingView> {
  const c = requireConfig(env)
  const org = await requireManager(env, actor, organizationId)
  if (!hasLiveSubscription(org)) throw new ApiError('no_subscription', 'This organization has no paid plan to change; choose one to subscribe', 409)
  if (org.plan === plan && org.billing_interval === interval) return getBilling(env, actor, organizationId)
  const quantity = seatsFor(await countPeople(env, organizationId))
  const sub = await paddleCall(() =>
    updateSubscriptionItems(env, org.paddle_subscription_id!, [{ price_id: c.prices[plan][interval], quantity }]),
  )
  await applySubscription(env, sub, sub.updated_at)
  return getBilling(env, actor, organizationId)
}

/** Links into Paddle's customer portal: invoices, payment method, cancelling. */
export async function portalLinks(
  env: BillingEnv,
  actor: Actor,
  organizationId: string,
): Promise<{ overview: string; cancel: string | null; updatePaymentMethod: string | null }> {
  requireConfig(env)
  const org = await requireManager(env, actor, organizationId)
  if (!org.paddle_customer_id) throw new ApiError('no_customer', 'This organization hasn’t paid for a plan yet', 409)
  const subs = org.paddle_subscription_id && hasLiveSubscription(org) ? [org.paddle_subscription_id] : []
  const session = await paddleCall(() => createPortalSession(env, org.paddle_customer_id!, subs))
  const sub = session.urls.subscriptions[0]
  return { overview: session.urls.general.overview, cancel: sub?.cancel_subscription ?? null, updatePaymentMethod: sub?.update_subscription_payment_method ?? null }
}

/**
 * Mirrors a Paddle subscription onto its organization. `occurredAt` orders reports: one older than what's stored
 * is ignored, since webhooks can arrive out of order. Returns the organization id, or null when the subscription
 * isn't ours.
 */
export async function applySubscription(env: BillingEnv, sub: PaddleSubscription, occurredAt: string): Promise<string | null> {
  const ids = priceIds(env.PADDLE_PRICES)
  const claimed = typeof sub.custom_data?.organizationId === 'string' ? sub.custom_data.organizationId : null
  let org = claimed ? await loadOrg(env, claimed) : null
  if (!org) {
    org = await env.DB.prepare('SELECT id FROM organizations WHERE paddle_subscription_id = ?').bind(sub.id).first<OrgBillingRow>()
    org = org ? await loadOrg(env, org.id) : null
  }
  if (!org) {
    console.error('billing: subscription for no known organization', JSON.stringify({ subscription: sub.id, claimed }))
    return null
  }
  // A second subscription for the same organization (two checkouts at once): the one that still bills wins.
  if (org.paddle_subscription_id && org.paddle_subscription_id !== sub.id && hasLiveSubscription(org) && !LIVE_STATUSES.includes(sub.status)) {
    console.log('billing: ignoring ended subscription', JSON.stringify({ organizationId: org.id, subscription: sub.id }))
    return org.id
  }
  if (org.paddle_subscription_id === sub.id && org.billing_event_at && org.billing_event_at > occurredAt) return org.id

  const item = sub.items[0]
  const priced = ids && item ? planOfPrice(ids, item.price.id) : null
  if (item && !priced) console.error('billing: subscription has a price that is not in PADDLE_PRICES', JSON.stringify({ subscription: sub.id, price: item.price.id }))
  const plan = effectivePlan(sub.status, priced?.plan ?? null)
  const scheduled = sub.scheduled_change ? JSON.stringify({ action: sub.scheduled_change.action, effectiveAt: sub.scheduled_change.effective_at }) : null

  await env.DB.prepare(
    `UPDATE organizations SET plan = ?, billing_interval = ?, paddle_customer_id = ?, paddle_subscription_id = ?,
            subscription_status = ?, billed_seats = ?, current_period_end = ?, scheduled_change = ?, billing_event_at = ?,
            updated_at = ?
      WHERE id = ?`,
  )
    .bind(
      plan,
      priced?.interval ?? null,
      sub.customer_id,
      sub.id,
      sub.status,
      item?.quantity ?? null,
      sub.current_billing_period?.ends_at ?? null,
      scheduled,
      occurredAt,
      new Date().toISOString(),
      org.id,
    )
    .run()
  if (plan !== org.plan) console.log('billing: plan changed', JSON.stringify({ organizationId: org.id, from: org.plan, to: plan, status: sub.status }))
  return org.id
}

/**
 * Bills the organization for its current number of people. Called after a personal mailbox is created or deleted,
 * and hourly. Never throws: a failure is logged and the hourly check tries again.
 */
export async function syncSeats(env: BillingEnv, organizationId: string): Promise<void> {
  try {
    const c = config(env)
    const org = await loadOrg(env, organizationId)
    if (!c || !org || !hasLiveSubscription(org) || org.plan === 'free' || !org.billing_interval) return
    const quantity = seatsFor(await countPeople(env, organizationId))
    if (quantity === org.billed_seats) return
    const sub = await updateSubscriptionItems(env, org.paddle_subscription_id!, [
      { price_id: c.prices[org.plan as PaidPlan][org.billing_interval], quantity },
    ])
    await applySubscription(env, sub, sub.updated_at)
    console.log('billing: seats', JSON.stringify({ organizationId, from: org.billed_seats, to: quantity }))
  } catch (err) {
    console.error(`billing: seat sync for ${organizationId} failed`, err)
  }
}

/** Hourly: seats of every paying organization, in case a change was missed. */
export async function billingHourly(env: BillingEnv): Promise<void> {
  if (!config(env)) return
  const { results } = await env.DB.prepare(
    `SELECT id FROM organizations WHERE paddle_subscription_id IS NOT NULL AND subscription_status IN ('active', 'trialing', 'past_due')`,
  ).all<{ id: string }>()
  for (const { id } of results) await syncSeats(env, id)
}

async function paddleCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof PaddleError) {
      console.error('billing: paddle call failed', err.status, err.code, err.message)
      if (err.status === 404) throw new ApiError('billing_not_found', 'Paddle doesn’t know that checkout or subscription', 404)
      throw new ApiError('billing_failed', 'The payment provider didn’t respond as expected. Try again shortly.', 502)
    }
    throw err
  }
}
