// The plans (docs/pricing-plan.md) and how Paddle prices map onto them. No runtime imports, so `pnpm test` runs this
// file directly under Node.

export type Plan = 'free' | 'pro' | 'team'
export type PaidPlan = Exclude<Plan, 'free'>
export type Interval = 'month' | 'year'

/** List prices in US cents per person, for showing before checkout. Paddle's catalog is what's charged. */
export const PRICES: Record<PaidPlan, Record<Interval, number>> = {
  pro: { month: 600, year: 6000 },
  team: { month: 1200, year: 12000 },
}

/** Paddle price ids for each plan and interval, from PADDLE_PRICES (sandbox and live catalogs differ). */
export type PriceIds = Record<PaidPlan, Record<Interval, string>>

/**
 * PADDLE_PRICES is {"pro":{"month":"pri_…","year":"pri_…"},"team":{…}}: an object in wrangler.jsonc, a JSON string in
 * .dev.vars. Null when it's missing or incomplete, which turns billing off.
 */
export function priceIds(value: unknown): PriceIds | null {
  let parsed = value
  if (typeof value === 'string') {
    if (!value.trim()) return null
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  const out = {} as PriceIds
  for (const plan of ['pro', 'team'] as const) {
    const entry = (parsed as Record<string, Record<string, unknown>> | null)?.[plan]
    const month = entry?.month
    const year = entry?.year
    if (typeof month !== 'string' || !month.startsWith('pri_') || typeof year !== 'string' || !year.startsWith('pri_')) return null
    out[plan] = { month, year }
  }
  return out
}

/** The plan and interval a Paddle price id stands for, or null when it isn't one of ours. */
export function planOfPrice(ids: PriceIds, priceId: string): { plan: PaidPlan; interval: Interval } | null {
  for (const plan of ['pro', 'team'] as const) {
    for (const interval of ['month', 'year'] as const) {
      if (ids[plan][interval] === priceId) return { plan, interval }
    }
  }
  return null
}

/**
 * What an organization gets for a subscription in this Paddle status. Past due keeps the plan while Paddle retries
 * the payment (its dunning ends by cancelling the subscription, which then lands here as canceled).
 */
export function effectivePlan(status: string | null, plan: PaidPlan | null): Plan {
  if (!plan) return 'free'
  return status === 'active' || status === 'trialing' || status === 'past_due' ? plan : 'free'
}

/** Seats billed: the organization's people (personal mailboxes), at least one. */
export function seatsFor(people: number): number {
  return Math.max(1, Math.min(people, 10_000))
}
