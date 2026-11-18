// Display helpers for Analytics and person metrics, shared by the Analytics section and its screens. The same
// wording as the web app (apps/app/src/analytics/api.ts, apps/app/src/users/metrics.ts).

import type { FeedEvent, FunnelStep } from './types'

export const TYPE_LABEL = { page: 'Page', track: 'Track', identify: 'Identify', email: 'Email' } as const

const EMAIL_LABEL: Record<string, string> = {
  $email_received: 'Email received',
  $email_replied: 'Email replied',
  $email_sent: 'Email sent',
  $email_bounced: 'Email bounced',
  $email_complained: 'Marked as spam',
}

export function eventLabel(e: FeedEvent): string {
  if (e.type === 'page') return e.path ?? 'Page view'
  if (e.type === 'identify') return 'Identify'
  if (e.type === 'email') return EMAIL_LABEL[e.name] ?? e.name
  if (e.name === '$outbound_click') return `Outbound click${typeof e.properties.domain === 'string' ? ` · ${e.properties.domain}` : ''}`
  return e.name
}

export function whoLabel(p: FeedEvent['person']): string {
  return p.email ?? p.name ?? (p.externalId ? `User ${p.externalId}` : (p.anonymousId ?? p.id).slice(0, 12))
}

export function stepLabel(step: FunnelStep): string {
  if (step.type === 'page') return `Viewed ${step.match}`
  if (step.type === 'email') return EMAIL_LABEL[step.match] ?? step.match
  return step.match
}

export const percent = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`

export function duration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.round(seconds / 360) / 10} h`
  return `${Math.round(seconds / 8640) / 10} d`
}

export function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h`
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

// ---------------------------------------------------------------------------------------------------------------
// Person metrics

type Metrics = Record<string, string | number | boolean>

export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

function timeOnSite(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

/** The person screen's sections: what's known, nothing else. Email counts stay out (the conversations show the mail). */
export function profileSections(m: Metrics): { title: string; rows: [string, string][] }[] {
  const str = (k: string) => (typeof m[k] === 'string' && m[k] ? (m[k] as string) : null)
  const num = (k: string) => (typeof m[k] === 'number' ? (m[k] as number) : null)
  const campaign = (prefix: string) => {
    const parts = ['source', 'medium', 'campaign'].map((k) => str(`${prefix}_utm_${k}`))
    return parts.some(Boolean) ? parts.map((p) => p ?? '—').join(' / ') : null
  }
  const rows = (list: [string, string | number | null][]) => list.filter(([, v]) => v !== null && v !== '').map(([k, v]) => [k, String(v)] as [string, string])
  const country = str('country')
  const place = [...new Set([str('city'), str('region'), country ? countryName(country) : null].filter(Boolean))].join(', ')
  const device = [str('last_device_type'), str('last_browser'), str('last_os')].filter((d): d is string => !!d)
  const revenue = num('revenue_total')
  const days = num('days_to_identify')
  return [
    {
      title: 'Acquisition',
      rows: rows([
        ['First channel', str('initial_channel')],
        ['First campaign', campaign('initial')],
        ['First referrer', str('initial_referring_domain')],
        ['Landing page', str('initial_landing_page')],
        ['Latest channel', str('last_channel') !== str('initial_channel') ? str('last_channel') : null],
      ]),
    },
    {
      title: 'Location & device',
      rows: rows([
        ['Location', place || null],
        ['Time zone', str('timezone')],
        ['Device', device.length ? device.map((d, i) => (i === 0 ? d.charAt(0).toUpperCase() + d.slice(1) : d)).join(' · ') : null],
      ]),
    },
    {
      title: 'Activity',
      rows: rows([
        ['Visits', num('sessions')],
        ['Page views', num('pageviews')],
        ['Days active', num('active_days')],
        ['Time on site', num('engaged_seconds') ? timeOnSite(num('engaged_seconds')!) : null],
        ['Last page', str('last_page')],
        ['Revenue', revenue !== null ? `${revenue.toLocaleString(undefined, { maximumFractionDigits: 2 })}${str('currency') ? ` ${str('currency')}` : ''}` : null],
        ['Orders', num('orders')],
        ['Identified', days === null ? null : days === 0 ? 'On their first day' : `${days} ${days === 1 ? 'day' : 'days'} after first visit`],
      ]),
    },
  ].filter((s) => s.rows.length)
}
