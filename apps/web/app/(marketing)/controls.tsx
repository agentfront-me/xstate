'use client'

// The two interactive bits of the marketing page; everything else is server-rendered.

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { SIGNUP_URL } from '@/lib/urls'

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

const plans = [
  { name: 'Pro', monthly: 8, plan: 'pro' },
  { name: 'Team', monthly: 24, plan: 'team' },
]

const rows: [string, string, string, string][] = [
  ['Domains', '1 (subdomain)', '3', 'unlimited'],
  ['Addresses', '2', '25', 'unlimited'],
  ['Storage', '2 GB', '50 GB', '1 TB pooled'],
  ['Outbound mail / day', '100', '5,000', '50,000'],
  ['Agents', '1', '4', 'unlimited'],
  ['Data API requests / month', '10k', '1M', '20M'],
  ['Sites', '1', '5', 'unlimited'],
  ['Audit log retention', '7 days', '90 days', '2 years'],
  ['Support', 'community', 'email, 1 day', 'email, 4 hours'],
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
                  <span className="muted">forever</span>
                  <a href={SIGNUP_URL}>Start free</a>
                </div>
              </th>
              {plans.map((p) => (
                <th scope="col" key={p.plan}>
                  <div className="plan">
                    <span className="plan-name">{p.name}</span>
                    {/* Annual: ten months' price spread over twelve. */}
                    <span className="plan-price">${annual ? Math.round((p.monthly * 10) / 12) : p.monthly}</span>
                    <span className="muted">{annual ? 'per user / month, billed yearly' : 'per user / month'}</span>
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
      <p className="small faint">Prices in USD. Domains billed at registry cost, no markup. Tax added where required.</p>
    </section>
  )
}
