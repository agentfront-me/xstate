// Sign-in and onboarding: /login and /signup. One screen at a time is rendered into #view.
//
// Steps: 1 create account → 2 your domain → 3 verify domain → 4 create addresses → 5 connect agent → done.
// After sign-in the step comes from the account itself (domain added? verified? mailboxes?), so a reload or a
// later sign-in resumes where the person left off. Choices the API doesn't store yet (skipping verification,
// finishing step 5) are kept in localStorage.

import { icon } from './icons.js'

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname)
const API = LOCAL ? 'http://localhost:8788/v1' : 'https://api.xstate.com/v1'
const MCP_URL = 'https://mcp.xstate.com/sse'
const SESSION_KEY = 'xstate.session'
const PROGRESS_KEY = 'xstate.onboarding'
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const SHARED_SUGGESTIONS = ['hello', 'support', 'sales']
const POLL_MS = 5000

const view = document.getElementById('view')
const stepLabel = document.getElementById('step')

/** What the API has told us about the signed-in person. */
const state = { user: null, org: null, domain: null, mailboxes: [] }

// ---------------------------------------------------------------------------------------------------------------
// Session, progress and API

function readJson(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

function writeJson(storage, key, value) {
  try {
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(value))
  } catch {
    // Private mode or blocked storage: the flow still works, it just won't survive a reload.
  }
}

function session() {
  const s = readJson(localStorage, SESSION_KEY)
  return s && Date.parse(s.expiresAt) > Date.now() ? s : null
}

function progress() {
  return readJson(localStorage, PROGRESS_KEY) ?? {}
}

function setProgress(changes) {
  writeJson(localStorage, PROGRESS_KEY, { ...progress(), ...changes })
}

class ApiError extends Error {
  constructor(code, message, status) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function api(method, path, body) {
  const token = session()?.token
  let res
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    })
  } catch {
    throw new ApiError('network', "Couldn't reach xstate. Check your connection and try again.", 0)
  }
  if (res.status === 204) return undefined
  const data = await res.json().catch(() => ({}))
  if (res.ok) return data
  if (res.status === 401 && token) {
    signOut()
    throw new ApiError('signed_out', 'Your session ended. Sign in again.', 401)
  }
  throw new ApiError(data.error?.code ?? 'error', data.error?.message ?? 'Something went wrong. Try again.', res.status)
}

function signOut() {
  writeJson(localStorage, SESSION_KEY, null)
  writeJson(localStorage, PROGRESS_KEY, null)
  location.assign('/login')
}

/** Loads the account and works out which step comes next. */
async function resume() {
  const me = await api('GET', '/auth/me')
  state.user = me.user
  state.org = me.organizations.find((o) => o.role === 'owner') ?? me.organizations[0]
  const [{ domains }, { mailboxes }] = await Promise.all([
    api('GET', `/email/orgs/${state.org.id}/domains`),
    api('GET', `/email/orgs/${state.org.id}/mailboxes`),
  ])
  state.domain = domains[0] ?? null
  state.mailboxes = mailboxes

  const p = progress()
  // Signing in to an account that already has addresses: go straight to the dashboard. Onboarding is for new
  // accounts, and a new device (the desktop app) has no local progress to resume.
  if (location.pathname.startsWith('/login') && state.domain && state.mailboxes.length) return location.assign('/app/')
  if (location.pathname.startsWith('/login')) {
    history.replaceState(null, '', '/signup')
    document.title = 'Set up · xstate'
  }
  if (!state.domain) return showDomain()
  if (state.domain.status !== 'verified' && p.skippedVerify !== state.domain.id && !state.mailboxes.length) return showVerify()
  if (!state.mailboxes.length) return showAddresses()
  if (!p.finished) return showAgent()
  return showDone()
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering helpers

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Replaces the screen. `step` is the header label, e.g. '2 of 5'. */
function render(step, html) {
  stopPolling()
  stepLabel.textContent = step
  view.innerHTML = html
  window.scrollTo(0, 0)
}

const $ = (selector) => view.querySelector(selector)

function head(title, sub) {
  return `<div class="head"><h1>${esc(title)}</h1><p>${esc(sub)}</p></div>`
}

function back(label = 'Back') {
  return `<a class="back" data-back href="#">${icon('chevron-left', 14)}${label}</a>`
}

function help(id, { hidden = true } = {}) {
  return `<div class="help" id="${id}" role="status"${hidden ? ' hidden' : ''}></div>`
}

/** Shows a message in a .help element; `kind` is 'error', 'ok' or 'info'. Pass an empty message to hide it. */
function say(el, message, kind = 'error') {
  if (!el) return
  el.hidden = !message
  el.classList.toggle('is-error', kind === 'error')
  const glyph = kind === 'ok' ? 'circle-check' : 'circle-alert'
  el.innerHTML = message ? `${icon(glyph, 13)}<span>${esc(message)}</span>` : ''
}

function onBack(handler) {
  $('[data-back]')?.addEventListener('click', (event) => {
    event.preventDefault()
    handler()
  })
}

/** Disables a button while `work` runs. */
async function busy(button, work) {
  button.disabled = true
  button.setAttribute('aria-busy', 'true')
  try {
    return await work()
  } finally {
    button.disabled = false
    button.removeAttribute('aria-busy')
  }
}

async function copy(button, text) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return
  }
  const original = button.innerHTML
  button.innerHTML = icon('check', 14)
  setTimeout(() => (button.innerHTML = original), 1500)
}

