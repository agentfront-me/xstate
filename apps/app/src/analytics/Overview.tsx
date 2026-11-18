// Analytics Overview (design: "xstate App" → Analytics → Overview): six KPI tiles with change and sparkline, the
// visitors-and-visits chart, and cards of top lists (Sources, Pages, Locations with a map, Devices, Events,
// Conversions). Clicking a row adds a filter chip that narrows everything; "View all" opens the full list in a panel.
// Numbers come from visits (api audience/overview.ts). The map outlines are pre-drawn from Natural Earth via
// world-atlas (public domain / ISC) into world-map.json, loaded only when the Overview opens.

import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { errorMessage } from '../lib/core'
import {
  type BreakdownRow,
  type Dimension,
  type Kpis,
  type OverviewData,
  type OverviewFilter,
  type OverviewRange,
  analyticsKeys,
  overviewApi,
} from './api'

const RANGES: { id: OverviewRange; label: string; phrase: string }[] = [
  { id: 'today', label: 'Today', phrase: 'today' },
  { id: '7', label: 'Last 7 days', phrase: 'in the last 7 days' },
  { id: '30', label: 'Last 30 days', phrase: 'in the last 30 days' },
  { id: '90', label: 'Last 90 days', phrase: 'in the last 90 days' },
]

/** Every list on the page but countries, which the map wants in full. */
const LIST_DIMS: Dimension[] = ['channel', 'referrer', 'campaign', 'page', 'landing', 'exit', 'region', 'city', 'device', 'browser', 'os', 'event']

const DIM_LABEL: Record<Dimension, string> = {
  channel: 'Channel',
  referrer: 'Referrer',
  campaign: 'Campaign',
  page: 'Page',
  landing: 'Landing page',
  exit: 'Exit page',
  country: 'Country',
  region: 'Region',
  city: 'City',
  device: 'Device',
  browser: 'Browser',
  os: 'System',
  event: 'Event',
}

/** The lists' names, for the View all panel. */
const DIM_LIST: Record<Dimension, string> = {
  channel: 'Channels',
  referrer: 'Referrers',
  campaign: 'Campaigns',
  page: 'Top pages',
  landing: 'Landing pages',
  exit: 'Exit pages',
  country: 'Countries',
  region: 'Regions',
  city: 'Cities',
  device: 'Device types',
  browser: 'Browsers',
  os: 'Operating systems',
  event: 'Events',
}

let regionNames: Intl.DisplayNames | null = null
const countryName = (code: string) => {
  try {
    regionNames ??= new Intl.DisplayNames(undefined, { type: 'region' })
    return regionNames.of(code.toUpperCase()) ?? code
  } catch {
    return code
  }
}
/** A country's flag from its two letters (regional indicator symbols). */
const flag = (code: string) => (/^[A-Z]{2}$/i.test(code) ? String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '')

/** What a row's key reads as: "google / cpc / fall", "Paris, France", "Mobile". */
export function keyLabel(dim: Dimension, key: string): string {
  if (dim === 'campaign') return key.split('|').map((p) => p || '—').join(' / ')
  if (dim === 'region' || dim === 'city') {
    const [place, country] = key.split('|')
    return country ? `${place}, ${countryName(country)}` : (place ?? key)
  }
  if (dim === 'country') return countryName(key)
  if (dim === 'device') return key.charAt(0).toUpperCase() + key.slice(1)
  return key
}

