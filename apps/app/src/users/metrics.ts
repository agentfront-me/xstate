// Person metrics: what xstate works out from someone's activity (api audience/metrics.ts), with the labels the
// profile panel and the segment builder use. Keys and types match METRICS in api audience/types.ts.

import type { Attributes } from './api'

export type MetricType = 'string' | 'number' | 'boolean'

export const METRICS: Record<string, { label: string; type: MetricType; group: 'Acquisition' | 'Location & device' | 'Activity' | 'Email' }> = {
  initial_channel: { label: 'First channel', type: 'string', group: 'Acquisition' },
  initial_utm_source: { label: 'First UTM source', type: 'string', group: 'Acquisition' },
  initial_utm_medium: { label: 'First UTM medium', type: 'string', group: 'Acquisition' },
  initial_utm_campaign: { label: 'First UTM campaign', type: 'string', group: 'Acquisition' },
  initial_referring_domain: { label: 'First referrer', type: 'string', group: 'Acquisition' },
  initial_landing_page: { label: 'Landing page', type: 'string', group: 'Acquisition' },
  last_channel: { label: 'Latest channel', type: 'string', group: 'Acquisition' },
  last_utm_source: { label: 'Latest UTM source', type: 'string', group: 'Acquisition' },
  last_utm_campaign: { label: 'Latest UTM campaign', type: 'string', group: 'Acquisition' },
  country: { label: 'Country', type: 'string', group: 'Location & device' },
  region: { label: 'Region', type: 'string', group: 'Location & device' },
  city: { label: 'City', type: 'string', group: 'Location & device' },
  last_browser: { label: 'Browser', type: 'string', group: 'Location & device' },
  last_os: { label: 'Operating system', type: 'string', group: 'Location & device' },
  last_device_type: { label: 'Device type', type: 'string', group: 'Location & device' },
  last_page: { label: 'Last page', type: 'string', group: 'Activity' },
  last_event: { label: 'Last event', type: 'string', group: 'Activity' },
  sessions: { label: 'Visits', type: 'number', group: 'Activity' },
  pageviews: { label: 'Page views', type: 'number', group: 'Activity' },
  events: { label: 'Events', type: 'number', group: 'Activity' },
  active_days: { label: 'Days active', type: 'number', group: 'Activity' },
  engaged_seconds: { label: 'Time on site (seconds)', type: 'number', group: 'Activity' },
  revenue_total: { label: 'Revenue', type: 'number', group: 'Activity' },
  orders: { label: 'Orders', type: 'number', group: 'Activity' },
  days_to_identify: { label: 'Days to identify', type: 'number', group: 'Activity' },
  emails_received: { label: 'Emails received', type: 'number', group: 'Email' },
  emails_sent: { label: 'Emails sent', type: 'number', group: 'Email' },
  emails_replied: { label: 'Emails replied', type: 'number', group: 'Email' },
  email_bounced: { label: 'Email bounced', type: 'boolean', group: 'Email' },
  email_complained: { label: 'Marked mail as spam', type: 'boolean', group: 'Email' },
}

export const METRIC_GROUPS = ['Acquisition', 'Location & device', 'Activity', 'Email'] as const

let regions: Intl.DisplayNames | null = null
/** "PK" → "Pakistan". */
export function countryName(code: string): string {
  try {
    regions ??= new Intl.DisplayNames(undefined, { type: 'region' })
    return regions.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}

/** "1h 5m", "42s". */
export function timeOnSite(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

const str = (m: Attributes, k: string) => (typeof m[k] === 'string' && m[k] ? (m[k] as string) : null)
const num = (m: Attributes, k: string) => (typeof m[k] === 'number' ? (m[k] as number) : null)

/** "google / cpc / fall" from the first or latest UTM tags. */
function campaign(m: Attributes, prefix: 'initial' | 'last'): string | null {
  const parts = ['source', 'medium', 'campaign'].map((k) => str(m, `${prefix}_utm_${k}`))
  return parts.some(Boolean) ? parts.map((p) => p ?? '—').join(' / ') : null
}

function identifiedAfter(days: number | null): string | null {
  if (days === null) return null
  return days === 0 ? 'On their first day' : `${days} ${days === 1 ? 'day' : 'days'} after first visit`
}

export type MetricRow = { label: string; value: string; mono?: boolean; title?: string }

/** The profile panel's sections, leaving out what isn't known. Email counts stay out: the timeline shows the mail. */
export function profileSections(m: Attributes): { title: string; rows: MetricRow[] }[] {
  const rows = (list: (MetricRow | null)[]) => list.filter((r): r is MetricRow => !!r)
  const row = (label: string, value: string | number | null, extra?: Partial<MetricRow>): MetricRow | null =>
    value === null || value === '' ? null : { label, value: String(value), ...extra }

  const country = str(m, 'country')
  // "Islamabad, Pakistan", not "Islamabad, Islamabad, Pakistan" when the city is also the region.
  const place = [...new Set([str(m, 'city'), str(m, 'region'), country ? countryName(country) : null].filter(Boolean))].join(', ')
  const device = [str(m, 'last_device_type'), str(m, 'last_browser'), str(m, 'last_os')].filter((d): d is string => !!d)
  const revenue = num(m, 'revenue_total')
  const currency = str(m, 'currency')

  return [
    {
      title: 'Acquisition',
      rows: rows([
        row('First channel', str(m, 'initial_channel')),
        row('First campaign', campaign(m, 'initial')),
        row('First referrer', str(m, 'initial_referring_domain')),
        row('Landing page', str(m, 'initial_landing_page'), { mono: true }),
        // Latest touch only when it differs from the first.
        row('Latest channel', str(m, 'last_channel') !== str(m, 'initial_channel') ? str(m, 'last_channel') : null),
        row('Latest campaign', campaign(m, 'last') !== campaign(m, 'initial') ? campaign(m, 'last') : null),
      ]),
    },
    {
      title: 'Location & device',
      rows: rows([
        row('Location', place || null),
        row('Time zone', str(m, 'timezone')),
        row('Device', device.length ? device.map((d, i) => (i === 0 ? d.charAt(0).toUpperCase() + d.slice(1) : d)).join(' · ') : null),
        row('Browsers used', num(m, 'devices_used') && num(m, 'devices_used')! > 1 ? num(m, 'devices_used') : null),
      ]),
    },
    {
      title: 'Activity',
      rows: rows([
        row('Visits', num(m, 'sessions')),
        row('Page views', num(m, 'pageviews')),
        row('Days active', num(m, 'active_days')),
        row('Time on site', num(m, 'engaged_seconds') ? timeOnSite(num(m, 'engaged_seconds')!) : null),
        row('Last page', str(m, 'last_page'), { mono: true }),
        row('Last event', str(m, 'last_event')),
        row('Revenue', revenue !== null ? `${revenue.toLocaleString(undefined, { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}` : null),
        row('Orders', num(m, 'orders')),
        row('Identified', identifiedAfter(num(m, 'days_to_identify'))),
      ]),
    },
  ].filter((s) => s.rows.length)
}
