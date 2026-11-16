#!/usr/bin/env node
// Creates xstate's plans in a Paddle catalog, and prints PADDLE_PRICES (docs/pricing-plan.md, src/billing/plans.ts).
// Safe to run again: products and prices are found by custom_data.xstate and only missing ones are created.
//
//   Sandbox (key from .dev.vars):  node scripts/paddle-catalog.mjs
//   Live:                          PADDLE_API_KEY=pdl_live_… node scripts/paddle-catalog.mjs
//   Look only, create nothing:     add --dry-run
//
// The key needs product and price read and write. Sandbox or live follows the key (pdl_sdbx_… or pdl_live_…).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dryRun = process.argv.includes('--dry-run')

function keyFromDevVars() {
  try {
    const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.dev.vars'), 'utf8')
    return text.match(/^PADDLE_API_KEY=(.+)$/m)?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

const key = process.env.PADDLE_API_KEY || keyFromDevVars()
if (!/^pdl_(sdbx|live)_/.test(key)) {
  console.error('Set PADDLE_API_KEY (pdl_sdbx_… or pdl_live_…), or put the sandbox key in apps/api/.dev.vars.')
  process.exit(1)
}
const live = key.startsWith('pdl_live_')
const base = live ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com'

async function paddle(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Paddle-Version': '1' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${json?.error?.code ?? ''} ${json?.error?.detail ?? ''}`)
  return json.data
}

// What docs/pricing-plan.md decided: per person, monthly or yearly (two months free).
const PLANS = [
  {
    key: 'pro',
    name: 'xstate Pro',
    description: 'Business email on your domain, 30 GB per person, AI search of all your mail, agents and connected AI apps.',
    prices: { month: 600, year: 6000 },
  },
  {
    key: 'team',
    name: 'xstate Team',
    description: 'Everything in Pro with 200 GB per person, longer search history, more agent runs and faster support.',
    prices: { month: 1200, year: 12000 },
  },
]

console.log(`Paddle ${live ? 'LIVE' : 'sandbox'} catalog${dryRun ? ' (dry run)' : ''}`)
const products = await paddle('GET', '/products?per_page=200&status=active')
const out = {}
for (const plan of PLANS) {
  let product = products.find((p) => p.custom_data?.xstate === plan.key)
  if (product) console.log(`  product ${plan.key}: ${product.id} (exists)`)
  else if (dryRun) console.log(`  product ${plan.key}: would create`)
  else {
    product = await paddle('POST', '/products', {
      name: plan.name,
      description: plan.description,
      tax_category: 'saas',
      custom_data: { xstate: plan.key },
    })
    console.log(`  product ${plan.key}: ${product.id} (created)`)
  }
  out[plan.key] = {}
  const prices = product ? await paddle('GET', `/prices?product_id=${product.id}&per_page=200&status=active`) : []
  for (const interval of ['month', 'year']) {
    const tag = `${plan.key}_${interval}`
    let price = prices.find((p) => p.custom_data?.xstate === tag)
    if (price) {
      const amount = Number(price.unit_price.amount)
      if (amount !== plan.prices[interval]) console.warn(`  ! ${tag} is ${amount} cents in Paddle, the plan says ${plan.prices[interval]}`)
      console.log(`  price ${tag}: ${price.id} (exists)`)
    } else if (dryRun) console.log(`  price ${tag}: would create`)
    else {
      price = await paddle('POST', '/prices', {
        product_id: product.id,
        name: interval === 'month' ? 'Monthly, per person' : 'Yearly, per person',
        description: `${plan.name} ${interval === 'month' ? 'monthly' : 'yearly'} USD`,
        unit_price: { amount: String(plan.prices[interval]), currency_code: 'USD' },
        billing_cycle: { interval, frequency: 1 },
        quantity: { minimum: 1, maximum: 10000 },
        tax_mode: 'account_setting',
        custom_data: { xstate: tag },
      })
      console.log(`  price ${tag}: ${price.id} (created)`)
    }
    out[plan.key][interval] = price?.id ?? null
  }
}

console.log('\nPADDLE_PRICES:')
console.log(JSON.stringify(out))
console.log(
  live
    ? '\nPut it in apps/api/wrangler.jsonc as "PADDLE_PRICES": <the object above>.'
    : `\nPut it in apps/api/.dev.vars as PADDLE_PRICES='${JSON.stringify(out)}'`,
)
