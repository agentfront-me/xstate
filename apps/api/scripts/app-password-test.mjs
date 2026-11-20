// Local end-to-end test of app passwords (docs/imap-smtp-relay-plan.md §4): API → app password → IMAP sign-in through
// the mail bridge. Needs the `api-relay` dev server (port 8826), the bridge on 127.0.0.1:1993, and local test data:
// a member (USER_ID in ORG_ID) with a personal mailbox (OWN), someone else's mailbox (OTHER), a shared mailbox the
// member can only read (READ_ONLY), and an owner (ADMIN_ID). Run from apps/api: node scripts/app-password-test.mjs
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import tls from 'node:tls'

const API = process.env.API ?? 'http://localhost:8826'
const { ORG_ID, USER_ID, ADMIN_ID, OWN, OTHER, READ_ONLY } = process.env
const secret = /^JWT_SECRET=(.*)$/m.exec(readFileSync('.dev.vars', 'utf8'))[1].trim().replace(/^"|"$/g, '')
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
const jwt = (sub) => { const now = Math.floor(Date.now() / 1000); const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, iat: now, exp: now + 600 })}`; return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}` }
const api = async (as, method, path, body) => { const r = await fetch(`${API}/v1${path}`, { method, headers: { Authorization: `Bearer ${jwt(as)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => null) } }
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) process.exitCode = 1 }

/** One IMAP sign-in through the bridge; returns the LOGIN answer and, when it worked, the XSTATE line. */
async function login(address, password) {
  const sock = tls.connect({ host: '127.0.0.1', port: 1993, rejectUnauthorized: false })
  let buf = ''
  sock.on('data', (d) => (buf += d))
  const until = async (re) => { for (let i = 0; i < 500; i++) { const m = re.exec(buf); if (m) return m[0]; await new Promise((r) => setTimeout(r, 20)) } throw new Error(`timeout: ${buf}`) }
  await until(/\* OK.*\r\n/)
  sock.write(`a LOGIN "${address}" "${password}"\r\n`)
  const answer = await until(/^a (OK|NO|BAD).*\r\n/m)
  let state = ''
  if (answer.startsWith('a OK')) { sock.write('b XSTATE\r\n'); state = await until(/\* XSTATE.*\r\n/) }
  sock.write('c LOGOUT\r\n'); sock.end()
  return { answer: answer.trim(), state }
}

const base = `/orgs/${ORG_ID}/app-passwords`
const before = await api(USER_ID, 'GET', base)
check('list works and names the server', before.status === 200 && before.json.server?.host === 'mail.xstate.com', `enabled=${before.json.enabled}`)
const made = await api(USER_ID, 'POST', base, { name: 'Local test app' })
check('create returns the password once, in four groups', made.status === 201 && /^([a-z]{4}-){3}[a-z]{4}$/.test(made.json.secret ?? ''))
const pw = made.json.secret, id = made.json.password.id
const listed = await api(USER_ID, 'GET', base)
check('the list never carries the password', listed.json.passwords.some((p) => p.id === id) && !JSON.stringify(listed.json).includes(pw.replaceAll('-', '')))

const own = await login(OWN, pw)
check('own mailbox signs in, can write', own.answer.startsWith('a OK') && own.state.includes(`user=${OWN} can-write=true`), own.answer)
check('typed without dashes and in capitals still works', (await login(OWN.toUpperCase(), pw.replaceAll('-', ' ').toUpperCase())).answer.startsWith('a OK'))
check('read-only shared mailbox signs in read-only', (await login(READ_ONLY, pw)).state.includes('can-write=false'))
check("someone else's mailbox is refused", /AUTHENTICATIONFAILED/.test((await login(OTHER, pw)).answer))
check('wrong password is refused', /AUTHENTICATIONFAILED/.test((await login(OWN, 'aaaa-bbbb-cccc-dddd')).answer))
check('the account password is not an app password', /AUTHENTICATIONFAILED/.test((await login(OWN, 'correct horse battery')).answer))
check('last used is recorded', !!(await api(USER_ID, 'GET', base)).json.passwords.find((p) => p.id === id)?.lastUsedAt)

check('a member cannot switch mail apps off', (await api(USER_ID, 'PUT', `${base}/settings`, { enabled: false })).status === 403)
check('an owner can', (await api(ADMIN_ID, 'PUT', `${base}/settings`, { enabled: false })).json?.enabled === false)
check('switched off: sign-in refused, and said why', /turned off/.test((await login(OWN, pw)).answer))
check('switched off: no new app passwords', (await api(USER_ID, 'POST', base, { name: 'x' })).status === 403)
await api(ADMIN_ID, 'PUT', `${base}/settings`, { enabled: true })
check('switched back on: works again', (await login(OWN, pw)).answer.startsWith('a OK'))

check('an owner sees everyone’s with all=true', (await api(ADMIN_ID, 'GET', `${base}?all=true`)).json.passwords.some((p) => p.id === id && !p.person.you))
check('a member may not', (await api(USER_ID, 'GET', `${base}?all=true`)).status === 403)
check('revoke', (await api(USER_ID, 'DELETE', `${base}/${id}`)).status < 300)
check('revoked: refused', /AUTHENTICATIONFAILED/.test((await login(OWN, pw)).answer))
check('revoked: gone from the list', !(await api(USER_ID, 'GET', base)).json.passwords.some((p) => p.id === id))

let throttled = false
for (let i = 0; i < 12 && !throttled; i++) throttled = /Too many/.test((await login('nobody@m1795006223.test', 'aaaa-bbbb-cccc-dddd')).answer)
check('more than 10 tries a minute on one address are throttled', throttled)
