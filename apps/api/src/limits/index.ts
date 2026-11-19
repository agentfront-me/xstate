// Plan limits (docs/billing-limits-plan.md §3.4, phase 5). Each limit is checked where its action already happens:
//
// - mailboxes, domains, agents: when one is created (requireRoom)
// - storage: when a Storage file is written (requireStorageRoom); mail always keeps arriving
// - emails a month: in the send reservation (requireEmailRoom), hard at 100% like every sending cap
// - active audience: hourly (./hourly.ts). Free over 110% pauses email API sends, agent runs and new identified
//   website visitors until the next month or an upgrade (audiencePaused); Growth only emails owners each week
//
// Counted limits allow 10% over before they stop (decided 2026-11-16), rounded down, so small counts (5 mailboxes)
// stop at the limit itself. Custom organizations use the limits an admin stored in organizations.limits_override.

import { ApiError } from '../errors'
import { limitsFor, type Limits, type Plan } from '../billing/plans'
import { monthOf } from '../usage/record'
import { ceiling, GRACE, pausedIn } from './rules'

export { GRACE, pausedIn, ceiling } from './rules'

export type LimitsEnv = Pick<Env, 'DB'>


export type OrgPlan = { plan: Plan; limits: Limits; ownerId: string }

export async function planOf(env: LimitsEnv, organizationId: string): Promise<OrgPlan> {
  const row = await env.DB.prepare('SELECT plan, extra_hundreds, limits_override, owner_id FROM organizations WHERE id = ?')
    .bind(organizationId)
    .first<{ plan: Plan; extra_hundreds: number | null; limits_override: string | null; owner_id: string }>()
  if (!row) throw new ApiError('organization_not_found', 'Organization not found', 404)
  let override: Partial<Limits> | null = null
  try {
    override = row.limits_override ? (JSON.parse(row.limits_override) as Partial<Limits>) : null
  } catch {
    console.error('limits: unreadable limits_override', organizationId)
  }
  return { plan: row.plan, limits: limitsFor(row.plan, row.extra_hundreds, override), ownerId: row.owner_id }
}


const UPGRADE = 'Upgrade to Growth in Settings → Billing for more.'

function planLimit(what: string, limit: number, plan: Plan): ApiError {
  const more = plan === 'free' ? ` ${UPGRADE}` : plan === 'custom' ? ' Contact us to raise it.' : ''
  return new ApiError('plan_limit', `Your plan allows ${what}.${more}`, 402, { limit })
}

type Counted = 'mailboxes' | 'domains' | 'agents'

const COUNT_SQL: Record<Counted, string> = {
  mailboxes: "SELECT count(*) AS n FROM mailboxes WHERE organization_id = ? AND kind IN ('personal', 'shared')",
  domains: 'SELECT count(*) AS n FROM domains WHERE organization_id = ?',
  agents: 'SELECT count(*) AS n FROM agents WHERE organization_id = ?',
}

const WHAT: Record<Counted, (n: number) => string> = {
  mailboxes: (n) => `up to ${n} mailboxes, personal and shared together`,
  domains: (n) => `up to ${n} domains`,
  agents: (n) => `up to ${n} ${n === 1 ? 'agent' : 'agents'}`,
}

/** Throws 402 plan_limit when adding `adding` more would pass the plan's limit for mailboxes, domains or agents. */
export async function requireRoom(env: LimitsEnv, organizationId: string, kind: Counted, adding = 1): Promise<void> {
  const { plan, limits } = await planOf(env, organizationId)
  const limit = limits[kind]
  if (limit === null) return
  const row = await env.DB.prepare(COUNT_SQL[kind]).bind(organizationId).first<{ n: number }>()
  if ((row?.n ?? 0) + adding > ceiling(limit)) throw planLimit(WHAT[kind](limit), limit, plan)
}

/** Stored mail plus Storage files (with their kept versions), in bytes. */
export async function storageUsed(env: LimitsEnv, organizationId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE((SELECT mail_bytes FROM org_usage WHERE organization_id = ?1), 0)
          + COALESCE((SELECT SUM(size_bytes) FROM files WHERE organization_id = ?1 AND source = 'drive' AND status != 'deleted'), 0) AS bytes`,
  )
    .bind(organizationId)
    .first<{ bytes: number }>()
  return row?.bytes ?? 0
}

/** Throws 402 plan_limit when writing `bytes` more to Storage would pass the storage limit with its grace. */
export async function requireStorageRoom(env: LimitsEnv, organizationId: string, bytes: number | null): Promise<void> {
  const { plan, limits } = await planOf(env, organizationId)
  if (limits.storageBytes === null) return
  const used = await storageUsed(env, organizationId)
  if (used + Math.max(bytes ?? 0, 0) > limits.storageBytes * GRACE) {
    const gb = Math.round(limits.storageBytes / 1e9)
    throw new ApiError(
      'plan_limit',
      `Your storage is full (${gb} GB on your plan). Delete files or empty the trash to make room.` +
        (plan === 'free' ? ` ${UPGRADE}` : plan === 'growth' ? ' More storage is $5 per 100 GB in Settings → Billing.' : ''),
      402,
      { limit: limits.storageBytes },
    )
  }
}

/**
 * Throws 429 send_limit_reached when `recipients` more would pass the plan's emails a month (every recipient
 * counted). Hard at 100%, like the other sending caps. The count itself is added in the reservation's batch.
 */
export async function requireEmailRoom(env: LimitsEnv, organizationId: string, recipients: number, month = monthOf()): Promise<void> {
  const { plan, limits } = await planOf(env, organizationId)
  if (limits.emailsPerMonth === null || recipients <= 0) return
  const row = await env.DB.prepare('SELECT emails_month, emails_count FROM org_usage WHERE organization_id = ?')
    .bind(organizationId)
    .first<{ emails_month: string | null; emails_count: number }>()
  const used = row?.emails_month === month ? row.emails_count : 0
  if (used + recipients > limits.emailsPerMonth) {
    throw new ApiError(
      'send_limit_reached',
      `Your plan sends up to ${limits.emailsPerMonth.toLocaleString('en-US')} emails a month, and ${used.toLocaleString('en-US')} have gone this month.` +
        (plan === 'free' ? ` ${UPGRADE}` : ''),
      429,
      { limit: limits.emailsPerMonth, used },
    )
  }
}

/** True while a Free organization is over 110% of its active audience this month (./hourly.ts sets it). */
export async function audiencePaused(env: LimitsEnv, organizationId: string, month = monthOf()): Promise<boolean> {
  // Only Free pauses: an upgrade lifts the pause at once, without waiting for the hourly pass.
  const row = await env.DB.prepare(
    "SELECT u.over_since FROM org_usage u JOIN organizations o ON o.id = u.organization_id WHERE u.organization_id = ? AND o.plan = 'free'",
  )
    .bind(organizationId)
    .first<{ over_since: string | null }>()
  return pausedIn(row?.over_since ?? null, month)
}

/** The error for actions paused by a Free organization's full audience. */
export function audiencePausedError(): ApiError {
  return new ApiError(
    'plan_limit',
    `Your organization reached more than its plan's 1,000 people this month, so email API sends, agent runs and new website sign-ups are paused until next month. Personal email keeps working. ${UPGRADE}`,
    402,
  )
}
