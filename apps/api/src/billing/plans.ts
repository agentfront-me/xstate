// The plans (docs/pricing-plan.md §8a) and their prices. Provider-free: nothing here knows Stripe or Paddle. No
// runtime imports, so `pnpm test` runs this file directly under Node.
//
// Growth is billed monthly in advance as two items: "Growth" ($49 × 1, 5,000 people) and "Extra 100 people"
// ($1 × extraHundreds). Custom is sold by hand. Free costs nothing.

export type Plan = 'free' | 'growth' | 'custom'

/** List prices in US cents a month, for showing before checkout. The provider's catalog is what's charged. */
export const PRICES = { growthBase: 4900, extraHundred: 100 } as const

/** People included in Growth's base price, and the most Growth sells before Custom. */
export const GROWTH_INCLUDED = 5000
export const GROWTH_MAX = 1_000_000
export const MAX_EXTRA_HUNDREDS = (GROWTH_MAX - GROWTH_INCLUDED) / 100

/** Statuses in which a subscription still bills. Past due keeps the plan while the provider retries the payment. */
export const LIVE_STATUSES = ['active', 'trialing', 'past_due'] as const
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled' | 'incomplete'

export function isLive(status: string | null | undefined): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status ?? '')
}

/** Growth's size in people for a number of extra hundreds. */
export function growthSize(extraHundreds: number): number {
  return GROWTH_INCLUDED + clampExtra(extraHundreds) * 100
}

/** The extra hundreds needed to cover `people` (0 up to 5,000). */
export function extraHundredsFor(people: number): number {
  return clampExtra(Math.ceil((Math.max(people, GROWTH_INCLUDED) - GROWTH_INCLUDED) / 100))
}

/** Monthly list price in cents for a Growth size. */
export function growthPriceCents(extraHundreds: number): number {
  return PRICES.growthBase + clampExtra(extraHundreds) * PRICES.extraHundred
}

export function clampExtra(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(Math.max(Math.round(n), 0), MAX_EXTRA_HUNDREDS)
}

/**
 * What an organization gets: Custom when an admin set it up by hand (it keeps that until changed by hand), Growth
 * while a subscription bills, Free otherwise.
 */
export function effectivePlan(current: Plan, status: string | null | undefined): Plan {
  if (current === 'custom') return 'custom'
  return isLive(status) ? 'growth' : 'free'
}

/** One decimal gigabyte, as storage limits are quoted. */
export const GB = 1_000_000_000

/**
 * A plan's limits (docs/pricing-plan.md §8a). null is unlimited. searchableEmails is internal (never shown on the
 * pricing page). Custom uses the limits an admin stored (organizations.limits_override), unlimited where unset.
 */
export type Limits = {
  audience: number | null
  storageBytes: number | null
  mailboxes: number | null
  domains: number | null
  agents: number | null
  emailsPerMonth: number | null
  searchableEmails: number | null
}

export const FREE_LIMITS: Limits = {
  audience: 1000,
  storageBytes: 5 * GB,
  mailboxes: 5,
  domains: 3,
  agents: 1,
  emailsPerMonth: 4000,
  searchableEmails: null,
}

export function limitsFor(plan: Plan, extraHundreds: number | null, override?: Partial<Limits> | null): Limits {
  if (plan === 'free') return FREE_LIMITS
  if (plan === 'custom') {
    return { audience: null, storageBytes: null, mailboxes: null, domains: null, agents: null, emailsPerMonth: null, searchableEmails: null, ...override }
  }
  const extra = clampExtra(extraHundreds ?? 0)
  const audience = growthSize(extra)
  return {
    audience,
    storageBytes: (50 + extra) * GB,
    mailboxes: null,
    domains: null,
    agents: null,
    emailsPerMonth: null,
    searchableEmails: 100 * audience,
  }
}
