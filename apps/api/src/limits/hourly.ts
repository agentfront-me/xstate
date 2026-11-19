// Hourly plan-limit pass (docs/billing-limits-plan.md §3.4): reads each organization's usage, pauses a Free
// organization that is over 110% of its active audience, and emails owners and admins.
//
// - Free: a notice at 100% and at 110% of the active audience, storage and emails a month, once each a month.
//   Over 110% of the audience, email API sends, agent runs and new identified website visitors pause until the next
//   month or an upgrade (limits/index.ts audiencePaused).
// - Growth: while the active audience is at or over its size, an email every week (decided 2026-11-19); nothing
//   stops. Storage notices as on Free.
// - Custom: storage notices only, when it has a storage limit.
//
// org_usage.notified records what went out ({"audience:100:2026-11": "…", "audience:full:2026-W47": "…"}), so a notice
// is sent once per period however often this runs. Entries from older months are dropped.

import { limitsFor, type Limits, type Plan } from '../billing/plans'
import { sendSystemEmail, type SystemMailEnv } from '../mailserver/system-mail'
import { monthOf } from '../usage/record'
import { storageUsed } from '.'
import { decide, weekOf } from './rules'
import { trimSearchable } from './search-cap'

type OrgRow = { id: string; name: string; plan: Plan; extra_hundreds: number | null; limits_override: string | null }
type UsageRow = { emails_month: string | null; emails_count: number; over_since: string | null; notified: string | null }

export async function limitsHourly(env: Env & SystemMailEnv, now = Date.now()): Promise<{ checked: number; notices: number; paused: number }> {
  const month = monthOf(now)
  const week = weekOf(now)
  const { results: orgs } = await env.DB.prepare('SELECT id, name, plan, extra_hundreds, limits_override FROM organizations').all<OrgRow>()
  let notices = 0
  let paused = 0
  for (const org of orgs) {
    try {
      let override: Partial<Limits> | null = null
      try {
        override = org.limits_override ? (JSON.parse(org.limits_override) as Partial<Limits>) : null
      } catch {
        override = null
      }
      const limits = limitsFor(org.plan, org.extra_hundreds, override)
      const usage = await env.DB.prepare('SELECT emails_month, emails_count, over_since, notified FROM org_usage WHERE organization_id = ?')
        .bind(org.id)
        .first<UsageRow>()
      const audience = await env.AUDIENCE.get(env.AUDIENCE.idFromName(org.id)).usage(month)
      const used = { audience: audience.total, storage: await storageUsed(env, org.id), emails: usage?.emails_month === month ? usage.emails_count : 0 }
      const result = decide(org, limits, used, month, week, usage?.over_since ?? null)
      // Growth's internal searchable-mail cap (./search-cap.ts).
      await trimSearchable(env, org.id, limits.searchableEmails)

      const sent = parse(usage?.notified)
      // Keep only this month's and this week's keys.
      for (const key of Object.keys(sent)) if (!key.endsWith(month) && !key.endsWith(week)) delete sent[key]
      const due = result.notices.filter((x) => !sent[x.key])
      if (due.length) {
        const managers = await env.DB.prepare(
          `SELECT u.email, u.name FROM members m JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = ? AND m.role IN ('owner', 'admin') AND m.status = 'active' AND m.suspended_at IS NULL`,
        )
          .bind(org.id)
          .all<{ email: string; name: string | null }>()
        for (const notice of due) {
          for (const to of managers.results) {
            const html = `<p>${escapeHtml(notice.text)}</p><p><a href="${env.APP_URL.replace(/\/+$/, '')}/app/#/settings/billing">Open Settings → Billing</a></p>`
            await sendSystemEmail(env, { to: { name: to.name, email: to.email }, subject: notice.subject, text: notice.text, html }).catch((err) =>
              console.error('limits: notice failed', org.id, notice.key, err),
            )
          }
          sent[notice.key] = new Date(now).toISOString()
          notices++
        }
      }
      const overSince = JSON.stringify(result.paused ? { audiencePaused: month } : {})
      if (result.paused) paused++
      if (due.length || overSince !== (usage?.over_since ?? '{}')) {
        await env.DB.prepare(
          `INSERT INTO org_usage (organization_id, over_since, notified, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (organization_id) DO UPDATE SET over_since = excluded.over_since, notified = excluded.notified, updated_at = excluded.updated_at`,
        )
          .bind(org.id, overSince, JSON.stringify(sent), new Date(now).toISOString())
          .run()
      }
    } catch (err) {
      console.error('limits: hourly failed for', org.id, err)
    }
  }
  return { checked: orgs.length, notices, paused }
}

function parse(json: string | null | undefined): Record<string, string> {
  try {
    return json ? (JSON.parse(json) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
