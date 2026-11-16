// Settings → Billing: the organization's plan, buying Pro or Team through Paddle's checkout (an overlay from
// Paddle.js), switching plan or interval, and Paddle's customer portal for invoices, the card and cancelling.
// The API (billing/ in apps/api) is the source of truth; checkout only starts the purchase, and the plan changes
// once the API has seen the subscription (confirmed right after checkout, and by Paddle's webhook).
//
// Paddle's emails and portal send people to /app/?_ptxn=<transaction> (app/main.tsx moves them here) to pay an open invoice: the page
// then opens checkout for that transaction (it's the "default payment link" in Paddle's checkout settings).

import { initializePaddle, type Paddle, type PaddleEventData } from '@paddle/paddle-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from '../components/Toast'
import { type Account } from '../lib/account'
import { api, errorMessage } from '../lib/core'
import { ConfirmDialog } from '../storage/dialogs'

type Plan = 'free' | 'pro' | 'team'
type PaidPlan = Exclude<Plan, 'free'>
type Interval = 'month' | 'year'
type PaddleEnvironment = 'production' | 'sandbox'

type Billing = {
  plan: Plan
  interval: Interval | null
  status: string | null
  seats: number | null
  people: number
  periodEnd: string | null
  scheduledChange: { action: string; effectiveAt: string } | null
  prices: Record<PaidPlan, Record<Interval, number>>
  canManage: boolean
  checkout: {
    environment: PaddleEnvironment
    clientToken: string
    priceIds: Record<PaidPlan, Record<Interval, string>>
    customerId: string | null
    organizationId: string
  } | null
  paddle: { environment: PaddleEnvironment; clientToken: string } | null
}

const NAMES: Record<Plan, string> = { free: 'Free', pro: 'Pro', team: 'Team' }

/** What each plan gives, in docs/pricing-plan.md's words. */
const FEATURES: Record<Plan, string[]> = {
  free: ['Up to 5 people on 1 domain', '5 GB per person', 'AI search of the last 90 days', 'Connected AI apps', 'No agents'],
  pro: ['10 domains', '30 GB per person, pooled', 'AI search of all your mail', 'Agents on your own AI key', 'Shared mailboxes free'],
  team: ['Unlimited domains', '200 GB per person, pooled', 'Longer search history', 'More agent runs and app calls', 'Support within 4 hours'],
}

const keys = { billing: (orgId: string) => ['billing', orgId] as const }

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })

/** One Paddle.js per page; it refuses a second initialization. */
let paddlePromise: Promise<Paddle | undefined> | null = null
let onPaddleEvent: ((e: PaddleEventData) => void) | null = null
function loadPaddle(environment: PaddleEnvironment, token: string): Promise<Paddle | undefined> {
  paddlePromise ??= initializePaddle({ environment, token, eventCallback: (e) => onPaddleEvent?.(e) })
  return paddlePromise
}

export function BillingSection({ account }: { account: Account }) {
  if (account.mode !== 'live') return <p className="muted">Sign in to see your organization’s plan.</p>
  return <LiveBilling orgId={account.org.id} email={account.user.email} />
}

