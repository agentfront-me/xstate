// The numbers and rules behind sending limits and suspension (./sending). No runtime imports, so `pnpm test` runs
// this file directly under Node.

import type { Reputation, Usage } from '../db/sending'

/** Outside recipients allowed per rolling hour and rolling day. */
export const LIMITS = {
  mailbox: { hour: 100, day: 500 },
  organization: { hour: 400, day: 2000 },
}

/**
 * Suspend when, over the last 7 days, both the count and the rate reach these. The minimum counts stop one bad
 * address from suspending a low-volume sender; the rates sit well below SES's 5% and 0.1%.
 */
export const SUSPEND = {
  days: 7,
  bounceRate: 0.03,
  complaintRate: 0.0005,
  mailbox: { bounces: 10, complaints: 3 },
  organization: { bounces: 25, complaints: 5 },
}

/** Which cap usage (including the send being checked) has gone past, worded for the error, or null. */
export function overLimit(u: Usage): string | null {
  if (u.mailboxHour > LIMITS.mailbox.hour) return `${LIMITS.mailbox.hour} outside recipients an hour from one mailbox`
  if (u.mailboxDay > LIMITS.mailbox.day) return `${LIMITS.mailbox.day} outside recipients a day from one mailbox`
  if (u.orgHour > LIMITS.organization.hour) return `${LIMITS.organization.hour} outside recipients an hour for your organization`
  if (u.orgDay > LIMITS.organization.day) return `${LIMITS.organization.day} outside recipients a day for your organization`
  return null
}

/** Whether this record of a mailbox or organization calls for a suspension, and why. */
export function judge(
  rep: Reputation,
  min: { bounces: number; complaints: number },
): { reason: 'bounces' | 'complaints'; detail: string } | null {
  // Every message SES accepted ends as a delivery or a bounce (complaints come on top of deliveries).
  const sent = Math.max(rep.delivered + rep.bounces, 1)
  const pct = (n: number) => `${((n / sent) * 100).toFixed(2)}%`
  if (rep.complaints >= min.complaints && rep.complaints / sent >= SUSPEND.complaintRate) {
    return { reason: 'complaints', detail: `${rep.complaints} spam complaints out of ${sent} recipients in ${SUSPEND.days} days (${pct(rep.complaints)})` }
  }
  if (rep.bounces >= min.bounces && rep.bounces / sent >= SUSPEND.bounceRate) {
    return { reason: 'bounces', detail: `${rep.bounces} hard bounces out of ${sent} recipients in ${SUSPEND.days} days (${pct(rep.bounces)})` }
  }
  return null
}