function passwordToggle() {
  const toggle = $('[data-toggle-password]')
  const input = $('input[name="password"]')
  toggle.addEventListener('click', () => {
    const show = input.type === 'password'
    input.type = show ? 'text' : 'password'
    toggle.innerHTML = icon(show ? 'eye-off' : 'eye')
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password')
  })
}

function googleButton() {
  return `
    <button type="button" class="btn" data-google><span class="google" aria-hidden="true">G</span>Continue with Google</button>
    ${help('google-help')}
    <div class="or">or</div>`
}

function onGoogle() {
  $('[data-google]').addEventListener('click', () =>
    say($('#google-help'), 'Google sign-in is coming soon. Use your email for now.', 'info'),
  )
}

const domainName = () => state.domain?.name ?? 'yourbusiness.com'

// ---------------------------------------------------------------------------------------------------------------
// 1 · Create account, and sign in

function showAccount() {
  render('1 of 5', `
    <a class="back" href="/">${icon('chevron-left', 14)}Back</a>
    ${head('Create your account', 'Free email on your own domain, with an AI agent that helps in your inbox.')}
    ${googleButton()}
    <form class="stack" id="form" novalidate>
      <label class="field">Full name
        <span class="input"><input name="name" autocomplete="name" placeholder="Your name" required></span>
      </label>
      <label class="field">Email
        <span class="input"><input name="email" type="email" autocomplete="email" placeholder="you@yourbusiness.com" required></span>
      </label>
      ${help('email-help')}
      <label class="field">Password
        <span class="input">
          <input name="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" minlength="8" required>
          <button type="button" class="icon-btn" data-toggle-password aria-label="Show password">${icon('eye')}</button>
        </span>
      </label>
      ${help('form-help')}
      <button class="btn btn-primary" type="submit">Create account</button>
    </form>
    <div class="small muted center">Already have an account? <a class="link-hi" href="/login">Sign in</a></div>`)

  onGoogle()
  passwordToggle()
  const form = $('#form')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const name = form.name.value.trim()
    const email = form.email.value.trim()
    const password = form.password.value
    say($('#email-help'), '')
    if (!name) return say($('#form-help'), 'Enter your name.')
    if (!form.email.checkValidity() || !email) return say($('#form-help'), 'Enter a valid email address.')
    if (password.length < 8) return say($('#form-help'), 'Use at least 8 characters for your password.')
    say($('#form-help'), '')

    await busy(form.querySelector('[type="submit"]'), async () => {
      try {
        const res = await api('POST', '/auth/register', { name, email, password })
        writeJson(localStorage, SESSION_KEY, { token: res.token, expiresAt: res.expiresAt })
        writeJson(localStorage, PROGRESS_KEY, null)
        await resume()
      } catch (err) {
        if (err.code === 'email_taken') {
          const el = $('#email-help')
          say(el, 'An account with this email already exists.')
          el.querySelector('span').insertAdjacentHTML('beforeend', ' <a class="link-hi" href="/login">Sign in instead</a>')
        } else say($('#form-help'), err.message)
      }
    })
  })
}

