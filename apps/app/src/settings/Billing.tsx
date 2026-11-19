// Settings → Billing: the organization's plan, buying Growth on the payment provider's hosted checkout page, changing
// Growth's size, and the provider's customer portal for invoices, the card and cancelling. The API (billing/ in
// apps/api) is the source of truth and knows which provider is used; this page never does. Checkout returns here with
// ?checkout_session=… and the page asks the API to apply the new subscription (the provider's webhook does too).

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from '../components/Toast'
import { type Account } from '../lib/account'
import { api, errorMessage } from '../lib/core'
import { ConfirmDialog } from '../storage/dialogs'
import { track } from '../lib/analytics'

type Plan = 'free' | 'growth' | 'custom'

type Billing = {
  plan: Plan
  status: string | null
  size: number | null
  extraHundreds: number | null
  priceCents: number | null
  periodEnd: string | null
  cancelAt: string | null
  prices: { growthBase: number; extraHundred: number; included: number; max: number }
  canManage: boolean
  available: boolean
  hasPortal: boolean
}

const NAMES: Record<Plan, string> = { free: 'Free', growth: 'Growth', custom: 'Custom' }

type Usage = {
  month: string
  limits: { audience: number | null; storageBytes: number | null; mailboxes: number | null; domains: number | null; agents: number | null; emailsPerMonth: number | null }
  audience: { total: number; mail: number; web: number }
  websiteEvents: number
  storage: { bytes: number; mailBytes: number; fileBytes: number }
  emails: number
  mailboxes: number
  domains: number
  agents: number
}

const gb = (bytes: number) => {
  if (bytes < 1e9) return `${fmt(Math.round(bytes / 1e6))} MB`
  const v = bytes / 1e9
  return `${v >= 10 ? fmt(Math.round(v)) : v.toFixed(1)} GB`
}

