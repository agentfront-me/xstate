#!/usr/bin/env node
// Sending caps for mail apps (SMTP submission), which never reach the API's own caps in mailserver/sending.ts.
//
//   node scripts/stalwart-limits.mjs --dev          the local Stalwart from `pnpm mail:dev` (.stalwart/admin.env)
//   STALWART_URL=https://mx.xstate.io STALWART_API_KEY=… node scripts/stalwart-limits.mjs
//   … --dry-run                                      print what would change, change nothing
//
// Safe to run again: it replaces the throttles it made before (description starts with "xstate:") and reloads
// Stalwart's settings, so no restart is needed. Stalwart's own default throttles are left alone.
//
// Stalwart throttles count messages (checked at MAIL FROM), not recipients, so recipients per message are capped
// too. The API counts recipients instead (100 an hour, 500 a day per mailbox).

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const AUTHENTICATED = '!is_empty(authenticated_as)'

/** Recipients one SMTP message may have when the sender signed in. Mail coming in from outside keeps 100. */
const MAX_RECIPIENTS_SIGNED_IN = 25

const THROTTLES = [
  { description: 'xstate: messages per signed-in user per hour', key: { authenticatedAs: true }, rate: { count: 40, period: HOUR } },
  { description: 'xstate: messages per signed-in user per day', key: { authenticatedAs: true }, rate: { count: 200, period: DAY } },
  { description: 'xstate: messages per sending domain per hour', key: { senderDomain: true }, rate: { count: 150, period: HOUR } },
  { description: 'xstate: messages per sending domain per day', key: { senderDomain: true }, rate: { count: 800, period: DAY } },
].map((t) => ({ enable: true, match: { match: {}, else: AUTHENTICATED }, ...t }))

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
let url = process.env.STALWART_URL
let auth = process.env.STALWART_API_KEY ? `Bearer ${process.env.STALWART_API_KEY}` : null
if (args.has('--dev')) {
  const env = Object.fromEntries(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.stalwart', 'admin.env'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')]),
  )
  url = 'http://127.0.0.1:18080'
  auth = `Basic ${Buffer.from(`${env.ADMIN_USER}:${env.ADMIN_PASSWORD}`).toString('base64')}`
}
if (!url || !auth) {
  console.error('Set STALWART_URL and STALWART_API_KEY, or pass --dev')
  process.exit(1)
}

async function jmap(calls) {
  const res = await fetch(new URL('/jmap/', url), {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls.map((c, i) => [...c, `c${i}`]) }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
  const { methodResponses } = await res.json()
  for (const [name, body] of methodResponses) {
    if (name === 'error') throw new Error(`JMAP error: ${JSON.stringify(body)}`)
    const failed = body.notCreated ?? body.notUpdated ?? body.notDestroyed
    if (failed && Object.keys(failed).length) throw new Error(`${name} failed: ${JSON.stringify(failed)}`)
  }
  return methodResponses.map(([, body]) => body)
}

const [, existing, [stage]] = await jmap([
  ['x:MtaInboundThrottle/query', {}],
  ['x:MtaInboundThrottle/get', { '#ids': { resultOf: 'c0', name: 'x:MtaInboundThrottle/query', path: '/ids' } }],
  ['x:MtaStageRcpt/get', { ids: ['singleton'] }],
]).then(([q, g, s]) => [q, g.list, s.list])

const ours = existing.filter((t) => t.description?.startsWith('xstate:'))
const maxRecipients = { match: { 0: { if: AUTHENTICATED, then: String(MAX_RECIPIENTS_SIGNED_IN) } }, else: '100' }

console.log(`Stalwart at ${url}`)
console.log(`  replacing ${ours.length} xstate throttle(s) with ${THROTTLES.length}:`)
for (const t of THROTTLES) console.log(`    ${t.description}: ${t.rate.count}`)
console.log(`  recipients per message: ${MAX_RECIPIENTS_SIGNED_IN} when signed in (was ${JSON.stringify(stage?.maxRecipients)})`)
if (dryRun) process.exit(0)

await jmap([
  ['x:MtaInboundThrottle/set', { destroy: ours.map((t) => t.id), create: Object.fromEntries(THROTTLES.map((t, i) => [`t${i}`, t])) }],
  ['x:MtaStageRcpt/set', { update: { singleton: { maxRecipients } } }],
  ['x:Action/set', { create: { r: { '@type': 'ReloadSettings' } } }],
])
console.log('Done; settings reloaded.')
