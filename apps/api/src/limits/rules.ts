// The pure parts of plan limits (docs/billing-limits-plan.md §3.4): the grace, the pause flag, week keys and what the
// hourly pass sends. No runtime imports, so `pnpm test` runs this file directly under Node.

import type { Limits, Plan } from '../billing/plans'

/** How far past a limit counted usage may go before it stops (decided 2026-11-16). */
export const GRACE = 1.1

/** The most usage a limit allows, grace included, rounded down: 5 mailboxes stop at 5. */
export const ceiling = (limit: number) => Math.floor(limit * GRACE)

/** True when org_usage.over_since marks the audience paused for `month`. */
export function pausedIn(overSince: string | null, month: string): boolean {
  if (!overSince) return false
  try {
    return (JSON.parse(overSince) as { audiencePaused?: string }).audiencePaused === month
  } catch {
    return false
  }
}

/** ISO-like week key, for the weekly Growth email. */
export function weekOf(at: number): string {
  const d = new Date(at)
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3) // the Thursday of this week
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

type Notice = { key: string; subject: string; text: string }

/** What to send and set for one organization; pure, so it can be tested. */
export function decide(
  org: { name: string; plan: Plan },
  limits: Limits,
  used: { audience: number; storage: number; emails: number },
  month: string,
  week: string,
  overSince: string | null,
): { notices: Notice[]; paused: boolean } {
  const notices: Notice[] = []
  const n = (v: number) => v.toLocaleString('en-US')
  const upgrade = 'Upgrade to Growth in Settings → Billing to keep going.'
  const levels = (key: string, value: number, limit: number | null, what: (level: 100 | 110) => Notice['subject'], body: (level: 100 | 110) => string) => {
    if (limit === null) return
    for (const level of [110, 100] as const) {
      if (value >= (level === 110 ? limit * GRACE : limit)) {
        notices.push({ key: `${key}:${level}:${month}`, subject: what(level), text: body(level) })
        break
      }
    }
  }

  if (org.plan === 'free') {
    levels(
      'audience',
      used.audience,
      limits.audience,
      (l) => (l === 110 ? `${org.name} is over its 1,000 people this month` : `${org.name} reached 1,000 people this month`),
      (l) =>
        l === 110
          ? `Your organization has reached ${n(used.audience)} people this month, more than the Free plan's 1,000 plus 10%. ` +
            `Email API sends, agent runs and new website sign-ups are paused until next month. Personal email keeps working. ${upgrade}`
          : `Your organization has reached ${n(used.audience)} of the Free plan's 1,000 people this month. ` +
            `Above 1,100, email API sends, agent runs and new website sign-ups pause until next month. ${upgrade}`,
    )
    levels(
      'emails',
      used.emails,
      limits.emailsPerMonth,
      () => `${org.name} reached its emails for this month`,
      () => `Your organization has sent ${n(used.emails)} of the Free plan's ${n(limits.emailsPerMonth ?? 0)} emails this month. Sending stops at the limit until next month. ${upgrade}`,
    )
  }
  if (org.plan === 'growth' && limits.audience !== null && used.audience >= limits.audience) {
    notices.push({
      key: `audience:full:${week}`,
      subject: `${org.name} is at its Growth size`,
      text:
        `Your organization has reached ${n(used.audience)} people this month, at or over the ${n(limits.audience)} your Growth plan covers. ` +
        'Nothing has stopped. Raise your size in Settings → Billing to cover everyone you reach. We’ll remind you weekly while you’re over.',
    })
  }
  const gb = (bytes: number) => `${Math.round(bytes / 1e9)} GB`
  levels(
    'storage',
    used.storage,
    limits.storageBytes,
    (l) => (l === 110 ? `${org.name}’s storage is full` : `${org.name}’s storage is nearly full`),
    (l) =>
      `Your organization is using ${gb(used.storage)} of its ${gb(limits.storageBytes ?? 0)} storage. ` +
      (l === 110 ? 'New files can’t be saved until there’s room; mail keeps arriving. ' : 'Above 110%, new files can’t be saved; mail keeps arriving. ') +
      (org.plan === 'free' ? upgrade : 'Delete files or empty the trash to make room.'),
  )
  const paused = org.plan === 'free' && limits.audience !== null && used.audience > limits.audience * GRACE
  // Only Free pauses; an upgrade lifts it at once, and once paused it stays so for the rest of the month.
  return { notices, paused: org.plan === 'free' && (paused || pausedIn(overSince, month)) }
}

