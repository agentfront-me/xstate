#!/usr/bin/env node
// Creates xstate's Stripe catalog, idempotently (docs/billing-limits-plan.md §3.1): the "xstate Growth" product with
// two monthly prices found by lookup key, and a Customer Portal configuration (invoices, card, cancel at period end;
// no plan switching, since the size is chosen in xstate). Running it again changes nothing that already exists.
//
//   STRIPE_SECRET_KEY=sk_test_… node scripts/billing-catalog.mjs
//
// Without STRIPE_SECRET_KEY in the environment it reads apps/api/.dev.vars (test mode). For live mode, pass the live
// key in the environment explicitly.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
function devVar(name) {
  try {
    const line = readFileSync(join(here, '..', '.dev.vars'), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`))
    return line?.slice(name.length + 1).trim() || undefined
  } catch {
    return undefined
  }
}
const key = process.env.STRIPE_SECRET_KEY ?? devVar('STRIPE_SECRET_KEY')
if (!key?.startsWith('sk_')) {
  console.error('Set STRIPE_SECRET_KEY (sk_test_… or sk_live_…) or put it in apps/api/.dev.vars')
  process.exit(1)
}

function form(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${k}]` : k
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(x))))
    else if (typeof v === 'object') form(v, name, out)
    else out.append(name, String(v))
  }
  return out
}

async function stripe(method, path, params) {
  const body = params ? form(params).toString() : ''
  const res = await fetch(`https://api.stripe.com/v1${path}${method === 'GET' && body ? `?${body}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'POST' ? body : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error?.message ?? res.status}`)
  return json
}

const PRICES = [
  { lookup_key: 'xstate_growth_base', nickname: 'Growth, 5,000 people', unit_amount: 4900 },
  { lookup_key: 'xstate_growth_extra_100', nickname: 'Extra 100 people', unit_amount: 100 },
]

const mode = key.startsWith('sk_live_') ? 'live' : 'test'
console.log(`Stripe ${mode} mode`)

// The product, found by metadata.
const products = await stripe('GET', '/products', { limit: 100, active: 'true' })
let product = products.data.find((p) => p.metadata?.xstate === 'growth')
if (!product) {
  product = await stripe('POST', '/products', {
    name: 'xstate Growth',
    description: 'Business email, contacts, analytics, storage and agents, priced by the people you reach each month.',
    metadata: { xstate: 'growth' },
  })
  console.log('created product', product.id)
} else console.log('product', product.id)

const existing = await stripe('GET', '/prices', { lookup_keys: PRICES.map((p) => p.lookup_key), limit: 10 })
for (const p of PRICES) {
  const found = existing.data.find((x) => x.lookup_key === p.lookup_key)
  if (found) {
    console.log('price', p.lookup_key, found.id)
    continue
  }
  const created = await stripe('POST', '/prices', {
    product: product.id,
    currency: 'usd',
    unit_amount: p.unit_amount,
    recurring: { interval: 'month' },
    lookup_key: p.lookup_key,
    nickname: p.nickname,
    tax_behavior: 'exclusive',
  })
  console.log('created price', p.lookup_key, created.id)
}

const configs = await stripe('GET', '/billing_portal/configurations', { limit: 100 })
const config = configs.data.find((c) => c.active && c.metadata?.xstate === 'growth')
if (config) console.log('portal configuration', config.id)
else {
  const created = await stripe('POST', '/billing_portal/configurations', {
    business_profile: { headline: 'xstate billing' },
    features: {
      invoice_history: { enabled: 'true' },
      payment_method_update: { enabled: 'true' },
      customer_update: { enabled: 'true', allowed_updates: ['email', 'address', 'name', 'tax_id'] },
      subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
    },
    metadata: { xstate: 'growth' },
  })
  console.log('created portal configuration', created.id)
}