function showLogin() {
  render('', `
    <a class="back" href="/">${icon('chevron-left', 14)}Back</a>
    ${head('Sign in to xstate', 'Welcome back. Your inbox is where you left it.')}
    ${googleButton()}
    <form class="stack" id="form" novalidate>
      <label class="field">Email
        <span class="input"><input name="email" type="email" autocomplete="email" placeholder="you@yourbusiness.com" required></span>
      </label>
      <label class="field">Password
        <span class="input">
          <input name="password" type="password" autocomplete="current-password" placeholder="Your password" required>
          <button type="button" class="icon-btn" data-toggle-password aria-label="Show password">${icon('eye')}</button>
        </span>
      </label>
      ${help('form-help')}
      <button class="btn btn-primary" type="submit">Sign in</button>
    </form>
    <div class="small muted center">New to xstate? <a class="link-hi" href="/signup">Create an account</a></div>`)

  onGoogle()
  passwordToggle()
  const form = $('#form')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const email = form.email.value.trim()
    const password = form.password.value
    if (!email || !password) return say($('#form-help'), 'Enter your email and password.')
    say($('#form-help'), '')

    await busy(form.querySelector('[type="submit"]'), async () => {
      try {
        const res = await api('POST', '/auth/login', { email, password })
        writeJson(localStorage, SESSION_KEY, { token: res.token, expiresAt: res.expiresAt })
        await resume()
      } catch (err) {
        say($('#form-help'), err.message)
      }
    })
  })
}

// ---------------------------------------------------------------------------------------------------------------
// 2 · Your domain

/** Accepts what people paste: 'https://www.Example.com/about' → 'example.com'. */
function cleanDomain(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
}

function showDomain() {
  render('2 of 5', `
    ${head("What's your business domain?", 'Your email addresses will end in this. You keep full ownership.')}
    <form class="stack-8" id="form" novalidate>
      <span class="input on-panel" id="domain-box">
        <input name="domain" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="yourbusiness.com"
          aria-label="Domain" aria-describedby="domain-help" value="${esc(state.domain?.name ?? '')}">
        <span class="hi" id="domain-ok" hidden>${icon('circle-check')}</span>
      </span>
      ${help('domain-help')}
    </form>
    <button class="btn btn-primary" id="continue" form="form" type="submit" disabled>Continue</button>
    <a class="link" href="#" id="no-domain">I don't have a domain</a>
    ${help('no-domain-help')}`)

  const form = $('#form')
  const input = form.domain
  const box = $('#domain-box')
  const ok = $('#domain-ok')
  const helpEl = $('#domain-help')
  const button = $('#continue')
  let checked = null
  let timer
  let latest = 0

  const set = ({ error = false, valid = false, message = '', kind = 'info' }) => {
    box.classList.toggle('is-error', error)
    ok.hidden = !valid
    button.disabled = !valid
    say(helpEl, message, kind)
  }

  const check = async (name) => {
    const ticket = ++latest
    try {
      const result = await api('GET', `/email/domain-check?name=${encodeURIComponent(name)}`)
      if (ticket !== latest) return
      checked = result
      const ours = state.domain?.name === result.name
      if (result.taken && !ours) {
        set({ error: true, message: `${result.name} is already on xstate. If it's yours, sign in to that account.`, kind: 'error' })
      } else if (!result.registered) {
        set({ error: true, message: `We couldn't find ${result.name}. Check the spelling, or register it first.`, kind: 'error' })
      } else if (result.provider) {
        set({ valid: true, message: `Looks like your domain is on ${result.provider.name}. We'll show you what to add there next.`, kind: 'ok' })
      } else set({ valid: true, message: "Found it. We'll show you the DNS records to add next.", kind: 'ok' })
    } catch (err) {
      if (ticket === latest) set({ error: true, message: err.message, kind: 'error' })
    }
  }

  const update = ({ final = false } = {}) => {
    clearTimeout(timer)
    checked = null
    latest++
    const name = cleanDomain(input.value)
    if (!name) return set({})
    if (!DOMAIN_RE.test(name)) {
      if (!final) return set({})
      return set({ error: true, message: "That doesn't look like a web address. Try something like yourbusiness.com.", kind: 'error' })
    }
    set({})
    timer = setTimeout(() => check(name), 350)
  }

  input.addEventListener('input', () => update())
  input.addEventListener('blur', () => update({ final: true }))
  if (input.value) update({ final: true })
  else input.focus()

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!checked || button.disabled) return update({ final: true })
    await busy(button, async () => {
      try {
        if (state.domain?.name !== checked.name) {
          // Changing the domain before any address uses it: swap the old one out.
          if (state.domain) await api('DELETE', `/email/domains/${state.domain.id}`)
          state.domain = null
          const { domain } = await api('POST', `/email/orgs/${state.org.id}/domains`, { name: checked.name })
          state.domain = domain
        }
        state.provider = checked.provider
        showVerify()
      } catch (err) {
        set({ error: true, message: err.message, kind: 'error' })
      }
    })
  })

  $('#no-domain').addEventListener('click', (event) => {
    event.preventDefault()
    say($('#no-domain-help'), 'Buying a domain or starting on a free xstate subdomain is coming soon. For now, use a domain you own.', 'info')
  })
}

