// Analytics: what visitors do on the organization's websites, as it happens (the analytics_* API, analytics/api.ts).
// Follows the Analytics screens of the "xstate App" design: a side list (Live events; Install code at the foot),
// the live feed with type tabs and search, an event panel with the full JSON, and "Connect analytics" until the
// first event arrives, and funnels (Funnels.tsx). Where you are lives in the URL
// (#/analytics?view=install&type=track&q=…&event=…, or ?funnel=<id>&range=30).

import '../styles/storage.css'
import '../styles/users.css'
import '../styles/analytics.css'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ConfirmDialog } from '../storage/dialogs'
import { FunnelDialog, FunnelView } from './Funnels'
import { Overview } from './Overview'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { useAccount } from '../lib/account'
import { copyText, errorMessage, SITE_URL } from '../lib/core'
import { useDomainScope } from '../lib/scope'
import {
  API_ORIGIN,
  type AnalyticsStatus,
  type EventType,
  type FeedEvent,
  type Funnel,
  type FunnelRange,
  type OverviewFilter,
  type OverviewRange,
  TYPE_LABEL,
  ago,
  analyticsApi,
  analyticsKeys,
  eventJson,
  eventLabel,
  percent,
  propertiesLine,
  whoLabel,
} from './api'

/** No view (and no funnel) is the Overview; `period` and `filters` are its range and filter chips. */
export type AnalyticsSearch = {
  view?: 'install' | 'live'
  type?: EventType
  q?: string
  event?: number
  funnel?: string
  range?: FunnelRange
  period?: OverviewRange
  filters?: OverviewFilter[]
}

type Dialog = { kind: 'new' } | { kind: 'edit'; funnel: Funnel } | { kind: 'delete'; funnel: Funnel }

const TYPES: (EventType | undefined)[] = [undefined, 'page', 'track', 'email', 'identify']
const POLL_MS = 3000
const MAX_ROWS = 500
const DOCS_URL = `${SITE_URL}/docs/analytics`

export function AnalyticsPage({ search }: { search: AnalyticsSearch }) {
  const account = useAccount()
  if (account.mode === 'demo') {
    return (
      <section className="soon">
        <div className="col-head drag"><span className="title">Analytics</span></div>
        <div className="empty">
          <Icon name="chart-line" size={28} />
          <strong>Analytics needs a signed-in account</strong>
          <span>Sign in to see what visitors do on your websites as it happens.</span>
        </div>
      </section>
    )
  }
  return <Analytics orgId={account.org.id} search={search} defaultDomain={account.domains[0]?.name} />
}