const n = (x: number) => x.toLocaleString()
const pct = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`
const money = (x: number) => `$${x.toLocaleString(undefined, { maximumFractionDigits: x >= 1000 ? 0 : 2 })}`
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export type OverviewSearch = { period?: OverviewRange; filters?: OverviewFilter[] }

export function Overview({
  orgId,
  domain,
  search,
  setSearch,
  onOpenLive,
  onInstall,
}: {
  orgId: string
  domain?: string
  search: OverviewSearch
  setSearch: (s: OverviewSearch) => void
  onOpenLive: () => void
  onInstall: () => void
}) {
  const range = search.period ?? '30'
  const filters = search.filters ?? []
  const [compare, setCompare] = useState(true)
  const [panel, setPanel] = useState<{ title: string; dims: Dimension[]; tab: Dimension } | null>(null)
  const q = { range, domain, filters }
  const key = [...analyticsKeys.all, 'overview', orgId, range, domain ?? null, JSON.stringify(filters)]
  const overview = useQuery({ queryKey: [...key, 'totals'], queryFn: () => overviewApi.overview(orgId, q), refetchInterval: 60_000 })
  const lists = useQuery({ queryKey: [...key, 'lists'], queryFn: () => overviewApi.breakdown(orgId, q, LIST_DIMS, 8) })
  const countries = useQuery({ queryKey: [...key, 'countries'], queryFn: () => overviewApi.breakdown(orgId, q, ['country'], 200) })

  // The panel belongs to what's on screen: it closes when the range, site or filters change.
  useEffect(() => setPanel(null), [range, domain, JSON.stringify(filters)])

  const addFilter = (dim: Dimension, value: string) => {
    if (filters.some((f) => f.dim === dim && f.value === value)) return
    setSearch({ ...search, filters: [...filters.filter((f) => f.dim !== dim), { dim, value }] })
  }
  const removeFilter = (dim: Dimension) => setSearch({ ...search, filters: filters.filter((f) => f.dim !== dim) })
  const filtered = (dim: Dimension) => filters.find((f) => f.dim === dim)

  const data = overview.data
  const rangeInfo = RANGES.find((r) => r.id === range)!
  const empty = data && data.current.visits === 0 && !filters.length
  const dates = data ? periodLabel(data) : ''
  const totalVisitors = lists.data?.visitors ?? 0
  const listProps = { filtered, onPick: addFilter, onClear: removeFilter, total: totalVisitors }

  return (
    <section className="s-main a-overview-main">
      <div className="col-head drag s-head a-ov-head">
        <div className="grow s-head-text">
          <span className="crumb" aria-current="page">Overview</span>
          <span className="sub">{domain ?? 'All domains'}{dates ? ` · ${dates}` : ''}</span>
        </div>
        <span className="spacer-grow" />
        {data && data.live > 0 && (
          <button className="a-live-pill" onClick={onOpenLive} title="Open Live events">
            <span className="a-badge-dot" />
            <span className="a-live-long">Live: {n(data.live)} {data.live === 1 ? 'visitor' : 'visitors'} in the last 5 minutes</span>
            <span className="a-live-short">{n(data.live)} live</span>
          </button>
        )}
        <label className="a-compare">
          <button className="switch" role="switch" aria-checked={compare} aria-label="Compare to previous period" onClick={() => setCompare((c) => !c)} />
          <span>Compare<span className="a-live-long"> to previous period</span></span>
        </label>
        <select className="select sm a-range" aria-label="Date range" value={range} onChange={(e) => setSearch({ ...search, period: e.target.value as OverviewRange })}>
          {RANGES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      </div>

      {filters.length > 0 && (
        <div className="a-chips">
          {filters.map((f) => (
            <span key={f.dim} className="a-chip">
              {DIM_LABEL[f.dim]} is <strong>{keyLabel(f.dim, f.value)}</strong>
              <button className="ghost" aria-label={`Remove ${DIM_LABEL[f.dim]} filter`} onClick={() => removeFilter(f.dim)}><Icon name="x" size={12} /></button>
            </span>
          ))}
          <button className="link small" onClick={() => setSearch({ ...search, filters: [] })}>Clear all</button>
        </div>
      )}

      <div className="s-scroll">
        {overview.isError ? (
          <div className="empty">
            <Icon name="circle-alert" size={24} />
            <strong>Couldn't load the overview</strong>
            <span>{errorMessage(overview.error)}</span>
            <button className="btn" onClick={() => void overview.refetch()}>Try again</button>
          </div>
        ) : !data ? (
          <Skeleton />
        ) : empty ? (
          <div className="a-ov">
            <div className="a-ov-empty">
              <span className="a-install-icon"><Icon name="chart-line" size={18} /></span>
              <strong className="hi">No page views on {domain ?? 'your sites'} {rangeInfo.phrase}</strong>
              <p className="muted small">No visits were recorded in this range. Check that the install code is on every page, then open Live events and load the site to see visits arrive.</p>
              <div className="row-gap">
                <button className="btn btn-sm" onClick={onInstall}><Icon name="code-xml" size={13} />Install code</button>
                <button className="btn btn-sm" onClick={onOpenLive}><Icon name="activity" size={13} />Open Live events</button>
              </div>
            </div>
          </div>
        ) : (
          <div className="a-ov">
            <Tiles data={data} compare={compare} />
            <Chart data={data} compare={compare} />
            <div className="a-cards">
              <ListCard title="Sources" tabs={[['channel', 'Channels'], ['referrer', 'Referrers'], ['campaign', 'Campaigns']]} lists={lists.data?.lists} loading={lists.isPending} onViewAll={(tab) => setPanel({ title: 'Sources', dims: ['channel', 'referrer', 'campaign'], tab })} {...listProps} />
              <ListCard title="Pages" tabs={[['page', 'Top pages'], ['landing', 'Landing pages'], ['exit', 'Exit pages']]} lists={lists.data?.lists} loading={lists.isPending} onViewAll={(tab) => setPanel({ title: 'Pages', dims: ['page', 'landing', 'exit'], tab })} {...listProps} />
              <ListCard
                title="Locations"
                tabs={[['country', 'Countries'], ['region', 'Regions'], ['city', 'Cities']]}
                lists={{ ...lists.data?.lists, country: countries.data?.lists.country?.slice(0, 8) }}
                loading={lists.isPending || countries.isPending}
                onViewAll={(tab) => setPanel({ title: 'Locations', dims: ['country', 'region', 'city'], tab })}
                top={<WorldMap rows={countries.data?.lists.country ?? []} onPick={(code) => addFilter('country', code)} selected={filtered('country')?.value} />}
                {...listProps}
              />
              <ListCard
                title="Devices"
                tabs={[['device', 'Device type'], ['browser', 'Browsers'], ['os', 'Operating systems']]}
                lists={lists.data?.lists}
                loading={lists.isPending}
                onViewAll={(tab) => setPanel({ title: 'Devices', dims: ['device', 'browser', 'os'], tab })}
                top={(tab) => (tab === 'device' ? <DeviceBar rows={lists.data?.lists.device ?? []} /> : null)}
                {...listProps}
              />
              <EventsCard rows={lists.data?.lists.event ?? []} loading={lists.isPending} filtered={filtered('event')} onPick={(v) => addFilter('event', v)} onClear={() => removeFilter('event')} onViewAll={() => setPanel({ title: 'Events', dims: ['event'], tab: 'event' })} />
              <ConversionsCard lists={lists.data?.lists} loading={lists.isPending} onPick={addFilter} />
            </div>
          </div>
        )}
      </div>

      {panel && (
        <ViewAll
          orgId={orgId}
          query={q}
          title={panel.title}
          dims={panel.dims}
          tab={panel.tab}
          rangeLabel={rangeInfo.label}
          onTab={(tab) => setPanel({ ...panel, tab })}
          onPick={(dim, value) => {
            setPanel(null)
            addFilter(dim, value)
          }}
          onClose={() => setPanel(null)}
        />
      )}
    </section>
  )
}

function periodLabel(d: OverviewData): string {
  const f = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
  return d.range === 'today' ? 'Today' : `${f(d.from)} – ${f(d.to)}`
}

// ---------------------------------------------------------------------------------------------------------------
// KPI tiles

const TILES: { key: keyof Kpis; label: string; format: (v: number) => string; lowerIsBetter?: boolean }[] = [
  { key: 'visitors', label: 'Visitors', format: n },
  { key: 'visits', label: 'Visits', format: n },
  { key: 'pageviews', label: 'Page views', format: n },
  { key: 'bounceRate', label: 'Bounce rate', format: pct, lowerIsBetter: true },
  { key: 'avgDuration', label: 'Avg. visit duration', format: duration },
  { key: 'revenue', label: 'Revenue', format: money },
]

function Tiles({ data, compare }: { data: OverviewData; compare: boolean }) {
  return (
    <div className="a-tiles">
      {TILES.map((t) => {
        const now = data.current[t.key]
        const before = data.previous[t.key]
        const change = before ? (now - before) / before : null
        return (
          <div className="a-tile" key={t.key}>
            <span className="muted small">{t.label}</span>
            <span className="a-tile-value">
              <strong>{t.format(now)}</strong>
              {compare && change !== null && Math.abs(change) >= 0.0005 && (
                <span className="a-change small" title={`${t.format(before)} the period before`}>
                  {change > 0 ? '↗' : '↘'} {pct(Math.abs(change))}
                </span>
              )}
            </span>
            {t.key === 'revenue' && <span className="dim small">{n(data.current.orders)} {data.current.orders === 1 ? 'order' : 'orders'}</span>}
            <Sparkline values={data.series.map((p) => p[t.key])} />
          </div>
        )
      })}
    </div>
  )
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="a-spark" aria-hidden="true" />
  const max = Math.max(...values, 0) || 1
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - (v / max) * 26}`).join(' ')
  return (
    <svg className="a-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Visitors and visits

function niceMax(v: number): number {
  if (v <= 4) return 4
  const p = 10 ** Math.floor(Math.log10(v))
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!
}

function Chart({ data, compare }: { data: OverviewData; compare: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  const box = useRef<SVGSVGElement>(null)
  const W = 1000
  const H = 220
  // Today stops at the current hour: the hours still to come aren't zero, they haven't happened.
  const upto = data.range === 'today' ? new Date().getHours() + 1 : data.series.length
  const series = data.series.slice(0, upto)
  const prev = data.previousSeries.slice(0, upto)
  const max = niceMax(Math.max(...series.map((p) => Math.max(p.visitors, p.visits)), ...(compare ? prev.map((p) => p.visitors) : []), 1))
  const x = (i: number) => (series.length < 2 ? W / 2 : (i / (series.length - 1)) * W)
  const y = (v: number) => H - (v / max) * H
  const line = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const visitors = line(series.map((p) => p.visitors))
  const area = `${visitors}L${W},${H}L0,${H}Z`
  const label = (t: string) =>
    data.bucket === 'hour'
      ? new Date(`${t}:00:00`).toLocaleTimeString([], { hour: 'numeric' })
      : new Date(`${t}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })
  const ticks = series.length <= 8 ? series.map((_, i) => i) : Array.from({ length: 7 }, (_, k) => Math.round((k / 6) * (series.length - 1)))

  const onMove = (e: React.MouseEvent) => {
    const r = box.current?.getBoundingClientRect()
    if (!r) return
    const i = Math.round(((e.clientX - r.left) / r.width) * (series.length - 1))
    setHover(Math.max(0, Math.min(series.length - 1, i)))
  }
  const h = hover !== null ? series[hover] : null

  return (
    <div className="a-card a-chart-card">
      <div className="a-card-head">
        <strong className="hi">Visitors and visits</strong>
        <span className="a-legend small muted">
          <span><i className="a-key a-key-visitors" />Visitors</span>
          <span><i className="a-key a-key-visits" />Visits</span>
          {compare && <span><i className="a-key a-key-prev" />Visitors, previous period</span>}
        </span>
      </div>
      <div className="a-chart">
        <div className="a-yaxis small dim">
          {[1, 0.75, 0.5, 0.25, 0].map((f) => <span key={f}>{n(Math.round(max * f))}</span>)}
        </div>
        <div className="a-plot" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <svg ref={box} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="a-svg" role="img" aria-label="Visitors and visits over time">
            {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="a-grid" vectorEffect="non-scaling-stroke" />)}
            <path d={area} className="a-area" />
            {compare && <path d={line(prev.map((p) => p.visitors))} className="a-line-prev" vectorEffect="non-scaling-stroke" />}
            <path d={line(series.map((p) => p.visits))} className="a-line-visits" vectorEffect="non-scaling-stroke" />
            <path d={visitors} className="a-line-visitors" vectorEffect="non-scaling-stroke" />
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1="0" y2={H} className="a-cursor" vectorEffect="non-scaling-stroke" />}
          </svg>
          {h && hover !== null && (
            <div className="a-tip small" style={{ left: `${(x(hover) / W) * 100}%` }}>
              <strong className="hi">{label(h.t)}{hover === series.length - 1 ? ' (so far)' : ''}</strong>
              <span>{n(h.visitors)} visitors · {n(h.visits)} visits</span>
              {compare && prev[hover] && <span className="dim">{n(prev[hover]!.visitors)} visitors the period before</span>}
            </div>
          )}
          <div className="a-xaxis small dim">
            {ticks.map((i) => <span key={i} style={{ left: `${(x(i) / W) * 100}%` }}>{label(series[i]!.t)}</span>)}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Top lists

type ListProps = {
  filtered: (dim: Dimension) => OverviewFilter | undefined
  onPick: (dim: Dimension, value: string) => void
  onClear: (dim: Dimension) => void
  total: number
}

function ListCard({
  title,
  tabs,
  lists,
  loading,
  onViewAll,
  top,
  filtered,
  onPick,
  onClear,
  total,
}: ListProps & {
  title: string
  tabs: [Dimension, string][]
  lists?: Partial<Record<Dimension, BreakdownRow[] | undefined>>
  loading: boolean
  onViewAll: (tab: Dimension) => void
  top?: ReactNode | ((tab: Dimension) => ReactNode)
}) {
  const [tab, setTab] = useState<Dimension>(tabs[0]![0])
  const rows = lists?.[tab] ?? []
  const f = filtered(tab)
  return (
    <div className="a-card a-list-card">
      <div className="a-card-head">
        <strong className="hi">{title}</strong>
        <div className="seg" role="group" aria-label={`${title} by`}>
          {tabs.map(([d, label]) => <button key={d} type="button" aria-pressed={tab === d} onClick={() => setTab(d)}>{label}</button>)}
        </div>
      </div>
      {typeof top === 'function' ? top(tab) : tab === tabs[0]![0] || title !== 'Locations' ? top : null}
      <Rows dim={tab} rows={rows} loading={loading} total={total} filtered={f} onPick={onPick} onClear={onClear} />
      {rows.length > 0 && !f && (
        <button className="link small a-view-all" onClick={() => onViewAll(tab)}>View all <Icon name="chevron-right" size={12} /></button>
      )}
    </div>
  )
}

function Rows({
  dim,
  rows,
  loading,
  total,
  filtered,
  onPick,
  onClear,
}: {
  dim: Dimension
  rows: BreakdownRow[]
  loading: boolean
  total: number
  filtered?: OverviewFilter
  onPick: (dim: Dimension, value: string) => void
  onClear: (dim: Dimension) => void
}) {
  if (loading) return <div className="a-rows-loading"><span className="spinner" /></div>
  // A list filtered to one value shows just that row, and says so.
  const shown = filtered ? rows.filter((r) => r.key === filtered.value) : rows
  const max = Math.max(...shown.map((r) => r.visitors), 1)
  return (
    <div className="a-rows" role="table" aria-label={DIM_LABEL[dim]}>
      <div className="a-row-head small dim" role="row">
        <span role="columnheader">{DIM_LABEL[dim]}</span>
        <span role="columnheader" className="num">Visitors</span>
        <span role="columnheader" className="num">%</span>
      </div>
      {shown.length === 0 ? (
        <p className="dim small a-none">Nothing {filtered ? 'for this filter' : 'yet'} in this range.</p>
      ) : (
        shown.map((r) => (
          <button
            key={r.key}
            role="row"
            className="a-list-row"
            title={`${n(r.visitors)} visitors · ${total ? pct(r.visitors / total) : '0%'} · ${n(r.visits)} visits`}
            onClick={() => onPick(dim, r.key)}
          >
            <span className="a-bar" style={{ width: `${(r.visitors / max) * 100}%` }} />
            <span role="cell" className="a-row-label">
              <RowIcon dim={dim} value={r.key} />
              <span className={`ellipsis${dim === 'page' || dim === 'landing' || dim === 'exit' ? ' mono' : ''}`}>{keyLabel(dim, r.key)}</span>
            </span>
            <span role="cell" className="num hi">{n(r.visitors)}</span>
            <span role="cell" className="num muted">{total ? pct(r.visitors / total) : '—'}</span>
          </button>
        ))
      )}
      {filtered && (
        <p className="dim small a-filtered-note">
          Filtered to {keyLabel(dim, filtered.value)} · <button className="link small" onClick={() => onClear(dim)}>Clear</button>
        </p>
      )}
    </div>
  )
}

function RowIcon({ dim, value }: { dim: Dimension; value: string }) {
  if (dim === 'country') return <span className="a-flag" aria-hidden="true">{flag(value)}</span>
  if (dim === 'region' || dim === 'city') return <span className="a-flag" aria-hidden="true">{flag(value.split('|')[1] ?? '')}</span>
  // No favicons: fetching them would tell a third party which sites send you visitors.
  if (dim === 'referrer') return <span className="a-letter" aria-hidden="true">{value.replace(/^www\./, '').charAt(0).toUpperCase()}</span>
  return null
}

function DeviceBar({ rows }: { rows: BreakdownRow[] }) {
  const total = rows.reduce((s, r) => s + r.visitors, 0)
  if (!total) return null
  const order = ['mobile', 'desktop', 'tablet']
  const sorted = [...rows].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  return (
    <div className="a-devbar">
      <div className="a-devbar-track">
        {sorted.map((r, i) => <span key={r.key} className={`a-devbar-seg a-shade-${i}`} style={{ width: `${(r.visitors / total) * 100}%` }} />)}
      </div>
      <div className="a-devbar-legend small">
        {sorted.map((r, i) => (
          <span key={r.key}><i className={`a-key a-shade-${i}`} />{keyLabel('device', r.key)} <strong className="hi">{Math.round((r.visitors / total) * 100)}%</strong></span>
        ))}
      </div>
    </div>
  )
}

function EventsCard({ rows, loading, filtered, onPick, onClear, onViewAll }: { rows: BreakdownRow[]; loading: boolean; filtered?: OverviewFilter; onPick: (v: string) => void; onClear: () => void; onViewAll: () => void }) {
  const shown = filtered ? rows.filter((r) => r.key === filtered.value) : rows
  const max = Math.max(...shown.map((r) => r.count ?? 0), 1)
  return (
    <div className="a-card a-list-card">
      <div className="a-card-head"><strong className="hi">Events</strong></div>
      {loading ? (
        <div className="a-rows-loading"><span className="spinner" /></div>
      ) : (
        <div className="a-rows" role="table" aria-label="Events">
          <div className="a-row-head a-row-3 small dim" role="row">
            <span role="columnheader">Event</span>
            <span role="columnheader" className="num">Count</span>
            <span role="columnheader" className="num">People</span>
          </div>
          {shown.length === 0 ? (
            <p className="dim small a-none">No events of your own in this range. Send them with xstate('track', …).</p>
          ) : (
            shown.map((r) => (
              <button key={r.key} role="row" className="a-list-row a-row-3" title={`${n(r.count ?? 0)} times by ${n(r.visitors)} people`} onClick={() => onPick(r.key)}>
                <span className="a-bar" style={{ width: `${((r.count ?? 0) / max) * 100}%` }} />
                <span role="cell" className="a-row-label"><span className="ellipsis">{r.key}</span></span>
                <span role="cell" className="num hi">{n(r.count ?? 0)}</span>
                <span role="cell" className="num muted">{n(r.visitors)}</span>
              </button>
            ))
          )}
          {filtered && (
            <p className="dim small a-filtered-note">Filtered to {filtered.value} · <button className="link small" onClick={onClear}>Clear</button></p>
          )}
        </div>
      )}
      {shown.length > 0 && !filtered && <button className="link small a-view-all" onClick={onViewAll}>View all <Icon name="chevron-right" size={12} /></button>}
    </div>
  )
}

function ConversionsCard({ lists, loading, onPick }: { lists?: Partial<Record<Dimension, BreakdownRow[]>>; loading: boolean; onPick: (dim: Dimension, value: string) => void }) {
  const [tab, setTab] = useState<'channel' | 'campaign'>('channel')
  const rows = (lists?.[tab] ?? []).filter((r) => (r.revenue ?? 0) > 0).sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0))
  const max = Math.max(...rows.map((r) => r.revenue ?? 0), 1)
  return (
    <div className="a-card a-list-card">
      <div className="a-card-head">
        <strong className="hi">Conversions</strong>
        <div className="seg" role="group" aria-label="Conversions by">
          <button type="button" aria-pressed={tab === 'channel'} onClick={() => setTab('channel')}>By channel</button>
          <button type="button" aria-pressed={tab === 'campaign'} onClick={() => setTab('campaign')}>By campaign</button>
        </div>
      </div>
      {loading ? (
        <div className="a-rows-loading"><span className="spinner" /></div>
      ) : (
        <div className="a-rows" role="table" aria-label="Conversions">
          <div className="a-row-head a-row-4 small dim" role="row">
            <span role="columnheader">{tab === 'channel' ? 'Channel' : 'Campaign'}</span>
            <span role="columnheader" className="num">Revenue</span>
            <span role="columnheader" className="num">Orders</span>
            <span role="columnheader" className="num">Conv.</span>
          </div>
          {rows.length === 0 ? (
            <p className="dim small a-none">No revenue in this range. Add a "revenue" property to the events that earn money.</p>
          ) : (
            rows.map((r) => (
              <button key={r.key} role="row" className="a-list-row a-row-4" title={`${n(r.converted ?? 0)} of ${n(r.visits)} visits converted`} onClick={() => onPick(tab, r.key)}>
                <span className="a-bar" style={{ width: `${((r.revenue ?? 0) / max) * 100}%` }} />
                <span role="cell" className="a-row-label"><span className="ellipsis">{keyLabel(tab, r.key)}</span></span>
                <span role="cell" className="num hi">{money(r.revenue ?? 0)}</span>
                <span role="cell" className="num muted">{n(r.orders ?? 0)}</span>
                <span role="cell" className="num muted">{r.visits ? pct((r.converted ?? 0) / r.visits) : '—'}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Map

type Paths = Record<string, string>

function WorldMap({ rows, onPick, selected }: { rows: BreakdownRow[]; onPick: (code: string) => void; selected?: string }) {
  const [paths, setPaths] = useState<Paths | null>(null)
  useEffect(() => {
    let live = true
    void import('./world-map.json').then((m) => live && setPaths(m.default as Paths))
    return () => {
      live = false
    }
  }, [])
  const byCode = useMemo(() => new Map(rows.map((r) => [r.key, r.visitors])), [rows])
  const max = Math.max(...rows.map((r) => r.visitors), 1)
  if (!paths) return <div className="a-map a-map-loading" />
  return (
    <svg className="a-map" viewBox="0 0 800 400" role="img" aria-label="Visitors by country">
      {Object.entries(paths).map(([code, d]) => {
        const v = byCode.get(code) ?? 0
        // Square root so small countries still show; five steps of grey.
        const level = v ? Math.min(4, Math.ceil(Math.sqrt(v / max) * 4)) : 0
        return (
          <path key={code} d={d} className={`a-country a-level-${level}${selected === code ? ' is-selected' : ''}`} onClick={() => v && onPick(code)}>
            <title>{`${countryName(code)}: ${n(v)} ${v === 1 ? 'visitor' : 'visitors'}`}</title>
          </path>
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// View all

type SortKey = 'key' | 'visitors' | 'share' | 'visits'

function ViewAll({
  orgId,
  query,
  title,
  dims,
  tab,
  rangeLabel,
  onTab,
  onPick,
  onClose,
}: {
  orgId: string
  query: { range: OverviewRange; domain?: string; filters: OverviewFilter[] }
  title: string
  dims: Dimension[]
  tab: Dimension
  rangeLabel: string
  onTab: (d: Dimension) => void
  onPick: (dim: Dimension, value: string) => void
  onClose: () => void
}) {
  const [sort, setSort] = useState<{ by: SortKey; desc: boolean }>({ by: 'visitors', desc: true })
  const list = useQuery({
    queryKey: [...analyticsKeys.all, 'overview-all', orgId, JSON.stringify(query), tab],
    queryFn: () => overviewApi.breakdown(orgId, query, [tab], 200),
  })
  const opener = useRef<Element | null>(document.activeElement)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const back = opener.current
    return () => {
      window.removeEventListener('keydown', onKey)
      // Back to the "View all" that opened it.
      if (back instanceof HTMLElement && back.isConnected) back.focus()
    }
  }, [onClose])
  const total = list.data?.visitors ?? 0
  const rows = [...(list.data?.lists[tab] ?? [])].sort((a, b) => {
    const v = (r: BreakdownRow) => (sort.by === 'key' ? keyLabel(tab, r.key) : sort.by === 'visits' ? r.visits : sort.by === 'share' ? r.visitors : tab === 'event' ? (r.count ?? 0) : r.visitors)
    const x = v(a)
    const y = v(b)
    const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)
    return sort.desc ? -c : c
  })
  const head = (by: SortKey, label: string, cls = 'num') => (
    <button className={`a-sort ${cls}`} onClick={() => setSort((s) => ({ by, desc: s.by === by ? !s.desc : by !== 'key' }))} aria-sort={sort.by === by ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      {label}{sort.by === by ? (sort.desc ? ' ↓' : ' ↑') : ''}
    </button>
  )
  return (
    <aside className="u-panel a-all" aria-label={`${title}: all`}>
      <div className="u-panel-head">
        <div className="u-panel-title">
          <strong className="hi">{title === DIM_LIST[tab] ? title : `${title} · ${DIM_LIST[tab]}`}</strong>
          <span className="muted small">{rows.length} rows · {rangeLabel} · click a row to filter</span>
        </div>
        <button className="ghost" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      {dims.length > 1 && (
        <div className="a-all-tabs">
          <div className="seg" role="group" aria-label="List">
            {dims.map((d) => <button key={d} type="button" aria-pressed={tab === d} onClick={() => onTab(d)}>{DIM_LIST[d]}</button>)}
          </div>
        </div>
      )}
      <div className="u-panel-scroll">
        {list.isPending ? (
          <div className="loading"><span className="spinner" /></div>
        ) : (
          <div className="a-all-table" role="table">
            <div className="a-all-row a-all-head small dim" role="row">
              {head('key', DIM_LABEL[tab], '')}
              {head('visitors', tab === 'event' ? 'Count' : 'Visitors')}
              {head('share', '% visitors', 'num a-wide')}
              {head('visits', 'Visits', 'num a-wide')}
            </div>
            {rows.map((r) => (
              <button key={r.key} className="a-all-row" role="row" onClick={() => onPick(tab, r.key)}>
                <span className="a-row-label"><RowIcon dim={tab} value={r.key} /><span className="ellipsis">{keyLabel(tab, r.key)}</span></span>
                <span className="num hi">{n(tab === 'event' ? (r.count ?? 0) : r.visitors)}</span>
                <span className="num muted a-wide">{total ? pct(r.visitors / total) : '—'}</span>
                <span className="num muted a-wide">{n(r.visits)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function Skeleton() {
  return (
    <div className="a-ov" aria-busy="true" aria-label="Loading">
      <div className="a-tiles">{Array.from({ length: 6 }, (_, i) => <div key={i} className="a-tile"><span className="a-sk a-sk-sm" /><span className="a-sk a-sk-lg" /><span className="a-sk a-sk-spark" /></div>)}</div>
      <div className="a-card"><span className="a-sk a-sk-chart" /></div>
      <div className="a-cards">{Array.from({ length: 4 }, (_, i) => <div key={i} className="a-card"><span className="a-sk a-sk-list" /></div>)}</div>
    </div>
  )
}