// ---------------------------------------------------------------------------------------------------------------
// 3 · Verify your domain

let pollTimer
function stopPolling() {
  clearTimeout(pollTimer)
  pollTimer = undefined
}

const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']

function showVerify() {
  const domain = domainName()
  const where = state.provider ? state.provider.name : 'your domain provider'
  render('3 of 5', `
    ${back()}
    <div class="head"><h1 id="title">Verify your domain</h1><p id="sub">Checking ${esc(domain)}…</p></div>
    <div class="records" id="records" hidden></div>
    <a class="link" href="#" id="zone" hidden>Copy every record as a zone file</a>
    <div class="status" id="status" role="status"><span class="spinner"></span><span>Looking up your DNS…</span></div>
    <div class="stack" id="actions"></div>`)
  onBack(showDomain)

  let records = []
  const done = () => state.domain.status === 'verified'

  const draw = () => {
    const required = records.filter((r) => r.required)
    const found = required.filter((r) => r.found).length
    const missing = required.filter((r) => !r.found)

    $('#title').textContent = done() ? 'Your domain is connected' : 'Verify your domain'
    $('#sub').textContent = done()
      ? `${domain} now sends and receives email through xstate.`
      : `Add these ${NUMBERS[records.length] ?? records.length} records at ${where}. We check automatically, so you can leave this page open.`

    const table = $('#records')
    table.hidden = false
    $('#zone').hidden = done()
    table.innerHTML =
      `<div class="rec rec-head"><span></span><span>Type</span><span>Name</span><span>Value</span><span></span></div>` +
      records
        .map(
          (r, i) => `
          <div class="rec">
            <span class="${r.found ? 'ok' : 'wait'}" title="${r.found ? 'Found' : 'Not found yet'}">${icon(r.found ? 'circle-check' : 'circle-dashed')}</span>
            <span class="type">${esc(r.type)} <span class="dim">${esc(r.purpose)}</span></span>
            <button type="button" class="cell" data-copy-name="${i}" title="Copy name: ${esc(r.name)}">${esc(r.name)}</button>
            <button type="button" class="cell" data-copy-value="${i}" title="Copy value">${esc(r.value)}</button>
            <button type="button" class="copy" data-copy-value="${i}" aria-label="Copy value">${icon('copy', 14)}</button>
          </div>`,
        )
        .join('')

    const status = $('#status')
    status.classList.toggle('is-done', done())
    if (done()) status.innerHTML = `${icon('circle-check', 14)}<span>All records found. Verified just now.</span>`
    else {
      const text = !found
        ? 'Checking DNS… this usually takes a few minutes.'
        : missing.length === 1
          ? `${found} of ${required.length} records found. Still checking the ${missing[0].purpose} record…`
          : `${found} of ${required.length} records found. Still checking the rest…`
      status.innerHTML = `<span class="spinner"></span><span>${esc(text)}</span>`
    }

    const actions = $('#actions')
    if (done() && !actions.querySelector('#next')) {
      actions.innerHTML = `<button class="btn btn-primary" id="next">Continue</button>`
      $('#next').addEventListener('click', showAddresses)
    } else if (!done() && !actions.querySelector('#skip')) {
      actions.innerHTML = `
        <a class="btn" id="developer">${icon('send', 14)}Send these to my developer</a>
        <a class="link" href="#" id="skip">Skip, I'll do this later</a>`
      $('#skip').addEventListener('click', (event) => {
        event.preventDefault()
        setProgress({ skippedVerify: state.domain.id })
        showAddresses()
      })
    }
    const developer = $('#developer')
    if (developer) {
      const body =
        `Hi,\n\nPlease add these DNS records for ${domain} so our email works with xstate:\n\n` +
        records.map((r) => `${r.type}  ${r.name}  ${r.value}`).join('\n') +
        `\n\nName "@" means the domain itself (${domain}). Thanks!`
      developer.href = `mailto:?subject=${encodeURIComponent(`DNS records for ${domain}`)}&body=${encodeURIComponent(body)}`
    }
  }

  $('#records').addEventListener('click', (event) => {
    const target = event.target.closest('[data-copy-name], [data-copy-value]')
    if (!target) return
    const record = records[Number(target.dataset.copyName ?? target.dataset.copyValue)]
    const text = target.dataset.copyName !== undefined ? record.name : record.value
    if (target.classList.contains('copy')) copy(target, text)
    else navigator.clipboard?.writeText(text).catch(() => {})
  })

  $('#zone').addEventListener('click', async (event) => {
    event.preventDefault()
    const link = event.currentTarget
    try {
      const { zoneFile } = await api('GET', `/email/domains/${state.domain.id}/dns`)
      await navigator.clipboard.writeText(zoneFile)
      link.textContent = 'Copied. Most DNS providers can import it.'
    } catch (err) {
      link.textContent = err.message ?? "Couldn't copy the zone file"
    }
  })

  const poll = async () => {
    try {
      const result = await api('POST', `/email/domains/${state.domain.id}/verify`)
      state.domain = result.domain
      records = result.records
      draw()
    } catch (err) {
      if (err.code === 'signed_out') return
      $('#status').innerHTML = `<span class="spinner"></span><span>${esc(`Couldn't check DNS just now. Trying again…`)}</span>`
    }
    if (!done() && view.contains($('#status'))) pollTimer = setTimeout(poll, POLL_MS)
  }
  poll()
}