function Analytics({ orgId, search, defaultDomain }: { orgId: string; search: AnalyticsSearch; defaultDomain?: string }) {
  const navigate = useNavigate()
  const go = (next: AnalyticsSearch, replace = false) => void navigate({ to: '/analytics', search: next, replace })
  const domain = useDomainScope()?.name
  const status = useQuery({
    queryKey: [...analyticsKeys.all, 'status', domain ?? null],
    queryFn: () => analyticsApi.status(orgId, domain),
    // Until the first event arrives the install screen waits for it ("This page updates once an event comes in").
    refetchInterval: (q) => (q.state.data && !q.state.data.lastEventAt ? POLL_MS : false),
  })
  const connected = !!status.data?.lastEventAt
  const install = search.view === 'install' || (status.data && !connected)
  const client = useQueryClient()
  const funnels = useQuery({ queryKey: [...analyticsKeys.all, 'funnels', domain ?? null], queryFn: () => analyticsApi.funnels(orgId, domain), enabled: connected })
  const canManage = !!funnels.data?.canManage
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const funnel = !install && search.funnel ? search.funnel : undefined
  const refreshFunnels = () => client.invalidateQueries({ queryKey: analyticsKeys.all })

  const saveFunnel = async (input: Parameters<typeof analyticsApi.createFunnel>[1], existing?: Funnel) => {
    if (existing) await analyticsApi.updateFunnel(orgId, existing.id, input)
    else {
      const { funnel: created } = await analyticsApi.createFunnel(orgId, input)
      go({ funnel: created.id })
    }
    void refreshFunnels()
    toast(existing ? `Saved ${input.name}` : `Created ${input.name}`)
  }

  return (
    <div className="storage users analytics">
      <aside className="s-side a-side" aria-label="Analytics">
        <div className="col-head drag s-side-head">
          <span className="title grow">Analytics</span>
          {canManage && <button className="ghost" title="New funnel" aria-label="New funnel" onClick={() => setDialog({ kind: 'new' })}><Icon name="plus" size={16} /></button>}
        </div>
        <nav className="s-sections">
          <button className="s-section" aria-current={!install && !funnel && search.view !== 'live' ? 'true' : undefined} onClick={() => go({ period: search.period })} disabled={!connected}>
            <span className="s-tile"><Icon name="layout-dashboard" size={15} /></span>
            <span className="s-section-name">Overview</span>
          </button>
          <button className="s-section" aria-current={search.view === 'live' && !install ? 'true' : undefined} onClick={() => go({ view: 'live' })} disabled={!connected}>
            <span className="s-tile"><Icon name="activity" size={15} /></span>
            <span className="s-section-name">Live events</span>
            {connected && <span className="a-live-dot" aria-hidden="true" />}
          </button>
          {connected && (
            <>
              <div className="u-side-label">Funnels</div>
              {(funnels.data?.funnels ?? []).map((f) => (
                <button key={f.id} className="s-section" aria-current={funnel === f.id ? 'true' : undefined} onClick={() => go({ funnel: f.id, range: search.range })}>
                  <span className="s-tile"><Icon name="funnel" size={15} /></span>
                  <span className="s-section-name">{f.name}</span>
                  <span className="s-section-meta">{percent(f.conversion)}</span>
                </button>
              ))}
              {canManage ? (
                <button className="s-section a-new-funnel" onClick={() => setDialog({ kind: 'new' })}>
                  <span className="s-tile"><Icon name="plus" size={15} /></span>
                  <span className="s-section-name">New funnel</span>
                </button>
              ) : (
                funnels.data && !funnels.data.funnels.length && <p className="dim small a-side-note">No funnels yet.</p>
              )}
            </>
          )}
        </nav>
        <div className="a-side-foot">
          <button className="s-section" aria-current={install && connected ? 'true' : undefined} onClick={() => go({ view: 'install' })}>
            <span className="s-tile"><Icon name="code-xml" size={15} /></span>
            <span className="s-section-name">Install code</span>
          </button>
        </div>
      </aside>

      {status.isPending ? (
        <section className="s-main"><div className="loading"><span className="spinner" /></div></section>
      ) : status.isError ? (
        <section className="s-main">
          <div className="empty">
            <Icon name="circle-alert" size={24} />
            <strong>Couldn't load analytics</strong>
            <span>{errorMessage(status.error)}</span>
            <button className="btn" onClick={() => void status.refetch()}>Try again</button>
          </div>
        </section>
      ) : install ? (
        <Install orgId={orgId} status={status.data} domain={domain ?? defaultDomain} onOpenLive={() => go({ view: 'live' })} />
      ) : funnel ? (
        <FunnelView
          key={funnel}
          orgId={orgId}
          funnelId={funnel}
          domain={domain}
          range={search.range ?? 30}
          canManage={canManage}
          onRange={(range) => go({ funnel, range }, true)}
          onEdit={(f) => setDialog({ kind: 'edit', funnel: f })}
          onDelete={(f) => setDialog({ kind: 'delete', funnel: f })}
        />
      ) : search.view === 'live' ? (
        <LiveEvents orgId={orgId} domain={domain} search={search} go={go} />
      ) : (
        <Overview
          orgId={orgId}
          domain={domain}
          search={{ period: search.period, filters: search.filters }}
          setSearch={(next) => go({ period: next.period, filters: next.filters?.length ? next.filters : undefined }, true)}
          onOpenLive={() => go({ view: 'live' })}
          onInstall={() => go({ view: 'install' })}
        />
      )}

      {dialog?.kind === 'new' && <FunnelDialog orgId={orgId} onSave={(input) => saveFunnel(input)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && <FunnelDialog orgId={orgId} funnel={dialog.funnel} onSave={(input) => saveFunnel(input, dialog.funnel)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Delete funnel"
          body={`Delete ${dialog.funnel.name}? Only the saved steps go; events stay.`}
          action="Delete"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await analyticsApi.deleteFunnel(orgId, dialog.funnel.id)
            if (funnel === dialog.funnel.id) go({}, true)
            // Its result is gone too: drop it rather than ask for it again.
            client.removeQueries({ queryKey: [...analyticsKeys.all, 'funnel', dialog.funnel.id] })
            void refreshFunnels()
            toast(`Deleted ${dialog.funnel.name}`)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Connect analytics / Install code

function snippet(key: string) {
  return `<script>
  window.xstate = window.xstate || function () { (xstate.q = xstate.q || []).push(arguments) }
  xstate('init', '${key}')
</script>
<script async src="${API_ORIGIN}/js/xstate.js"></script>`
}

function serverExample(domain: string) {
  return `curl ${API_ORIGIN}/v1/collect \\
  -H "Authorization: Bearer $XSTATE_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "events": [{
      "type": "track",
      "event": "Order Completed",
      "userId": "usr_123",
      "domain": "${domain}",
      "properties": { "order_id": "4661", "revenue": 96, "currency": "USD" }
    }]
  }'`
}

// The prompt behind "Copy prompt". The agent studies the codebase and writes an event dictionary first, and changes
// no code until the person has reviewed it: a good dictionary is most of the value, and it's easier to fix on paper.
function agentPrompt(key: string, domain?: string) {
  const site = domain ?? 'your-site.com'
  return `Add xstate analytics to this codebase. Work in four steps, and don't change any code until I've approved the event dictionary in step 3.

## Step 1: Study the codebase (read only)

Read through the whole codebase before writing anything. Find:
- The root layout or HTML template of every web front end (marketing site, app, docs). Note their hostnames: if the site and the app are on different subdomains (${site} and app.${site}), both get the snippet with the same key, and xstate counts each visitor once across them.
- Where people sign up, sign in and sign out, and where the server knows the signed-in user's id, email and name.
- What the product is for: the few actions that show someone got value (created their first project, invited a teammate, sent their first message...), onboarding steps, and the main features.
- Everything to do with money: checkout, the payment provider's webhooks (Stripe, Paddle, Lemon Squeezy...), plans, upgrades, downgrades, cancellations, failed payments, refunds.
- Work that finishes on the server, in background jobs or in webhooks, and clients the browser snippet can't see (mobile apps, APIs, CLIs). These events are sent from the server.

## Step 2: Write an event dictionary

Write it to docs/analytics-events.md (or wherever this repo keeps docs). Include:
- Conventions: event names in Title Case, object then past-tense verb ("Project Created", "Plan Changed"); property names in snake_case; one id on every event to group by (account, workspace or organization id) if the product has one.
- Identify: when it's called and which traits it sends (email, name, and things like plan or role).
- The events, grouped as sign-up and onboarding, activation and use, money, and churn. For each event give: its name, when exactly it fires, browser or server, the file and function where the call will go, and each property with its type and example values. Aim for 10 to 25 events that answer real questions, not one per button.
- Revenue: a numeric "revenue" (in major units, before tax, for example 12.5) and a "currency" ("USD") go on exactly one event per payment, sent from the server when the payment succeeds (for example the payment provider's "invoice paid" or "transaction completed" webhook), so renewals count and nothing is counted twice. "Checkout Started" and similar events carry no revenue.
- What you deliberately don't track, and why. Never put passwords, tokens, message or document contents, or other people's personal data in properties.
- Open questions where you weren't sure.

## Step 3: Stop for review

Show me the dictionary with a short summary, ask the open questions, and wait. Change the dictionary as I ask. Don't continue until I say it's approved.

## Step 4: Implement the approved dictionary

1. Add this snippet to the <head> of every page (each root layout or HTML template), once:

${snippet(key)}

   Page views, route changes in single-page apps, UTM tags, referrers, devices and locations are recorded automatically. Don't add code for them.

2. Where a user signs in or signs up, call:
   xstate('identify', user.id, { email: user.email, name: user.name }, userHash)
   userHash is the hex HMAC-SHA256 of String(user.id), keyed with the secret key from the XSTATE_SECRET_KEY environment variable. Compute it on the server and pass it to the page. Never send the secret key to the browser.

3. On sign-out, call xstate('reset').

4. Browser events: xstate('track', 'Event Name', { ...properties }).

5. Server events: POST ${API_ORIGIN}/v1/collect with the header "Authorization: Bearer $XSTATE_SECRET_KEY" and a body like
   { "type": "track", "event": "Order Completed", "userId": "<the same id as identify>", "domain": "${site}", "properties": { "revenue": 96, "currency": "USD" } }
   Send them without slowing the request down (in the background, after the response, or from a queue) and never let a failure break the action itself.

6. Keep the event names and their properties in one module (constants and a small typed helper for the browser and one for the server), so the names in code always match the dictionary.

7. Check it: run the app, sign up, sign in and do a few key actions, and confirm the events arrive in xstate under Analytics → Live events. List anything from the dictionary you couldn't add.

Docs: ${DOCS_URL}`
}

function Install({ orgId, status, domain, onOpenLive }: { orgId: string; status: AnalyticsStatus; domain?: string; onOpenLive: () => void }) {
  const client = useQueryClient()
  const [tab, setTab] = useState<'browser' | 'server'>('browser')
  const [sending, setSending] = useState(false)
  const [saving, setSaving] = useState(false)
  const connected = !!status.lastEventAt
  const key = status.publishableKey
  const code = tab === 'browser' ? snippet(key) : serverExample(domain ?? 'example.com')
  const copy = (text: string) => void copyText(text).then((ok) => toast(ok ? 'Copied' : "Couldn't copy"))

  const sendTest = async () => {
    if (!domain) return
    setSending(true)
    try {
      await analyticsApi.testEvent(orgId, domain)
      await client.invalidateQueries({ queryKey: analyticsKeys.all })
      toast('Test event sent')
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  const setStoreIp = async (storeIp: boolean) => {
    setSaving(true)
    try {
      await analyticsApi.updateSettings(orgId, { storeIp })
      await client.invalidateQueries({ queryKey: analyticsKeys.all })
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="s-main">
      {connected && (
        <div className="col-head drag s-head">
          <div className="grow s-head-text"><span className="crumb" aria-current="page">Install code</span></div>
        </div>
      )}
      <div className="s-scroll">
        <div className="a-install">
          {!connected && (
            <header className="a-install-head">
              <span className="a-install-icon"><Icon name="chart-line" size={18} /></span>
              <h1>Connect analytics</h1>
              <p className="muted">
                Send page, track and identify calls from your site or server. Events show up here as they arrive, and visitors show up in Users with
                where they came from, their device and their location.
              </p>
            </header>
          )}

          <div className="a-card a-agent">
            <span className="a-card-icon"><Icon name="sparkles" size={16} /></span>
            <div className="grow">
              <strong className="hi">Install with an AI agent</strong>
              <p className="muted small">Paste this prompt into Claude Code, Cursor or another coding agent. It studies your codebase, writes an event dictionary for you to review, then adds the code.</p>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => copy(agentPrompt(key, domain))}><Icon name="copy" size={13} />Copy prompt</button>
          </div>

          <div className="a-install-row">
            <strong className="hi">Or install the library yourself</strong>
            <div className="seg" role="group" aria-label="Where">
              <button type="button" aria-pressed={tab === 'browser'} onClick={() => setTab('browser')}>Browser</button>
              <button type="button" aria-pressed={tab === 'server'} onClick={() => setTab('server')}>Server</button>
            </div>
          </div>
          <div className="u-code">
            <pre className="mono">{code}</pre>
            <button className="btn btn-sm" onClick={() => copy(code)}><Icon name="copy" size={13} />Copy</button>
          </div>
          <p className="muted small">
            {tab === 'browser'
              ? 'Paste before the closing head tag on every page. Page views are recorded automatically, including route changes in single-page apps.'
              : 'Use your secret key from Settings → API keys, on your server only. Send "userId" or "email" to say who it was.'}{' '}
            <a className="link" href={DOCS_URL} target="_blank" rel="noreferrer">Read the guide</a>
          </p>

          <div className="a-card a-wait">
            {connected ? (
              <>
                <span className="a-live-dot" aria-hidden="true" />
                <div className="grow">
                  <strong className="hi">Receiving events</strong>
                  <p className="muted small">The last one arrived {ago(status.lastEventAt!)}.</p>
                </div>
                <button className="btn btn-sm" onClick={onOpenLive}>Open live events</button>
              </>
            ) : (
              <>
                <span className="a-wait-dot" aria-hidden="true" />
                <div className="grow">
                  <strong className="hi">Waiting for your first event</strong>
                  <p className="muted small">This page updates once an event comes in.</p>
                </div>
                <button className="btn btn-sm" onClick={() => void sendTest()} disabled={sending || !domain} title={domain ? `Sends a test event from ${domain}` : 'Add a domain first'}>
                  {sending && <span className="spinner" />}Send test event
                </button>
              </>
            )}
          </div>

          <div className="a-card a-privacy">
            <div className="grow">
              <strong className="hi">Keep IP addresses</strong>
              <p className="muted small">
                Keeps each visitor's IP address with their visit for 90 days. Turned off, only the country, region and city are kept, and IP
                addresses already kept are removed.
              </p>
            </div>
            <button
              className="switch"
              role="switch"
              aria-checked={status.settings.storeIp}
              aria-label="Keep IP addresses"
              disabled={!status.canManage || saving}
              title={status.canManage ? undefined : 'Only owners, admins and members who manage users can change this'}
              onClick={() => void setStoreIp(!status.settings.storeIp)}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Live events

function LiveEvents({ orgId, domain, search, go }: { orgId: string; domain?: string; search: AnalyticsSearch; go: (s: AnalyticsSearch, replace?: boolean) => void }) {
  const [events, setEvents] = useState<FeedEvent[]>([])
  const [recent, setRecent] = useState(0)
  const [nextBefore, setNextBefore] = useState<number | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [term, setTerm] = useState(search.q ?? '')
  const top = useRef(0)
  const filters = { domain, type: search.type, q: search.q }
  const filterKey = JSON.stringify(filters)

  useEffect(() => setTerm(search.q ?? ''), [search.q])
  useEffect(() => {
    const next = term.trim() || undefined
    if (next === search.q) return
    const t = setTimeout(() => go({ ...search, q: next, event: undefined }, true), 250)
    return () => clearTimeout(t)
    // Only typing should search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  // First page for these filters.
  useEffect(() => {
    let live = true
    setState('loading')
    analyticsApi
      .events(orgId, { ...filters, limit: 100 })
      .then((page) => {
        if (!live) return
        setEvents(page.events)
        setRecent(page.recent)
        setNextBefore(page.nextBefore)
        top.current = page.events[0]?.id ?? 0
        setState('ready')
      })
      .catch((err: unknown) => {
        if (!live) return
        setError(errorMessage(err))
        setState('error')
      })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, filterKey])

  // Then whatever arrives after the newest one, every few seconds while the page is on screen and not paused.
  const poll = useCallback(async () => {
    const page = await analyticsApi.events(orgId, { ...filters, after: top.current, limit: 200 })
    setRecent(page.recent)
    if (!page.events.length) return
    top.current = page.events[0]!.id
    setEvents((list) => {
      const seen = new Set(list.map((e) => e.id))
      // Rows already on screen keep the person as they were when they arrived. A visitor who has since signed in
      // (identify) is now a user with a name and email: show that on their earlier rows too.
      const people = new Map(page.events.map((e) => [e.person.id, e.person]))
      const updated = list.map((e) => {
        const person = people.get(e.person.id)
        return person && person !== e.person ? { ...e, person } : e
      })
      return [...page.events.filter((e) => !seen.has(e.id)), ...updated].slice(0, MAX_ROWS)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, filterKey])

  useEffect(() => {
    if (paused || state !== 'ready') return
    const tick = () => {
      setNow(Date.now())
      if (document.visibilityState === 'visible') void poll().catch(() => {})
    }
    const t = setInterval(tick, POLL_MS)
    return () => clearInterval(t)
  }, [paused, state, poll])

  const loadMore = async () => {
    if (nextBefore === null) return
    setLoadingMore(true)
    try {
      const page = await analyticsApi.events(orgId, { ...filters, before: nextBefore, limit: 100 })
      setEvents((list) => [...list, ...page.events])
      setNextBefore(page.nextBefore)
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const selected = search.event

  return (
    <section className="s-main a-main">
      <div className="col-head drag s-head">
        <div className="grow s-head-text">
          <span className="crumb a-crumb" aria-current="page">
            Live events
            <span className={`a-badge${paused ? ' is-paused' : ''}`}><span className="a-badge-dot" />{paused ? 'Paused' : 'Live'}</span>
          </span>
          <span className="sub">{recent.toLocaleString()} {recent === 1 ? 'event' : 'events'} in the last 5 min</span>
        </div>
        <span className="spacer-grow" />
        <button className="btn btn-sm" onClick={() => setPaused((p) => !p)}>
          <Icon name={paused ? 'play' : 'pause'} size={13} />{paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      <div className="a-toolbar">
        <label className="s-search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Event or user" aria-label="Search events" value={term} onChange={(e) => setTerm(e.target.value)} />
        </label>
        <div className="seg" role="group" aria-label="Event type">
          {TYPES.map((t) => (
            <button key={t ?? 'all'} type="button" aria-pressed={search.type === t} onClick={() => go({ ...search, type: t, event: undefined })}>
              {t ? TYPE_LABEL[t] : 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className="s-scroll">
        {state === 'loading' ? (
          <div className="loading"><span className="spinner" /></div>
        ) : state === 'error' ? (
          <div className="empty">
            <Icon name="circle-alert" size={24} />
            <strong>Couldn't load events</strong>
            <span>{error}</span>
          </div>
        ) : (
          <div className="s-table a-table" role="table" aria-label="Live events">
            <div className="s-row a-row s-row-head" role="row">
              <span role="columnheader">Type</span>
              <span role="columnheader">Event</span>
              <span role="columnheader">User</span>
              <span role="columnheader">Properties</span>
              <span role="columnheader" className="num">Time</span>
            </div>
            {events.length === 0 ? (
              <div className="s-empty">{search.q || search.type ? 'No events match.' : 'No events yet.'}</div>
            ) : (
              events.map((e) => <EventRow key={e.id} event={e} now={now} selected={selected === e.id} onOpen={() => go({ ...search, event: e.id })} />)
            )}
          </div>
        )}
        {state === 'ready' && nextBefore !== null && events.length < MAX_ROWS && (
          <div className="more-row">
            <button className="btn" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore && <span className="spinner" />}Load more
            </button>
          </div>
        )}
      </div>

      {selected !== undefined && <EventPanel key={selected} orgId={orgId} eventId={selected} onClose={() => go({ ...search, event: undefined })} />}
    </section>
  )
}

function EventRow({ event: e, now, selected, onOpen }: { event: FeedEvent; now: number; selected: boolean; onOpen: () => void }) {
  const who = whoLabel(e.person)
  return (
    <div
      role="row"
      tabIndex={0}
      className={`s-row a-row${selected ? ' is-selected' : ''}`}
      onClick={onOpen}
      onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onOpen())}
    >
      <span role="cell"><span className={`a-type a-type-${e.type}`}>{TYPE_LABEL[e.type]}</span></span>
      <span role="cell" className="hi ellipsis" title={e.url ?? e.name}>{eventLabel(e)}</span>
      <span role="cell" className={`ellipsis ${who.anonymous ? 'mono dim small' : 'muted'}`}>{who.text}</span>
      <span role="cell" className="ellipsis muted small mono">{propertiesLine(e)}</span>
      <span role="cell" className="num muted small" title={new Date(e.occurredAt).toLocaleString()}>{ago(e.occurredAt, now)}</span>
    </div>
  )
}

function EventPanel({ orgId, eventId, onClose }: { orgId: string; eventId: number; onClose: () => void }) {
  const navigate = useNavigate()
  const detail = useQuery({ queryKey: [...analyticsKeys.all, 'event', eventId], queryFn: () => analyticsApi.event(orgId, eventId) })
  const e = detail.data?.event
  const json = e ? JSON.stringify(eventJson(e, detail.data!.visit), null, 2) : ''

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <aside className="u-panel a-panel" aria-label="Event">
      <div className="u-panel-head">
        <div className="u-panel-title">
          {e ? (
            <>
              <span className="row-gap">
                <span className={`a-type a-type-${e.type}`}>{TYPE_LABEL[e.type]}</span>
                <strong className="hi ellipsis">{eventLabel(e)}</strong>
              </span>
              <span className="muted small">
                {new Date(e.occurredAt).toLocaleTimeString()} · {detail.data?.visit?.library ? 'Browser' : 'Server'}
              </span>
            </>
          ) : (
            <strong className="hi">Event</strong>
          )}
        </div>
        <button className="ghost" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      <div className="u-panel-scroll">
        {detail.isPending ? (
          <div className="loading"><span className="spinner" /></div>
        ) : detail.isError ? (
          <div className="empty small"><span>{errorMessage(detail.error)}</span></div>
        ) : (
          <pre className="mono a-json">{json}</pre>
        )}
      </div>
      {e && (
        <div className="u-panel-foot a-panel-foot">
          <button className="btn btn-sm" onClick={() => void navigate({ to: '/users', search: { person: e.person.id } })}>
            <Icon name="user" size={13} />Open person
          </button>
          <button className="btn btn-sm" onClick={() => void copyText(json).then((ok) => toast(ok ? 'Copied' : "Couldn't copy"))}>
            <Icon name="copy" size={13} />Copy JSON
          </button>
        </div>
      )}
    </aside>
  )
}
