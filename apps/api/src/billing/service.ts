// Plans and billing (docs/pricing-plan.md §8a, docs/billing-limits-plan.md). Provider-free: every call to the payment
// provider goes through BillingProvider (./provider.ts), so nothing here knows Stripe or Paddle.
//
// Growth is bought on the provider's hosted checkout page; the subscription it creates is mirrored onto the
// organization by the webhook (./webhook.ts). Size changes go through setSize (prorated now). Only owners and admins
// can buy or change a plan; every member can see which plan the organization is on. Custom is set up by hand.

import { daysSince, noBackground, track, type Background } from '../analytics/events'
import { ApiError } from '../errors'
import type { Actor } from '../auth/types'
import { isAdmin, loadMember } from '../mailserver/access'
import { forbidden } from '../mailserver/errors'
import {
  clampExtra,
  effectivePlan,
  growthPriceCents,
  growthSize,
  isLive,
  PRICES,
  GROWTH_INCLUDED,
  GROWTH_MAX,
  type Plan,
} from './plans'
import { ProviderError, providerFor, type BillingProvider, type ProviderEnv, type Subscription } from './provider'

export type BillingEnv = Pick<Env, 'DB' | 'APP_URL'> & ProviderEnv

type OrgBillingRow = {
  id: string
  name: string
  owner_id: string
  plan: Plan
  billing_provider: string | null
  billing_customer_id: string | null
  billing_subscription_id: string | null
  subscription_status: string | null
  extra_hundreds: number | null
  current_period_end: string | null
  cancel_at: string | null
  billing_event_at: string | null
}

const COLUMNS = `id, name, owner_id, plan, billing_provider, billing_customer_id, billing_subscription_id, subscription_status,
  extra_hundreds, current_period_end, cancel_at, billing_event_at`

async function loadOrg(env: BillingEnv, organizationId: string): Promise<OrgBillingRow | null> {
  return env.DB.prepare(`SELECT ${COLUMNS} FROM organizations WHERE id = ?`).bind(organizationId).first<OrgBillingRow>()
}

function hasLiveSubscription(org: OrgBillingRow): boolean {
  return !!org.billing_subscription_id && isLive(org.subscription_status)
}

export type BillingView = {
  plan: Plan
  status: string | null
  /** Growth's size in people (5,000 and up) while subscribed; null otherwise. */
  size: number | null
  extraHundreds: number | null
  /** What Growth at this size costs a month, in cents; null when not on Growth. */
  priceCents: number | null
  periodEnd: string | null
  cancelAt: string | null
  /** List prices and limits of the Growth sizes, for the size picker. */
  prices: typeof PRICES & { included: number; max: number }
  canManage: boolean
  /** False when no payment provider is set up on this server: paid plans can't be bought here. */
  available: boolean
  /** True when there is a customer to open the provider's portal for (invoices, card, cancelling). */
  hasPortal: boolean
}

export async function getBilling(env: BillingEnv, actor: Actor, organizationId: string): Promise<BillingView> {
  const member = await loadMember(env as never, organizationId, actor.userId)
  const org = await loadOrg(env, organizationId)
  if (!org) throw new ApiError('organization_not_found', 'Organization not found', 404)
  return view(env, org, isAdmin(member))
}

function view(env: BillingEnv, org: OrgBillingRow, canManage: boolean): BillingView {
  const onGrowth = org.plan === 'growth'
  const extra = onGrowth ? clampExtra(org.extra_hundreds ?? 0) : null
  return {
    plan: org.plan,
    status: org.subscription_status,
    size: extra === null ? null : growthSize(extra),
    extraHundreds: extra,
    priceCents: extra === null ? null : growthPriceCents(extra),
    periodEnd: org.current_period_end,
    cancelAt: org.cancel_at,
    prices: { ...PRICES, included: GROWTH_INCLUDED, max: GROWTH_MAX },
    canManage,
    available: !!providerFor(env),
    hasPortal: canManage && !!org.billing_customer_id && !!providerFor(env),
  }
}

async function requireManager(env: BillingEnv, actor: Actor, organizationId: string): Promise<OrgBillingRow> {
  const member = await loadMember(env as never, organizationId, actor.userId)
  if (!isAdmin(member)) throw forbidden('Only owners and admins can manage billing')
  const org = await loadOrg(env, organizationId)
  if (!org) throw new ApiError('organization_not_found', 'Organization not found', 404)
  return org
}

function requireProvider(env: BillingEnv): BillingProvider {
  const provider = providerFor(env)
  if (!provider) throw new ApiError('billing_unavailable', 'Paid plans aren’t available on this server yet', 503)
  return provider
}

const billingUrl = (env: BillingEnv, query = '') => `${env.APP_URL.replace(/\/+$/, '')}/app/#/settings/billing${query}`