function LiveBilling({ orgId, email }: { orgId: string; email: string }) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: keys.billing(orgId), queryFn: () => api<{ billing: Billing }>('GET', `/orgs/${orgId}/billing`) })
  const [interval, setPeriod] = useState<Interval>('month')
  const [busy, setBusy] = useState<string | null>(null)
  const [changing, setChanging] = useState<{ plan: PaidPlan; interval: Interval } | null>(null)
  const paidLink = useRef(false)
  const b = query.data?.billing

  // The account carries the plan name shown in the sidebar.
  const refresh = () =>
    Promise.all([client.invalidateQueries({ queryKey: keys.billing(orgId) }), client.invalidateQueries({ queryKey: ['account'] })])

  // The plan changes once the API has the subscription; Paddle creates it a moment after the payment.
  async function confirm(transactionId: string) {
    setBusy('confirming')
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        const r = await api<{ pending: boolean }>('POST', `/orgs/${orgId}/billing/checkouts/${transactionId}/confirm`)
        if (!r.pending) {
          toast('Your plan is active. Thank you!')
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
  }

  onPaddleEvent = (e) => {
    if (e.name === 'checkout.completed' && e.data?.transaction_id) void confirm(e.data.transaction_id)
    else if (e.name === 'checkout.error') toast('Checkout couldn’t open. Try again, or contact support if it keeps happening.')
  }

  // A link from Paddle to pay an open transaction (failed renewal, invoice): open checkout for it.
  useEffect(() => {
    const txn = new URLSearchParams(window.location.search).get('_ptxn')
    if (!txn || !b?.paddle || paidLink.current) return
    paidLink.current = true
    void loadPaddle(b.paddle.environment, b.paddle.clientToken).then((p) => p?.Checkout.open({ transactionId: txn }))
  }, [b?.paddle])

  if (query.isLoading) return <p className="muted">Loading…</p>
  if (query.isError || !b) return <p className="muted">{errorMessage(query.error)}</p>

  async function buy(plan: PaidPlan) {
    const c = b!.checkout
    if (!c) return
    setBusy(plan)
    try {
      const paddle = await loadPaddle(c.environment, c.clientToken)
      if (!paddle) throw new Error('Paddle checkout didn’t load. Check your connection and try again.')
      paddle.Checkout.open({
        items: [{ priceId: c.priceIds[plan][interval], quantity: Math.max(1, b!.people) }],
        customer: c.customerId ? { id: c.customerId } : { email },
        customData: { organizationId: c.organizationId },
        settings: { displayMode: 'overlay', variant: 'one-page', allowLogout: false },
      })
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function portal(which: 'overview' | 'cancel' | 'updatePaymentMethod') {
    setBusy(which)
    // Opened before the request so the browser doesn't block it as a pop-up.
    const tab = window.open('', '_blank')
    try {
      const links = await api<Record<typeof which, string | null>>('POST', `/orgs/${orgId}/billing/portal`)
      const url = links[which] ?? links.overview
      if (tab && url) tab.location.href = url
      else if (url) window.location.href = url
    } catch (err) {
      tab?.close()
      toast(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  async function change(plan: PaidPlan, to: Interval) {
    try {
      await api('PUT', `/orgs/${orgId}/billing/plan`, { plan, interval: to })
      toast(`You’re now on ${NAMES[plan]}, billed ${to === 'month' ? 'monthly' : 'yearly'}.`)
      void refresh()
    } catch (err) {
      toast(errorMessage(err))
    }
  }

  const paid = b.plan !== 'free' && b.interval
  const perPerson = paid ? b.prices[b.plan as PaidPlan][b.interval!] : 0
  const cancelling = b.scheduledChange?.action === 'cancel'

  return (
    <>
      <div className="card solo">
        <div className="card-row">
          <div className="text">
            <span className="name">
              {NAMES[b.plan]}
              {paid ? ` · ${dollars(perPerson)} per person a ${b.interval === 'month' ? 'month' : 'year'}` : ' · $0'}
            </span>
            <span className="sub">
              {paid
                ? `${b.seats ?? b.people} ${(b.seats ?? b.people) === 1 ? 'person' : 'people'} billed. ` +
                  (cancelling
                    ? `Cancelled: back to Free on ${day(b.scheduledChange!.effectiveAt)}.`
                    : b.periodEnd
                      ? `Renews ${day(b.periodEnd)}.`
                      : '')
                : `${b.people} ${b.people === 1 ? 'person' : 'people'}. Shared mailboxes never count.`}
            </span>
          </div>
          {busy === 'confirming' && <span className="muted small">Activating…</span>}
        </div>
        {b.status === 'past_due' && (
          <div className="card-row">
            <div className="text">
              <span className="name">Your last payment didn’t go through</span>
              <span className="sub">Paddle will try again. Update your card to keep your plan.</span>
            </div>
            {b.canManage && (
              <button className="btn btn-primary" disabled={!!busy} onClick={() => void portal('updatePaymentMethod')}>
                Update card
              </button>
            )}
          </div>
        )}
      </div>

      {!b.canManage && <p className="muted small">Only owners and admins can change the plan.</p>}
      {b.canManage && !b.paddle && <p className="muted small">Paid plans aren’t available on this server yet.</p>}

      {b.canManage && b.paddle && (
        <div className="group">
          <div className="group-head">
            <div className="text">
              <h2>{paid ? 'Change plan' : 'Upgrade'}</h2>
              <p>Prices are per person. Tax is added at checkout where it applies.</p>
            </div>
            <span className="billing-toggle" role="group" aria-label="Billing interval">
              <button type="button" aria-pressed={interval === 'month'} onClick={() => setPeriod('month')}>
                Monthly
              </button>
              <button type="button" aria-pressed={interval === 'year'} onClick={() => setPeriod('year')}>
                Yearly, 2 months free
              </button>
            </span>
          </div>
          <div className="plan-grid">
            {(['free', 'pro', 'team'] as const).map((plan) => {
              const current = plan === b.plan && (plan === 'free' || b.interval === interval)
              const price = plan === 'free' ? 0 : b.prices[plan][interval]
              return (
                <div className={`card plan-card${plan === b.plan ? ' current' : ''}`} key={plan}>
                  <div className="plan-top">
                    <span className="name">{NAMES[plan]}</span>
                    <span className="plan-price">
                      {dollars(price)}
                      <span className="muted small">{plan === 'free' ? ' forever' : interval === 'month' ? ' / person / month' : ' / person / year'}</span>
                    </span>
                  </div>
                  <ul className="plan-features">
                    {FEATURES[plan].map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                  {plan === 'free' ? (
                    paid ? (
                      <button className="btn" disabled={!!busy || cancelling} onClick={() => void portal('cancel')}>
                        {cancelling ? 'Cancellation scheduled' : 'Cancel paid plan'}
                      </button>
                    ) : (
                      <button className="btn" disabled>
                        Current plan
                      </button>
                    )
                  ) : current ? (
                    <button className="btn" disabled>
                      Current plan
                    </button>
                  ) : paid ? (
                    <button className="btn btn-primary" disabled={!!busy} onClick={() => setChanging({ plan, interval })}>
                      Switch to {NAMES[plan]}
                      {plan === b.plan ? (interval === 'year' ? ' yearly' : ' monthly') : ''}
                    </button>
                  ) : (
                    <button className="btn btn-primary" disabled={!!busy || !b.checkout} onClick={() => void buy(plan)}>
                      Choose {NAMES[plan]}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {b.canManage && paid && (
        <div className="group">
          <div className="group-head">
            <div className="text">
              <h2>Payment and invoices</h2>
              <p>Handled by Paddle, our reseller and merchant of record. It opens in a new tab.</p>
            </div>
          </div>
          <div className="card">
            <div className="card-row">
              <div className="text">
                <span className="name">Invoices and receipts</span>
              </div>
              <button className="btn" disabled={!!busy} onClick={() => void portal('overview')}>
                Open
              </button>
            </div>
            <div className="card-row">
              <div className="text">
                <span className="name">Payment method</span>
              </div>
              <button className="btn" disabled={!!busy} onClick={() => void portal('updatePaymentMethod')}>
                Update
              </button>
            </div>
          </div>
        </div>
      )}

      {changing && (
        <ConfirmDialog
          title={`Switch to ${NAMES[changing.plan]} ${changing.interval === 'month' ? 'monthly' : 'yearly'}?`}
          body={`${dollars(b.prices[changing.plan][changing.interval])} per person a ${changing.interval}, for ${Math.max(1, b.people)} ${
            Math.max(1, b.people) === 1 ? 'person' : 'people'
          }. The difference for the rest of this billing period is charged or credited now.`}
          action="Switch plan"
          onConfirm={() => change(changing.plan, changing.interval)}
          onClose={() => setChanging(null)}
        />
      )}
    </>
  )
}