// ---------------------------------------------------------------------------------------------------------------
// 4 · Create your addresses

/** 'Asif Khan' → 'asif'. Falls back to the sign-in email's local part. */
function suggestedLocalPart() {
  const fromName = (state.user.name ?? '').trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9._-]/g, '')
  if (LOCAL_PART_RE.test(fromName)) return fromName
  return state.user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'me'
}

function showAddresses() {
  const domain = domainName()
  const existing = state.mailboxes.map((m) => ({ local: m.address.split('@')[0], kind: m.kind, existing: true }))
  // New rows: the person's own address, plus hello@ pre-selected.
  let rows = existing.length
    ? existing
    : [
        { local: suggestedLocalPart(), kind: 'personal' },
        { local: 'hello', kind: 'shared', removable: true },
      ]

  render('4 of 5', `
    ${back()}
    ${head('Create your email addresses', 'Start with yours. Add shared ones for your team if you like.')}
    <div class="stack-8">
      <div class="stack-8" id="rows"></div>
      <button type="button" class="addr-add" id="custom">${icon('plus', 14)}Custom address</button>
    </div>
    <div class="chips" id="chips"></div>
    ${help('addr-help')}
    <div class="small dim">You can add more anytime.</div>
    <button class="btn btn-primary" id="create">Create inbox</button>`)
  onBack(showVerify)

  const drawRows = () => {
    $('#rows').innerHTML = rows
      .map(
        (r, i) => `
        <div class="addr">
          <input value="${esc(r.local)}" data-row="${i}" aria-label="Address name"
            autocapitalize="off" spellcheck="false" ${r.existing ? 'readonly' : ''}>
          <span class="at">@${esc(domain)}</span>
          ${r.existing ? `<span class="done" title="Created">${icon('check', 14)}</span>` : ''}
          ${r.removable && !r.existing ? `<button type="button" class="remove" data-remove="${i}" aria-label="Remove ${esc(r.local)}@">${icon('x', 14)}</button>` : ''}
        </div>`,
      )
      .join('')
    $('#chips').innerHTML = SHARED_SUGGESTIONS.map((local) => {
      const on = rows.some((r) => r.local === local)
      return `<button type="button" class="chip" data-chip="${local}" aria-pressed="${on}">${icon(on ? 'check' : 'plus', 12)}${local}@</button>`
    }).join('')
    const pending = rows.some((r) => !r.existing)
    $('#create').textContent = pending || !existing.length ? 'Create inbox' : 'Continue'
  }
  drawRows()

  $('#rows').addEventListener('input', (event) => {
    const i = Number(event.target.dataset.row)
    rows[i].local = event.target.value
  })
  $('#rows').addEventListener('change', () => drawRows())
  $('#rows').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]')
    if (!remove) return
    rows.splice(Number(remove.dataset.remove), 1)
    drawRows()
  })
  $('#chips').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-chip]')
    if (!chip) return
    const local = chip.dataset.chip
    const at = rows.findIndex((r) => r.local === local)
    if (at === -1) rows.push({ local, kind: 'shared', removable: true })
    else if (!rows[at].existing) rows.splice(at, 1)
    drawRows()
  })
  $('#custom').addEventListener('click', () => {
    rows.push({ local: '', kind: 'shared', removable: true })
    drawRows()
    $(`[data-row="${rows.length - 1}"]`).focus()
  })

  $('#create').addEventListener('click', (event) =>
    busy(event.currentTarget, async () => {
      const helpEl = $('#addr-help')
      rows = rows.filter((r) => r.existing || r.local.trim())
      for (const r of rows) r.local = r.local.trim().toLowerCase()
      const fresh = rows.filter((r) => !r.existing)
      const bad = fresh.find((r) => !LOCAL_PART_RE.test(r.local) || r.local.includes('..'))
      if (bad) return say(helpEl, `${bad.local}@ can only use letters, numbers, dots, dashes and underscores.`)
      const dup = rows.find((r, i) => rows.findIndex((other) => other.local === r.local) !== i)
      if (dup) return say(helpEl, `${dup.local}@ is in the list twice.`)
      if (!rows.some((r) => r.kind === 'personal')) fresh.unshift({ local: suggestedLocalPart(), kind: 'personal' })
      say(helpEl, '')

      for (const r of fresh) {
        try {
          const { mailbox } = await api('POST', `/email/domains/${state.domain.id}/mailboxes`, {
            kind: r.kind,
            localPart: r.local,
            ...(r.kind === 'personal' && { ownerMemberId: state.org.memberId, displayName: state.user.name }),
          })
          state.mailboxes.push(mailbox)
          r.existing = true
        } catch (err) {
          drawRows()
          const address = `${r.local}@${domain}`
          return say(helpEl, err.message.includes(address) ? err.message : `${address}: ${err.message}`)
        }
      }
      showAgent()
    }),
  )
}