/** One usage line: what's used against the plan's limit (none: unlimited), with a bar when there is a limit. */
function Meter({ label, used, limit, show = fmt, sub }: { label: string; used: number; limit: number | null; show?: (n: number) => string; sub?: string }) {
  const share = limit ? Math.min(used / limit, 1.1) : 0
  const level = !limit ? '' : used > limit * 1.1 ? ' over' : used >= limit ? ' full' : used >= limit * 0.8 ? ' near' : ''
  return (
    <div className="card-row usage-row">
      <div className="text">
        <span className="name">{label}</span>
        {sub && <span className="sub">{sub}</span>}
      </div>
      <div className="usage-value">
        <span className="small">
          {show(used)}
          <span className="muted"> {limit === null ? '· unlimited' : `of ${show(limit)}`}</span>
        </span>
        {limit !== null && (
          <span className={`usage-bar${level}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used}>
            <span style={{ width: `${Math.min(share, 1) * 100}%` }} />
          </span>
        )}
      </div>
    </div>
  )
}

function UsageSection({ orgId }: { orgId: string }) {
  const query = useQuery({ queryKey: ['billing-usage', orgId], queryFn: () => api<{ usage: Usage }>('GET', `/orgs/${orgId}/billing/usage`) })
  const u = query.data?.usage
  if (!u) return query.isError ? <p className="muted small">{errorMessage(query.error)}</p> : null
  const monthName = new Date(`${u.month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' })
  return (
    <div className="group">
      <div className="group-head">
        <div className="text">
          <h2>Usage in {monthName}</h2>
          <p>People count once a month: everyone you email or who emails you, plus known website visitors.</p>
        </div>
      </div>
      <div className="card">
        <Meter
          label="People reached"
          used={u.audience.total}
          limit={u.limits.audience}
          sub={`${fmt(u.audience.mail)} by email, ${fmt(u.audience.web)} from your website`}
        />
        <Meter label="Storage" used={u.storage.bytes} limit={u.limits.storageBytes} show={gb} sub={`${gb(u.storage.mailBytes)} of mail, ${gb(u.storage.fileBytes)} of files`} />
        <Meter label="Emails sent" used={u.emails} limit={u.limits.emailsPerMonth} sub="Every recipient counts" />
        <Meter label="Mailboxes" used={u.mailboxes} limit={u.limits.mailboxes} sub="Personal and shared" />
        <Meter label="Domains" used={u.domains} limit={u.limits.domains} />
        <Meter label="Agents" used={u.agents} limit={u.limits.agents} />
        <Meter label="Website events" used={u.websiteEvents} limit={null} sub="Page views and events from your website" />
      </div>
    </div>
  )
}

/** Growth sizes offered on the slider, in extra hundreds above the included 5,000 (xstate.com uses the same steps). */
const STEPS = [0, 25, 50, 200, 450, 950, 2450, 4950, 9950]

const keys = { billing: (orgId: string) => ['billing', orgId] as const }
const fmt = (n: number) => n.toLocaleString('en-US')
const dollars = (cents: number) => `$${fmt(Math.round(cents / 100))}`
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })
const sizeOf = (b: Billing, extra: number) => b.prices.included + extra * 100
const priceOf = (b: Billing, extra: number) => b.prices.growthBase + extra * b.prices.extraHundred
const stepAt = (i: number) => STEPS[Math.min(Math.max(i, 0), STEPS.length - 1)] ?? 0
const nearestStep = (extra: number) => STEPS.reduce((best, s, i) => (Math.abs(s - extra) < Math.abs(stepAt(best) - extra) ? i : best), 0)

export function BillingSection({ account }: { account: Account }) {
  if (account.mode !== 'live') return <p className="muted">Sign in to see your organization’s plan.</p>
  return <LiveBilling orgId={account.org.id} />
}

function LiveBilling({ orgId }: { orgId: string }) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: keys.billing(orgId), queryFn: () => api<{ billing: Billing }>('GET', `/orgs/${orgId}/billing`) })
  const b = query.data?.billing
  const [step, setStep] = useState<number | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmSize, setConfirmSize] = useState<number | null>(null)

  // The account carries the plan name shown in the sidebar.
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: keys.billing(orgId) }),
      client.invalidateQueries({ queryKey: ['billing-usage', orgId] }),
      client.invalidateQueries({ queryKey: ['account'] }),
    ])

  // Back from checkout: the provider adds ?checkout_session=… to the return link. Apply the subscription it made
  // right away (the webhook would within seconds anyway), asking again while the provider is still creating it.
  useEffect(() => {
    const session = new URLSearchParams(window.location.search).get('checkout_session')
    if (!session && !window.location.hash.includes('checkout=done')) return
    window.history.replaceState(null, '', window.location.pathname + '#/settings/billing')
    if (!session) return void refresh()
    let cancelled = false
    void (async () => {
      setBusy('confirming')
      try {
        for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
          const r = await api<{ pending: boolean }>('POST', `/orgs/${orgId}/billing/checkout/confirm`, { session })
          if (!r.pending) {
            toast('Growth is active. Thank you!')
            return
          }
          await new Promise((res) => setTimeout(res, 2000))
        }
        toast('Payment received. Your plan will show here within a minute.')
      } catch (err) {
        toast(errorMessage(err))
      } finally {
        setBusy(null)
        void refresh()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (query.isLoading) return <p className="muted">Loading…</p>
  if (query.isError || !b) return <p className="muted">{errorMessage(query.error)}</p>

  const current = b.extraHundreds ?? 0
  const chosen = stepAt(step ?? nearestStep(current))
  const onGrowth = b.plan === 'growth'

  async function upgrade() {
    setBusy('checkout')
    try {
      track('Checkout Started', { plan: 'growth', size: sizeOf(b!, chosen) })
      const { url } = await api<{ url: string }>('POST', `/orgs/${orgId}/billing/checkout`, { extraHundreds: chosen })
      window.location.href = url
    } catch (err) {
      toast(errorMessage(err))
      setBusy(null)
    }
  }

  async function resize(extra: number) {
    try {
      await api('PUT', `/orgs/${orgId}/billing/size`, { extraHundreds: extra })
      toast(`Growth is now ${fmt(sizeOf(b!, extra))} people, ${dollars(priceOf(b!, extra))} a month.`)
      void refresh()
    } catch (err) {
      toast(errorMessage(err))
    }
  }

  async function portal() {
    setBusy('portal')
    // Opened before the request so the browser doesn't block it as a pop-up.
    const tab = window.open('', '_blank')
    try {
      const { url } = await api<{ url: string }>('POST', `/orgs/${orgId}/billing/portal`)
      if (tab) tab.location.href = url
      else window.location.href = url
    } catch (err) {
      tab?.close()
      toast(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="card solo">
        <div className="card-row">
          <div className="text">
            <span className="name">
              {NAMES[b.plan]}
              {onGrowth && b.priceCents !== null ? ` · ${dollars(b.priceCents)} a month` : b.plan === 'free' ? ' · $0' : ''}
            </span>
            <span className="sub">
              {onGrowth && b.size !== null
                ? `Up to ${fmt(b.size)} people a month. ` + (b.cancelAt ? `Cancelled: back to Free on ${day(b.cancelAt)}.` : b.periodEnd ? `Renews ${day(b.periodEnd)}.` : '')
                : b.plan === 'custom'
                  ? 'Your plan was set up with us. Contact us to change it.'
                  : 'Up to 1,000 people a month, 5 mailboxes and 5 GB.'}
            </span>
          </div>
          {busy === 'confirming' && <span className="muted small">Activating…</span>}
        </div>
        {b.status === 'past_due' && (
          <div className="card-row">
            <div className="text">
              <span className="name">Your last payment didn’t go through</span>
              <span className="sub">We’ll try again. Update your card to keep Growth.</span>
            </div>
            {b.hasPortal && (
              <button className="btn btn-primary" disabled={!!busy} onClick={() => void portal()}>
                Update card
              </button>
            )}
          </div>
        )}
      </div>

      <UsageSection orgId={orgId} />

      {!b.canManage && <p className="muted small">Only owners and admins can change the plan.</p>}
      {b.canManage && !b.available && b.plan !== 'custom' && <p className="muted small">Paid plans aren’t available on this server yet.</p>}

      {b.canManage && b.available && b.plan !== 'custom' && (
        <div className="group">
          <div className="group-head">
            <div className="text">
              <h2>{onGrowth ? 'Change size' : 'Upgrade to Growth'}</h2>
              <p>Growth is $49 a month for 5,000 people, then $1 for every 100 more. Billed monthly, no charge per seat.</p>
            </div>
          </div>
          <div className="card">
            <div className="card-row">
              <div className="text">
                <label className="name" htmlFor="billing-size">
                  {fmt(sizeOf(b, chosen))} people a month
                </label>
                <span className="sub">{dollars(priceOf(b, chosen))} a month</span>
              </div>
              {onGrowth ? (
                <button className="btn btn-primary" disabled={!!busy || chosen === current} onClick={() => setConfirmSize(chosen)}>
                  {chosen === current ? 'Current size' : 'Change size'}
                </button>
              ) : (
                <button className="btn btn-primary" disabled={!!busy} onClick={() => void upgrade()}>
                  {busy === 'checkout' ? 'Opening checkout…' : 'Upgrade'}
                </button>
              )}
            </div>
            <div className="card-row">
              <input
                id="billing-size"
                type="range"
                className="grow"
                min={0}
                max={STEPS.length - 1}
                step={1}
                value={step ?? nearestStep(current)}
                aria-valuetext={`${fmt(sizeOf(b, chosen))} people, ${dollars(priceOf(b, chosen))} a month`}
                onChange={(e) => setStep(Number(e.target.value))}
              />
            </div>
          </div>
        </div>
      )}

      {b.hasPortal && (
        <div className="group">
          <div className="group-head">
            <div className="text">
              <h2>Payment and invoices</h2>
              <p>Invoices, the card on file and cancelling. It opens in a new tab.</p>
            </div>
          </div>
          <div className="card">
            <div className="card-row">
              <div className="text">
                <span className="name">Manage billing</span>
              </div>
              <button className="btn" disabled={!!busy} onClick={() => void portal()}>
                Open
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmSize !== null && (
        <ConfirmDialog
          title={`Change Growth to ${fmt(sizeOf(b, confirmSize))} people?`}
          body={`${dollars(priceOf(b, confirmSize))} a month. The difference for the rest of this billing period is charged or credited now.`}
          action="Change size"
          onConfirm={() => resize(confirmSize)}
          onClose={() => setConfirmSize(null)}
        />
      )}
    </>
  )
}
