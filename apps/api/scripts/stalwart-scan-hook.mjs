#!/usr/bin/env node
// Makes Stalwart hand every message to the scan service (apps/scanner) before accepting it: an MTA hook at the
// DATA stage (https://stalw.art/docs/mta/filter/mtahooks). The scanner refuses mail with a virus or a blocked
// file type; Stalwart passes that on as the SMTP reply.
//
//   node scripts/stalwart-scan-hook.mjs --dev            the local Stalwart from `pnpm mail:dev` and the scanner
//                                                        from `pnpm --filter @xstate/scanner dev`
//   STALWART_URL=https://mx.xstate.io STALWART_API_KEY=… SCAN_SECRET=… node scripts/stalwart-scan-hook.mjs
//   … --log-only     mail is never held up: if the scanner is down or slow, the message is accepted unscanned.
//                    For the first week, together with SCAN_ENFORCE=false on the scanner.
//   … --remove       take the hook out again
//   … --dry-run      print what would change, change nothing
//
// Without --log-only, a scanner that is down makes Stalwart answer 451 (try again later), so nothing gets in
// unscanned; sending servers retry for days. Safe to run again: it replaces the hook it made before (found by
// its URL) and reloads Stalwart's settings.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const remove = args.has('--remove')
const logOnly = args.has('--log-only')
const here = dirname(fileURLToPath(import.meta.url))

const envFile = (path) => {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.includes('=') && !l.trimStart().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')]),
    )
  } catch {
    return {}
  }
}

let url = process.env.STALWART_URL
let auth = process.env.STALWART_API_KEY ? `Bearer ${process.env.STALWART_API_KEY}` : null
let secret = process.env.SCAN_SECRET
/** Where Stalwart reaches the scanner: the same machine, no TLS. */
const hookUrl = process.env.SCAN_HOOK_URL ?? 'http://127.0.0.1:8765/hook'
if (args.has('--dev')) {
  const admin = envFile(join(here, '..', '.stalwart', 'admin.env'))
  url = 'http://127.0.0.1:18080'
  auth = `Basic ${Buffer.from(`${admin.ADMIN_USER}:${admin.ADMIN_PASSWORD}`).toString('base64')}`
  secret ??= envFile(join(here, '..', '.dev.vars')).SCAN_SECRET || 'dev-scan-secret-local'
}
if (!url || !auth || (!remove && !secret)) {
  console.error('Set STALWART_URL, STALWART_API_KEY and SCAN_SECRET, or pass --dev')
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

const [, { list: hooks }] = await jmap([
  ['x:MtaHook/query', {}],
  ['x:MtaHook/get', { '#ids': { resultOf: 'c0', name: 'x:MtaHook/query', path: '/ids' } }],
])
const ours = hooks.filter((h) => h.url === hookUrl)

const hook = {
  url: hookUrl,
  // Every message on every listener: mail coming in, and mail people send from their mail apps.
  enable: { else: 'true' },
  stages: { data: true },
  httpAuth: { '@type': 'Bearer', bearerToken: { '@type': 'Value', secret } },
  // Milliseconds. ClamAV takes a few seconds on a large message; past this Stalwart treats the scan as failed.
  timeout: 60000,
  tempFailOnError: !logOnly,
  allowInvalidCerts: false,
}

console.log(`Stalwart at ${url}`)
console.log(`  hooks to ${hookUrl} now: ${ours.length}${hooks.length > ours.length ? ` (${hooks.length - ours.length} other hook(s) left alone)` : ''}`)
if (remove) console.log('  removing the scan hook')
else console.log(`  setting the scan hook: every message at DATA, ${logOnly ? 'accepted unscanned if the scanner fails (log-only)' : '451 "try again later" if the scanner fails'}`)
if (dryRun) process.exit(0)

await jmap([
  ['x:MtaHook/set', { destroy: ours.map((h) => h.id), ...(!remove && { create: { h: hook } }) }],
  ['x:Action/set', { create: { r: { '@type': 'ReloadSettings' } } }],
])
console.log('Done; settings reloaded.')
