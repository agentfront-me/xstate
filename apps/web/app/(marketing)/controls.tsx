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

// docs/pricing-plan.md §8a: priced by monthly active audience (people emailed or emailing in, plus known website
// visitors). Growth is $49 for 5,000 with 50 GB, then $1 and 1 GB for every 100 more, up to 1,000,000; Custom above.
// The track is split in thirds: Free, then Growth, then Custom at the far end.
type Stop = { n: number; pos: number }
const FREE_STOPS = [250, 500, 750, 1000]
const GROWTH_STOPS = [2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000]
const STOPS: Stop[] = [
  ...FREE_STOPS.map((n, i) => ({ n, pos: (i / (FREE_STOPS.length - 1)) * (100 / 3) })),
  ...GROWTH_STOPS.map((n, i) => ({ n, pos: 100 / 3 + ((i + 1) / GROWTH_STOPS.length) * (100 / 3) })),
  { n: 1_000_001, pos: 100 },
]
const LABELS: [string, number][] = [['1k', 3], ['5k', 5], ['50k', 8], ['1M', 12], ['1M+', 13]]
const fmt = (n: number) => n.toLocaleString('en-US')
const nearest = (pos: number) => STOPS.reduce((best, s, i) => (Math.abs(s.pos - pos) < Math.abs(STOPS[best].pos - pos) ? i : best), 0)
// Keeps the 26px handle inside the track at both ends.
const along = (pos: number) => `calc(${pos}% + ${13 - pos * 0.26}px)`

export function Pricing() {
  const [idx, setIdx] = useState(FREE_STOPS.length + 1)
  const stop = STOPS[idx]
  const plan = stop.n <= 1000 ? 'free' : stop.n > 1_000_000 ? 'custom' : 'growth'
  const growth = Math.min(Math.max(stop.n, 5000), 1_000_000)
  const extra = Math.ceil((growth - 5000) / 100)
  const rows: [string, string, string][] = [
    ['5 GB storage for mail and files', `${fmt(50 + extra)} GB storage for mail and files`, 'Custom storage'],
    ['5 mailboxes, personal and shared', 'Unlimited mailboxes', 'Unlimited mailboxes'],
    ['3 domains', 'Unlimited domains', 'Unlimited domains'],
    ['4,000 emails a month', 'Unlimited emails', 'Custom sending volume'],
    ['1 agent on your own AI key', 'Unlimited agents on your own AI key', 'Unlimited agents on your own AI key'],
    ['Contacts, analytics and AI search', 'Contacts, analytics and AI search', 'Contacts, analytics and AI search'],
    ['Help from our docs', 'More storage at $5 per 100 GB', 'Yearly invoice billing'],
  ]
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const next = { ArrowRight: idx + 1, ArrowUp: idx + 1, ArrowLeft: idx - 1, ArrowDown: idx - 1, Home: 0, End: STOPS.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    setIdx(Math.min(Math.max(next, 0), STOPS.length - 1))
  }
  const valueText = plan === 'custom' ? 'More than 1,000,000 people, Custom plan' : `${fmt(stop.n)} people, ${plan === 'free' ? 'Free' : `Growth at $${fmt(49 + extra)} a month`}`
  return (
    <section id="pricing" className="section" aria-labelledby="price-h">
      <div className="section-head">
        <h2 id="price-h">Pricing</h2>
        <span className="small muted">Pay for the people you reach, not the seats you add</span>
      </div>
      <div className="price-box">
        <div className="price-inner">
          <div className="price-cols">
            <div className="price-head">
              <h3>Free</h3>
              <p className="plan-price">$0</p>
              <p className="muted">For small teams moving their email to xstate.</p>
            </div>
            <div className="price-head">
              <h3>Growth</h3>
              <p className="plan-price">
                ${fmt(49 + extra)} <span className="small muted">/ month</span>
              </p>
              <p className="muted">Then $1 for every 100 more people, up to 1,000,000.</p>
            </div>
            <div className="price-head">
              <h3>Custom</h3>
              <p className="plan-price">Custom</p>
              <p className="muted">Volume pricing, priority support and migration help.</p>
            </div>
          </div>
          <div className="audience">
            <div className="price-cols">
              <p data-on={plan === 'free'}>
                Up to <strong>1,000</strong> people
              </p>
              <p data-on={plan === 'growth'}>
                Up to <strong>{fmt(growth)}</strong> people
              </p>
              <p data-on={plan === 'custom'}>
                <strong>1 million+</strong> people
              </p>
            </div>
            <div className="track">
              <div className="track-fill" style={{ width: along(stop.pos) }} />
              <input
                id="audience"
                type="range"
                min={0}
                max={1000}
                step={1}
                value={Math.round(stop.pos * 10)}
                aria-label="People you reach a month"
                aria-valuetext={valueText}
                onChange={(e) => setIdx(nearest(Number(e.target.value) / 10))}
                onKeyDown={onKey}
              />
              <div className="track-handle" style={{ left: along(stop.pos) }} aria-hidden="true" />
            </div>
            <div className="track-ticks" aria-hidden="true">
              {STOPS.map((s, i) => (
                <span key={i} className={i === 3 || i >= 12 ? 'major' : undefined} style={{ left: `${s.pos}%` }} />
              ))}
            </div>
            <div className="track-labels small mono muted" aria-hidden="true">
              {LABELS.map(([text, i]) => (
                <span key={text} style={{ left: `${STOPS[i].pos}%` }}>
                  {text}
                </span>
              ))}
            </div>
          </div>
          <div className="price-rows">
            {rows.map((r) => (
              <div className="price-cols" key={r[2] + r[0]}>
                {r.map((cell, i) => (
                  <p key={i}>{cell}</p>
                ))}
              </div>
            ))}
          </div>
          <div className="price-cols price-cta">
            <a href={SIGNUP_URL} className={plan === 'free' ? 'btn btn-solid' : 'btn'}>
              Start free
            </a>
            <a href={SIGNUP_URL} className={plan === 'growth' ? 'btn btn-solid' : 'btn'}>
              Get Growth
            </a>
            <a href="mailto:hello@xstate.com" className={plan === 'custom' ? 'btn btn-solid' : 'btn'}>
              Talk to us
            </a>
          </div>
        </div>
      </div>
      <div className="small muted price-notes">
        <p>People count once a month: everyone you email or who emails you, including Cc and teammates, plus known website visitors. Anonymous visitors and mail in Junk never count.</p>
        <p className="faint">Prices in USD. No charge per seat. Go up to 10% over a limit before anything stops; nothing is ever deleted. Tax added at checkout where required. Payments are handled by Paddle, our reseller.</p>
      </div>
    </section>
  )
}
