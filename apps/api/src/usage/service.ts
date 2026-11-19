// Plan usage for Settings → Billing (docs/billing-limits-plan.md §3.3, phase 3): what an organization has used this
// month next to its plan's limits. Read-only: nothing is refused here (limits come in phase 5).
//
// Storage is raw mail (org_usage.mail_bytes, kept by the mail-events queue and set exactly by the daily recount)
// plus Storage files with their kept versions (summed live from D1). Mail attachments are inside the raw mail, so
// their separate `files` copies aren't counted again.

import { ApiError } from '../errors'
import type { Actor } from '../auth/types'
import { loadMember } from '../mailserver/access'
import { store } from '../mailbox/stub'
import { limitsFor, type Limits, type Plan } from '../billing/plans'
import { monthOf } from './record'

export type UsageView = {
  month: string
  plan: Plan
  /** Limits shown to people. The internal search cap is left out on purpose. */
  limits: Omit<Limits, 'searchableEmails'>
  audience: { total: number; mail: number; web: number }
  /** Accepted website events this month (event load; no limit yet). */
  websiteEvents: number
  storage: { bytes: number; mailBytes: number; fileBytes: number; checkedAt: string | null }
  emails: number
  mailboxes: number
  domains: number
  agents: number
}

type OrgRow = { plan: Plan; extra_hundreds: number | null; limits_override: string | null }
type UsageRow = { mail_bytes: number; mail_checked_at: string | null; emails_month: string | null; emails_count: number }

/** Recount mail bytes when the last count is older than this, on reads of the usage page. */
const STALE_MS = 6 * 60 * 60 * 1000

export async function getUsage(env: Env, actor: Actor, organizationId: string): Promise<UsageView> {
  await loadMember(env as never, organizationId, actor.userId)
  const org = await env.DB.prepare('SELECT plan, extra_hundreds, limits_override FROM organizations WHERE id = ?').bind(organizationId).first<OrgRow>()
  if (!org) throw new ApiError('organization_not_found', 'Organization not found', 404)
  const month = monthOf()
  let usage = await env.DB.prepare('SELECT mail_bytes, mail_checked_at, emails_month, emails_count FROM org_usage WHERE organization_id = ?')
    .bind(organizationId)
    .first<UsageRow>()
  if (!usage?.mail_checked_at || Date.now() - Date.parse(usage.mail_checked_at) > STALE_MS) {
    await recountMail(env, organizationId).catch((err) => console.error('usage: recount failed', organizationId, err))
    usage = await env.DB.prepare('SELECT mail_bytes, mail_checked_at, emails_month, emails_count FROM org_usage WHERE organization_id = ?')
      .bind(organizationId)
      .first<UsageRow>()
  }
  const [files, counts, audience] = await Promise.all([
    env.DB.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM files WHERE organization_id = ? AND source = 'drive' AND status != 'deleted'")
      .bind(organizationId)
      .first<{ bytes: number }>(),
    env.DB.prepare(
      `SELECT (SELECT count(*) FROM mailboxes WHERE organization_id = ?1 AND kind IN ('personal', 'shared')) AS mailboxes,
              (SELECT count(*) FROM domains WHERE organization_id = ?1) AS domains,
              (SELECT count(*) FROM agents WHERE organization_id = ?1) AS agents`,
    )
      .bind(organizationId)
      .first<{ mailboxes: number; domains: number; agents: number }>(),
    env.AUDIENCE.get(env.AUDIENCE.idFromName(organizationId))
      .usage(month)
      .catch((err: unknown) => (console.error('usage: audience failed', organizationId, err), { total: 0, mail: 0, web: 0, events: 0 })),
  ])
  let override: Partial<Limits> | null = null
  try {
    override = org.limits_override ? (JSON.parse(org.limits_override) as Partial<Limits>) : null
  } catch {
    override = null
  }
  const { searchableEmails: _internal, ...limits } = limitsFor(org.plan, org.extra_hundreds, override)
  const mailBytes = usage?.mail_bytes ?? 0
  const fileBytes = files?.bytes ?? 0
  return {
    month,
    plan: org.plan,
    limits,
    audience: { total: audience.total, mail: audience.mail, web: audience.web },
    websiteEvents: audience.events,
    storage: { bytes: mailBytes + fileBytes, mailBytes, fileBytes, checkedAt: usage?.mail_checked_at ?? null },
    emails: usage?.emails_month === month ? usage.emails_count : 0,
    mailboxes: counts?.mailboxes ?? 0,
    domains: counts?.domains ?? 0,
    agents: counts?.agents ?? 0,
  }
}

/** Sets the organization's raw mail bytes exactly, from each mailbox's store. */
export async function recountMail(env: Pick<Env, 'DB' | 'MAILBOX_STORE'>, organizationId: string): Promise<number> {
  const { results } = await env.DB.prepare('SELECT id FROM mailboxes WHERE organization_id = ?').bind(organizationId).all<{ id: string }>()
  let bytes = 0
  for (const { id } of results) bytes += await (await store(env, id)).mailBytes()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO org_usage (organization_id, mail_bytes, mail_checked_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (organization_id) DO UPDATE SET mail_bytes = excluded.mail_bytes, mail_checked_at = excluded.mail_checked_at, updated_at = excluded.updated_at`,
  )
    .bind(organizationId, bytes, now, now)
    .run()
  return bytes
}

/**
 * Daily (from the hourly cron, at 03:00 UTC): recount every organization's mail bytes, so deletions and any missed
 * counts are caught. One organization at a time; a failure is logged and the next day tries again.
 */
export async function usageDaily(env: Env, now = new Date()): Promise<void> {
  if (now.getUTCHours() !== 3) return
  const { results } = await env.DB.prepare('SELECT id FROM organizations').all<{ id: string }>()
  for (const { id } of results) {
    try {
      await recountMail(env, id)
    } catch (err) {
      console.error('usage: daily recount failed', id, err)
    }
  }
}