// ---------------------------------------------------------------------------------------------------------------
// 5 · Connect your agent

const AGENTS = [
  { id: 'claude', name: 'Claude', icon: 'sparkles', label: 'Add xstate to Claude. You approve it once in Claude, then it shows up as a connector.' },
  { id: 'code', name: 'Claude Code', icon: 'terminal', label: 'Run this in your terminal', snippet: `claude mcp add --transport sse xstate ${MCP_URL}` },
  { id: 'codex', name: 'Codex', icon: 'square-code', label: 'Run this in your terminal', snippet: `codex mcp add xstate --url ${MCP_URL}` },
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'mouse-pointer-2',
    label: 'Add this to .cursor/mcp.json',
    snippet: `{\n  "mcpServers": {\n    "xstate": { "url": "${MCP_URL}" }\n  }\n}`,
  },
]

function showAgent() {
  const p = progress()
  let selected = p.agent?.id ?? 'claude'
  const personal = state.mailboxes.find((m) => m.kind === 'personal')

  render('5 of 5', `
    ${back()}
    ${head('Connect your AI agent', 'Let the agent you already use read and draft email for you. Optional.')}
    <div class="agents" id="agents"></div>
    <div class="panel">
      <div class="panel-section" id="setup"></div>
      <fieldset class="panel-section">
        <legend>Addresses the agent can access</legend>
        ${state.mailboxes
          .map(
            (m) => `
            <label class="option">
              <input type="checkbox" name="address" value="${esc(m.address)}" ${m === personal ? 'checked' : ''}>
              <span class="box">${icon('check', 12)}</span>${esc(m.address)}
            </label>`,
          )
          .join('')}
      </fieldset>
      <fieldset class="panel-section">
        <legend>Access level</legend>
        <label class="option"><input type="radio" name="access" value="draft" checked><span class="radio"></span>
          <span>Draft only<small>You approve before anything is sent.</small></span></label>
        <label class="option"><input type="radio" name="access" value="send"><span class="radio"></span>
          <span>Draft and send<small>The agent can reply on its own.</small></span></label>
      </fieldset>
    </div>
    <div class="tip">${icon('message-square', 14)}<span>Try it. Ask your agent: <span class="hi">"Summarize my inbox"</span></span></div>
    <button class="btn btn-primary" id="finish">Continue to inbox</button>
    <a class="link" href="#" id="skip">Skip for now</a>`)
  onBack(showAddresses)

  const draw = () => {
    $('#agents').innerHTML = AGENTS.map(
      (a) => `
      <button type="button" class="agent" data-agent="${a.id}" aria-pressed="${a.id === selected}">
        <span class="agent-icon">${icon(a.icon)}</span>
        <span class="agent-name">${esc(a.name)}</span>
        ${a.id === selected ? `<span class="check">${icon('check', 14)}</span>` : ''}
      </button>`,
    ).join('')
    const agent = AGENTS.find((a) => a.id === selected)
    $('#setup').innerHTML = `
      <div class="small muted">${esc(agent.label)}</div>
      ${
        agent.snippet
          ? `<div class="snippet"><pre>${esc(agent.snippet)}</pre><button type="button" data-copy-snippet aria-label="Copy">${icon('copy', 14)}</button></div>`
          : `<a class="btn btn-primary" href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">${icon('plug', 14)}Add connector</a>`
      }`
    $('[data-copy-snippet]')?.addEventListener('click', (event) => copy(event.currentTarget, agent.snippet))
  }
  draw()

  $('#agents').addEventListener('click', (event) => {
    const card = event.target.closest('[data-agent]')
    if (!card) return
    selected = card.dataset.agent
    draw()
  })

  $('#finish').addEventListener('click', () => {
    const addresses = [...view.querySelectorAll('input[name="address"]:checked')].map((i) => i.value)
    const access = view.querySelector('input[name="access"]:checked').value
    setProgress({ finished: true, agent: { id: selected, addresses, access } })
    showDone()
  })
  $('#skip').addEventListener('click', (event) => {
    event.preventDefault()
    setProgress({ finished: true })
    showDone()
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Done

function showDone() {
  const personal = state.mailboxes.find((m) => m.kind === 'personal') ?? state.mailboxes[0]
  const verified = state.domain?.status === 'verified'
  const agent = progress().agent
  const first = (state.user.name ?? '').split(/\s+/)[0]
  const items = [
    { label: 'Create your first address', done: true },
    { label: `Connect ${domainName()}`, done: verified, action: 'Connect', go: showVerify },
    { label: 'Send yourself a test email' },
    { label: 'Add a teammate' },
    { label: 'Connect an AI agent', done: !!agent, action: 'Connect', go: showAgent },
  ]

  render('Done', `
    ${head('Your inbox is ready', `Hi${first ? ` ${first}` : ''}, your address is ${personal?.address ?? ''}.`)}
    <p class="muted">A few small things will get you fully set up:</p>
    <div class="checklist">
      ${items
        .map(
          (item, i) => `
          <div class="check-item${item.done ? ' is-done' : ''}">
            ${icon(item.done ? 'circle-check' : 'circle', 16)}
            <span>${esc(item.label)}</span>
            ${item.action && !item.done ? `<button type="button" class="mini" data-item="${i}">${item.action}</button>` : ''}
          </div>`,
        )
        .join('')}
    </div>
    ${verified ? '' : `<div class="small muted">Mail to ${esc(domainName())} starts arriving once its DNS records are in place.</div>`}
    <a class="btn btn-primary" href="/app/">Open xstate</a>
    <a class="link" href="#" id="sign-out">Sign out</a>`)

  view.querySelector('.checklist').addEventListener('click', (event) => {
    const button = event.target.closest('[data-item]')
    if (button) items[Number(button.dataset.item)].go()
  })
  $('#sign-out').addEventListener('click', (event) => {
    event.preventDefault()
    signOut()
  })
}

// ---------------------------------------------------------------------------------------------------------------

async function start() {
  const onLogin = location.pathname.startsWith('/login')
  if (!session()) return onLogin ? showLogin() : showAccount()
  try {
    await resume()
  } catch (err) {
    if (err.code === 'signed_out') return
    render('', `${head("Something's not right", err.message)}<button class="btn" id="retry">Try again</button>`)
    $('#retry').addEventListener('click', start)
  }
}

start()