/** A hosted checkout page for Growth at this size. Refused when the organization already pays or is on Custom. */
export async function startCheckout(env: BillingEnv, actor: Actor, organizationId: string, extraHundreds: number): Promise<{ url: string }> {
  const provider = requireProvider(env)
  const org = await requireManager(env, actor, organizationId)
  if (org.plan === 'custom') throw new ApiError('custom_plan', 'This organization is on a Custom plan; contact us to change it', 409)
  if (hasLiveSubscription(org)) throw new ApiError('already_subscribed', 'This organization already has Growth; change its size instead', 409)
  const owner = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(org.owner_id).first<{ email: string }>()
  return providerCall(() =>
    provider.checkout(
      { id: org.id, name: org.name, customerId: org.billing_customer_id, ownerEmail: owner?.email ?? null },
      clampExtra(extraHundreds),
      { success: billingUrl(env, '?checkout=done'), cancel: billingUrl(env) },
    ),
  )
}

/**
 * Right after checkout returns to the app: apply the subscription it created, so the plan changes without waiting for
 * the webhook. Answers pending while the provider is still creating it; the webhook applies it regardless.
 */
export async function confirmCheckout(
  env: BillingEnv,
  actor: Actor,
  organizationId: string,
  sessionId: string,
  background: Background = noBackground,
): Promise<{ pending: boolean; billing?: BillingView }> {
  const provider = requireProvider(env)
  await requireManager(env, actor, organizationId)
  const result = await providerCall(() => provider.confirmCheckout(sessionId))
  if (result.organizationId !== organizationId) throw new ApiError('checkout_mismatch', 'That checkout was for another organization', 400)
  if (!result.subscription) return { pending: true }
  await applySubscription(env, provider.name, { ...result.subscription, organizationId }, background)
  const org = await loadOrg(env, organizationId)
  return { pending: false, billing: org ? view(env, org, true) : undefined }
}

/** Change Growth's size now. The difference is charged or credited, prorated, by the provider. */
export async function setSize(
  env: BillingEnv,
  actor: Actor,
  organizationId: string,
  extraHundreds: number,
  background: Background = noBackground,
): Promise<BillingView> {
  const provider = requireProvider(env)
  const org = await requireManager(env, actor, organizationId)
  if (!hasLiveSubscription(org) || org.plan !== 'growth') throw new ApiError('no_subscription', 'This organization isn’t on Growth; upgrade first', 409)
  const next = clampExtra(extraHundreds)
  if (next !== (org.extra_hundreds ?? 0)) {
    const sub = await providerCall(() => provider.setExtraHundreds(org.billing_subscription_id!, next))
    await applySubscription(env, provider.name, sub, background)
  }
  const fresh = await loadOrg(env, organizationId)
  return view(env, fresh ?? org, true)
}

/** The provider's customer portal: invoices, the card on file, cancelling. */
export async function portalLink(env: BillingEnv, actor: Actor, organizationId: string): Promise<{ url: string }> {
  const provider = requireProvider(env)
  const org = await requireManager(env, actor, organizationId)
  if (!org.billing_customer_id) throw new ApiError('no_customer', 'This organization hasn’t paid for a plan yet', 409)
  return providerCall(() => provider.portal(org.billing_customer_id!, billingUrl(env)))
}

/**
 * Mirrors a subscription onto its organization. Reports older than the stored one are ignored, since webhooks can
 * arrive out of order. Returns the organization id, or null when the subscription isn't ours.
 */
export async function applySubscription(
  env: BillingEnv,
  providerName: string,
  sub: Subscription,
  background: Background = noBackground,
): Promise<string | null> {
  // The update only applies over the state it was worked out from, so of two reports applied at once just one sees
  // each change and records it. The other reloads and tries again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await applyOnce(env, providerName, sub, background)
    if (result !== RETRY) return result
  }
  console.error('billing: subscription kept changing underneath', JSON.stringify({ subscription: sub.id }))
  return null
}

const RETRY = Symbol('retry')

