'use client'

// The two interactive bits of the marketing page; everything else is server-rendered.

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { APP_HOME_URL, LOGIN_URL, SIGNUP_URL } from '@/lib/urls'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  // The theme is only known in the browser; show the light-mode label until then so the HTML matches.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const dark = mounted && resolvedTheme === 'dark'
  return (
    <button type="button" className="theme-toggle" aria-label="Toggle theme" onClick={() => setTheme(dark ? 'light' : 'dark')}>
      {dark ? 'Light' : 'Dark'}
    </button>
  )
}

/**
 * Header links. The app sets a `signed_in=1` cookie on .xstate.com while someone is signed in (a hint only: no
 * token, see apps/app/src/lib/core.ts). The cookie is only readable in the browser, so the server renders the
 * signed-out links and they swap after load.
 */
export function HeaderActions() {
  const [signedIn, setSignedIn] = useState(false)
  useEffect(() => setSignedIn(/(?:^|; )signed_in=1(?:;|$)/.test(document.cookie)), [])
  if (signedIn) {
    return (
      <a href={APP_HOME_URL} className="btn btn-solid">
        Open app
      </a>
    )
  }
  return (
    <>
      <a href={LOGIN_URL} className="quiet">
        Log in
      </a>
      <a href={SIGNUP_URL} className="btn btn-solid">
        Start free
      </a>
    </>
  )
}

// docs/pricing-plan.md. Prices per person; yearly is ten months' price.
const plans = [
  { name: 'Pro', monthly: 6, plan: 'pro' },
  { name: 'Team', monthly: 12, plan: 'team' },
]

const rows: [string, string, string, string][] = [
  ['People (mailboxes)', 'up to 5', 'unlimited', 'unlimited'],
  ['Domains', '1', '10', 'unlimited'],
  ['Shared addresses and aliases', '5', 'unlimited, no seat charge', 'unlimited, no seat charge'],
  ['Storage', '5 GB per person', '30 GB per person, pooled', '200 GB per person, pooled'],
  ['Mail covered by AI search', 'last 90 days', '50,000 emails per person', '200,000 emails per person'],
  ['AI app actions a day', '200 per person', '2,000 per person', '10,000 per person'],
  ['Agents (bring your own Anthropic or OpenAI key)', '—', '10 agents, 500 runs per person a month', 'unlimited, 2,000 runs per person a month'],
  ['Outside recipients a day', '100 per mailbox', '500 per mailbox', '1,000 per mailbox'],
  ['File version history', '5 versions, 30 days', '5 versions, 30 days', '100 versions, 1 year'],
  ['Support', 'docs', 'email, 1 business day', 'email, 4 hours'],
]

export function Pricing() {
  const [annual, setAnnual] = useState(false)
  return (
    <section id="pricing" className="section" aria-labelledby="price-h">
      <div className="section-head" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 id="price-h">Pricing</h2>
        <div className="billing small muted">
          <button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>
            Monthly
          </button>
          <span className="faint">/</span>
          <button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>
            Annual, 2 months free
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="pricing">
          <thead>
            <tr>
              <th scope="col">Plan</th>
              <th scope="col">
                <div className="plan">
                  <span className="plan-name">Free</span>
                  <span className="plan-price">$0</span>
                  <span className="muted">no card needed</span>
                  <a href={SIGNUP_URL}>Start free</a>
                </div>
              </th>
              {plans.map((p) => (
                <th scope="col" key={p.plan}>
                  <div className="plan">
                    <span className="plan-name">{p.name}</span>
                    {/* Annual: ten months' price spread over twelve. */}
                    <span className="plan-price">${annual ? Math.round((p.monthly * 10) / 12) : p.monthly}</span>
                    <span className="muted">{annual ? 'per person / month, billed yearly' : 'per person / month'}</span>
                    <a href={`${SIGNUP_URL}?plan=${p.plan}`}>Start {p.name}</a>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, ...values]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {values.map((v, i) => (
                  <td key={i}>{v}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small faint">Prices in USD per person. Shared mailboxes are free. Tax added at checkout where required. Payments are handled by Paddle, our reseller.</p>
    </section>
  )
}