async function applyOnce(env: BillingEnv, providerName: string, sub: Subscription, background: Background): Promise<string | null | typeof RETRY> {
  let org = sub.organizationId ? await loadOrg(env, sub.organizationId) : null
  if (!org) {
    const found = await env.DB.prepare('SELECT id FROM organizations WHERE billing_provider = ? AND billing_subscription_id = ?')
      .bind(providerName, sub.id)
      .first<{ id: string }>()
    org = found ? await loadOrg(env, found.id) : null
  }
  if (!org) {
    console.error('billing: subscription for no known organization', JSON.stringify({ subscription: sub.id, claimed: sub.organizationId }))
    return null
  }
  // A second subscription for the same organization (two checkouts at once): the one that still bills wins.
  if (org.billing_subscription_id && org.billing_subscription_id !== sub.id && hasLiveSubscription(org) && !isLive(sub.status)) {
    console.log('billing: ignoring ended subscription', JSON.stringify({ organizationId: org.id, subscription: sub.id }))
    return org.id
  }
  if (org.billing_subscription_id === sub.id && org.billing_event_at && org.billing_event_at > sub.updatedAt) return org.id

  const plan = effectivePlan(org.plan, sub.status)
  const extra = clampExtra(sub.extraHundreds)
  const updated = await env.DB.prepare(
    `UPDATE organizations SET plan = ?, billing_provider = ?, billing_customer_id = ?, billing_subscription_id = ?,
            subscription_status = ?, extra_hundreds = ?, current_period_end = ?, cancel_at = ?, billing_event_at = ?, updated_at = ?
      WHERE id = ? AND plan IS ? AND subscription_status IS ? AND extra_hundreds IS ? AND cancel_at IS ? AND billing_event_at IS ?`,
  )
    .bind(
      plan,
      providerName,
      sub.customerId,
      sub.id,
      sub.status,
      extra,
      sub.periodEnd,
      sub.cancelAt,
      sub.updatedAt,
      new Date().toISOString(),
      org.id,
      org.plan,
      org.subscription_status,
      org.extra_hundreds,
      org.cancel_at,
      org.billing_event_at,
    )
    .run()
  if (!updated.meta.changes) return RETRY
  if (plan !== org.plan) console.log('billing: plan changed', JSON.stringify({ organizationId: org.id, from: org.plan, to: plan, status: sub.status }))
  recordChanges(env, background, org, { plan, extra, sub })
  return org.id
}

const RANK: Record<Plan, number> = { free: 0, growth: 1, custom: 2 }
const sizeOf = (plan: Plan, extra: number | null) => (plan === 'growth' ? growthSize(extra ?? 0) : null)

/** "Plan Changed" and "Subscription Canceled" (docs/analytics-events.md), from the state before and after. */
function recordChanges(env: BillingEnv, background: Background, org: OrgBillingRow, next: { plan: Plan; extra: number; sub: Subscription }): void {
  const fromSize = sizeOf(org.plan, org.extra_hundreds)
  const toSize = sizeOf(next.plan, next.extra)
  if (next.plan !== org.plan || fromSize !== toSize) {
    const up = RANK[next.plan] > RANK[org.plan] || (next.plan === org.plan && (toSize ?? 0) > (fromSize ?? 0))
    track(env, background, org.owner_id, org.id, 'Plan Changed', {
      from_plan: org.plan,
      to_plan: next.plan,
      from_size: fromSize,
      to_size: toSize,
      direction: up ? 'upgrade' : 'downgrade',
    })
  }
  const wasScheduled = !!org.cancel_at
  const scheduled = !!next.sub.cancelAt
  const endedNow = next.sub.status === 'canceled' && org.subscription_status !== 'canceled' && org.subscription_status !== null
  // Once per cancellation: when it's scheduled, or when it ends without having been scheduled first.
  if ((scheduled && !wasScheduled) || (endedNow && !wasScheduled)) {
    track(env, background, org.owner_id, org.id, 'Subscription Canceled', {
      plan: org.plan === 'free' ? 'growth' : org.plan,
      size: fromSize ?? growthSize(next.extra),
      tenure_days: next.sub.startedAt ? daysSince(next.sub.startedAt) : 0,
      immediate: !scheduled,
    })
  }
}

/**
 * Hourly: refreshes every billing organization's subscription from the provider, in case a webhook was missed.
 * Plan-limit work (usage, notices) joins this in phase 5.
 */
export async function billingHourly(env: BillingEnv): Promise<void> {
  const provider = providerFor(env)
  if (!provider) return
  const { results } = await env.DB.prepare(
    `SELECT billing_subscription_id AS id FROM organizations
      WHERE billing_provider = ? AND billing_subscription_id IS NOT NULL AND subscription_status IN ('active', 'trialing', 'past_due')`,
  )
    .bind(provider.name)
    .all<{ id: string }>()
  for (const { id } of results) {
    try {
      await applySubscription(env, provider.name, await provider.getSubscription(id))
    } catch (err) {
      console.error(`billing: refreshing subscription ${id} failed`, err)
    }
  }
}

async function providerCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof ProviderError) {
      console.error('billing: provider call failed', err.status, err.message)
      if (err.status === 404) throw new ApiError('billing_not_found', 'The payment provider doesn’t know that subscription', 404)
      throw new ApiError('billing_failed', 'The payment provider didn’t respond as expected. Try again shortly.', 502)
    }
    throw err
  }
}
