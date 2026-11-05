// Settings: Account, Members, Domains, Secrets, Billing, Integrations.
//
// Account and Domains use the API when signed in. Members, Secrets, Billing and Integrations have no API yet:
// they show sample data, marked "Sample data" in the header when signed in, and changes stay in memory.

import { applyTheme, desktop, esc, initials, isEmail, signOut, themeChoice, toast } from './core.js'
import { icon } from './icons.js'
import { addDomain, isDemo, mailboxesOf, removeDomain, store, verifyDomain } from './store.js'

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

let root = null
let ctx = null
let current = 'account'

const SECTIONS = [
  { id: 'account', label: 'Account', icon: 'user', sub: () => 'Profile, appearance, desktop app' },
  {
    id: 'members',
    label: 'Members',
    icon: 'users',
    sub: () => {
      const invited = store.members.filter((m) => m.invited).length
      const n = 1 + store.members.length - invited
      return `${n} ${n === 1 ? 'member' : 'members'}${invited ? ` · ${invited} invited` : ''}`
    },
  },
  {
    id: 'domains',
    label: 'Domains',
    icon: 'at-sign',
    sub: () => {
      const n = store.domains.length
      if (!n) return 'No domains yet'
      return `${store.domains.filter((d) => d.status === 'verified').length} of ${n} verified`
    },
  },
  { id: 'secrets', label: 'Secrets', icon: 'key-round', sample: true, sub: () => `${store.secrets.length} organization secrets` },
  { id: 'billing', label: 'Billing', icon: 'credit-card', sample: true, sub: () => `${store.billing.plan} · renews ${store.billing.renewsShort}` },
  {
    id: 'integrations',
    label: 'Integrations',
    icon: 'blocks',
    sample: true,
    sub: () => `${store.integrations.filter((i) => i.connected).length} connected`,
  },
]

export function renderSettings(container, section, context) {
  root = container
  ctx = context
  current = SECTIONS.some((s) => s.id === section) ? section : 'account'
  const s = SECTIONS.find((x) => x.id === current)
  root.innerHTML = `
    <section class="settings">
      <nav class="settings-nav" aria-label="Settings">
        <div class="col-head drag"><span class="title">Settings</span></div>
        <div class="items">${SECTIONS.map(
          (x) => `
          <button class="set-item" data-section="${x.id}" ${x.id === current ? 'aria-current="page"' : ''}>
            <span class="tile">${icon(x.icon, 14)}</span>
            <span class="text"><span class="name">${x.label}</span><span class="sub ellipsis">${esc(x.sub())}</span></span>
          </button>`,
        ).join('')}</div>
      </nav>
      <div class="settings-main">
        <div class="settings-head drag">
          <div class="title">${s.label}${s.sample && !isDemo() ? '<span class="tag" title="This section has no API yet">Sample data</span>' : ''}</div>
          <div class="sub">${esc(s.sub())}</div>
        </div>
        <div class="settings-scroll"><div class="settings-body" id="body"></div></div>
      </div>
    </section>`
  root.querySelector('.settings-nav').addEventListener('click', (event) => {
    const item = event.target.closest('[data-section]')
    if (item) ctx.navigate(`#/settings/${item.dataset.section}`)
  })
  const body = root.querySelector('#body')
  ;({ account, members, domains, secrets, billing, integrations })[current](body)
}

const rerender = () => renderSettings(root, current, ctx)

function group(title, sub = '', aside = '') {
  return `<div class="group-head"><div class="text"><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</div>${aside}</div>`
}

function busy(button, on) {
  button.disabled = on
  button.setAttribute('aria-busy', String(on))
}

// ---------------------------------------------------------------------------------------------------------------
// Account

const DESKTOP_TOGGLES = [
  { key: 'launchAtLogin', name: 'Launch at login', sub: 'Open xstate in the background when you sign in.' },
  { key: 'notifications', name: 'Desktop notifications', sub: 'New mail, escalations and agent handoffs.' },
  { key: 'menuBar', name: 'Show in menu bar', sub: 'Keep unread count visible when the window is closed.' },
  { key: 'autoUpdate', name: 'Install updates automatically', sub: 'Updates download in the background and apply on restart.' },
]

async function account(body) {
  const theme = themeChoice()
  body.innerHTML = `
    <div class="group">
      ${group('Profile')}
      <div class="fields">
        <label class="field">Name<input class="text-input" value="${esc(store.user.name ?? '')}" readonly title="Name changes are coming soon"></label>
        <label class="field">Email<input class="text-input" value="${esc(store.user.email)}" readonly></label>
      </div>
    </div>
    <div class="group">
      ${group('Appearance')}
      <div class="choices" role="group" aria-label="Appearance">
        ${[
          ['light', 'Light', 'sun'],
          ['dark', 'Dark', 'moon'],
          ['system', 'System', 'monitor'],
        ]
          .map(([id, label, ic]) => `<button class="choice" data-theme="${id}" aria-pressed="${theme === id}">${icon(ic, 15)}${label}</button>`)
          .join('')}
      </div>
    </div>
    <div class="group" id="desktop">
      ${group('Desktop app')}
      ${
        desktop
          ? `<div class="card">${DESKTOP_TOGGLES.map(
              (t) => `
            <div class="card-row"><div class="text"><span class="name">${t.name}</span><span class="sub">${t.sub}</span></div>
              <button class="switch" role="switch" data-key="${t.key}" aria-checked="false" aria-label="${t.name}"></button></div>`,
            ).join('')}</div>
            <div class="foot-line"><span id="version">xstate for ${esc(desktop.platformName)} · Version ${esc(desktop.version)}</span>
              <button class="btn" id="updates">${icon('refresh-cw', 14)}Check for updates</button></div>`
          : `<div class="card solo"><div class="card-row">${icon('monitor', 16)}
              <div class="text"><span class="name">xstate for desktop</span>
              <span class="sub">Launch at login, desktop notifications and the menu bar count live in the desktop app.</span></div></div></div>`
      }
    </div>
    <div class="card solo"><div class="card-row">
      <div class="text"><span class="name">Sign out</span>
        <span class="sub">${isDemo() ? 'You are looking at the demo. Sign in to see your own account.' : `Signed in as ${esc(store.user.email)}${desktop ? ' on this computer' : ''}.`}</span></div>
      <button class="btn" id="sign-out">${isDemo() ? 'Sign in' : 'Sign out'}</button>
    </div></div>`

  body.querySelector('.choices').addEventListener('click', (event) => {
    const choice = event.target.closest('[data-theme]')
    if (!choice) return
    applyTheme(choice.dataset.theme)
    ctx.refreshRail()
    body.querySelectorAll('[data-theme]').forEach((b) => b.setAttribute('aria-pressed', String(b === choice)))
  })
  body.querySelector('#sign-out').addEventListener('click', () => (isDemo() ? location.assign('/login') : signOut()))

  if (!desktop) return
  const settings = await desktop.getSettings()
  body.querySelectorAll('.switch').forEach((sw) => {
    sw.setAttribute('aria-checked', String(!!settings[sw.dataset.key]))
    sw.addEventListener('click', async () => {
      const on = sw.getAttribute('aria-checked') !== 'true'
      sw.setAttribute('aria-checked', String(on))
      try {
        await desktop.setSetting(sw.dataset.key, on)
      } catch (err) {
        sw.setAttribute('aria-checked', String(!on))
        toast(err.message ?? "Couldn't change that setting")
      }
    })
  })
  const updates = body.querySelector('#updates')
  updates.addEventListener('click', async () => {
    busy(updates, true)
    try {
      toast(await desktop.checkForUpdates())
    } catch (err) {
      toast(err.message ?? "Couldn't check for updates")
    } finally {
      busy(updates, false)
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Members

function members(body) {
  const me = { id: 'me', name: store.user.name, email: store.user.email, role: 'owner', seen: 'Active now' }
  const rows = [me, ...store.members]
  body.innerHTML = `
    <div class="group">
      ${group('Invite', 'Members can use the shared inbox, agents and databases. Admins can also manage billing and secrets.')}
      <form class="inline-form" id="invite" novalidate>
        <input class="text-input" id="invite-email" type="email" placeholder="name@company.com" aria-label="Email to invite" autocomplete="off">
        <select class="select" id="invite-role" aria-label="Role"><option value="member">Member</option><option value="admin">Admin</option></select>
        <button class="btn btn-primary" style="height:34px">Send invite</button>
      </form>
      <div class="form-error" id="invite-err" role="alert"></div>
    </div>
    <div class="group">
      ${group('Members')}
      <div class="card">${rows
        .map(
          (m) => `
        <div class="card-row">
          <span class="avatar md">${esc(m.invited ? m.email[0].toUpperCase() : initials(m.name || m.email))}</span>
          <div class="text"><span class="name ellipsis">${esc(m.invited ? m.email : m.name || m.email)}</span>
            <span class="sub ellipsis">${esc(m.invited ? `Invite pending · ${cap(m.role)}` : `${m.email} · ${m.seen ?? ''}`)}</span></div>
          ${
            m.role === 'owner'
              ? '<span class="right">Owner</span>'
              : `<span class="right">
                  <select class="select sm" data-role="${m.id}" aria-label="Role for ${esc(m.name || m.email)}">
                    <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
                    <option value="member" ${m.role === 'member' ? 'selected' : ''}>Member</option>
                  </select>
                  <button class="x-btn" data-remove="${m.id}" aria-label="Remove ${esc(m.name || m.email)}">${icon('x', 14)}</button></span>`
          }
        </div>`,
        )
        .join('')}</div>
    </div>`

  body.querySelector('#invite').addEventListener('submit', (event) => {
    event.preventDefault()
    const email = body.querySelector('#invite-email').value.trim().toLowerCase()
    const err = body.querySelector('#invite-err')
    if (!isEmail(email)) return (err.textContent = 'Enter a valid email address.')
    if (!isDemo()) return (err.textContent = 'Inviting teammates is coming soon.')
    if (rows.some((m) => m.email === email)) return (err.textContent = `${email} is already on the team.`)
    store.members.push({ id: `mem_${Date.now()}`, name: null, email, role: body.querySelector('#invite-role').value, invited: true })
    toast(`Invite sent to ${email}`)
    rerender()
  })
  body.addEventListener('change', (event) => {
    const select = event.target.closest('[data-role]')
    if (!select) return
    store.members.find((m) => m.id === select.dataset.role).role = select.value
    toast('Role updated')
  })
  body.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove]')
    if (!remove) return
    const m = store.members.find((x) => x.id === remove.dataset.remove)
    if (!confirm(`Remove ${m.name || m.email} from ${store.org.name ?? 'the organization'}?`)) return
    store.members = store.members.filter((x) => x !== m)
    rerender()
  })
}

const cap = (s) => s[0].toUpperCase() + s.slice(1)

// ---------------------------------------------------------------------------------------------------------------
// Domains

function domains(body) {
  body.innerHTML = `
    <div class="group">
      ${group('Email domains', 'Agents send and receive mail from mailboxes on verified domains.')}
      ${
        store.domains.length
          ? `<div class="card">${store.domains.map(domainRow).join('')}</div>`
          : '<div class="card solo"><div class="card-row"><span class="lead">' +
            icon('at-sign', 16) +
            '</span><div class="text"><span class="name">No domains yet</span><span class="sub">Add a domain you own to start receiving mail on it.</span></div></div></div>'
      }
      <form class="inline-form" id="add" novalidate>
        <input class="text-input" id="domain" placeholder="example.com" aria-label="Domain" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" style="height:34px">Add domain</button>
      </form>
      <div class="form-error" id="add-err" role="alert"></div>
    </div>`

  body.querySelector('#add').addEventListener('submit', async (event) => {
    event.preventDefault()
    const input = body.querySelector('#domain')
    const err = body.querySelector('#add-err')
    const name = input.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!DOMAIN_RE.test(name)) return (err.textContent = 'Enter a domain like example.com.')
    if (store.domains.some((d) => d.name === name)) return (err.textContent = `${name} is already added.`)
    const button = event.submitter
    busy(button, true)
    try {
      await addDomain(name)
      toast(`${name} added. Add its DNS records to verify it.`)
      rerender()
    } catch (e) {
      err.textContent = e.message
      busy(button, false)
    }
  })

  body.addEventListener('click', async (event) => {
    const button = event.target.closest('button')
    if (!button) return
    if (button.dataset.check) {
      busy(button, true)
      try {
        const { domain } = await verifyDomain(button.dataset.check)
        toast(domain?.status === 'verified' ? 'Verified. Mail is on.' : 'Some records are still missing.')
        rerender()
      } catch (e) {
        toast(e.message)
        busy(button, false)
      }
    }
    if (button.dataset.remove) {
      const d = store.domains.find((x) => x.id === button.dataset.remove)
      const n = mailboxesOf(d.id).length
      if (!confirm(`Remove ${d.name}?${n ? ` Its ${n} ${n === 1 ? 'mailbox' : 'mailboxes'} will stop receiving mail.` : ''}`)) return
      busy(button, true)
      try {
        await removeDomain(d.id)
        toast(`${d.name} removed`)
        rerender()
      } catch (e) {
        toast(e.message)
        busy(button, false)
      }
    }
    if (button.dataset.copy) {
      try {
        await navigator.clipboard.writeText(button.dataset.copy)
        toast('Copied')
      } catch {
        toast("Couldn't copy")
      }
    }
  })
}

/** Whether mail from this domain can reach outside addresses yet (Amazon SES verification). */
function sendingLabel(d) {
  if (d.sending === 'verified') return ' · Sending ready'
  if (d.sending === 'failed') return ' · Sending failed: check the DKIM records'
  if (d.sending === 'pending') return ' · Sending pending: waiting for DKIM records'
  return ''
}

function domainRow(d) {
  const n = mailboxesOf(d.id).length
  const verified = d.status === 'verified'
  const records = verified ? [] : (store.records[d.id] ?? [])
  return `
    <div class="card-row">
      <span class="lead">${icon('at-sign', 16)}</span>
      <div class="text"><span class="name">${esc(d.name)}</span><span class="sub">${n} ${n === 1 ? 'mailbox' : 'mailboxes'}${sendingLabel(d)}</span></div>
      <span class="right">
        ${
          verified
            ? `<span class="status">${icon('circle-check', 14)}Verified</span>`
            : `<span class="status pending">${icon('clock', 14)}Pending DNS</span><button class="btn" data-check="${d.id}">Check DNS</button>`
        }
        <button class="x-btn" data-remove="${d.id}" aria-label="Remove ${esc(d.name)}">${icon('x', 14)}</button>
      </span>
    </div>
    ${
      records.length
        ? `<div class="records"><table>
        <thead><tr><th>Type</th><th>Name</th><th>Value</th><th></th></tr></thead>
        <tbody>${records
          .map(
            (r) => `<tr${r.found ? ' class="found"' : ''}><td>${esc(r.type)}</td><td>${esc(r.name)}</td><td>${esc(r.value)}</td>
            <td>${r.found ? icon('check', 13) : `<button data-copy="${esc(r.value)}" aria-label="Copy ${esc(r.type)} value">${icon('copy', 13)}</button>`}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
        : ''
    }`
}

// ---------------------------------------------------------------------------------------------------------------
// Secrets

function secrets(body) {
  body.innerHTML = `
    <div class="group">
      ${group(
        'Organization secrets',
        "Encrypted values agents and workflows read as environment variables. Values can't be viewed after saving.",
        `<button class="btn" id="new">${icon('plus', 14)}New secret</button>`,
      )}
      <form class="inline-form" id="form" hidden novalidate>
        <input class="text-input mono" id="s-name" placeholder="NAME" aria-label="Secret name" autocomplete="off" spellcheck="false">
        <input class="text-input" id="s-value" type="password" placeholder="Value" aria-label="Secret value" autocomplete="new-password">
        <button class="btn btn-primary" style="height:34px">Save</button>
      </form>
      <div class="form-error" id="s-err" role="alert"></div>
      <div class="card">${
        store.secrets
          .map(
            (s) => `
        <div class="card-row">
          <span class="lead">${icon('key-round', 15)}</span>
          <div class="text"><span class="name mono small">${esc(s.name)}</span>
            <span class="sub">${esc(s.usedBy || 'Not used yet')} · Updated ${esc(s.updated)}</span></div>
          <span class="right"><span aria-label="Hidden value">••••••••</span>
            <button class="x-btn" data-delete="${esc(s.name)}" aria-label="Delete ${esc(s.name)}">${icon('trash', 14)}</button></span>
        </div>`,
          )
          .join('') ||
        '<div class="card-row"><div class="text"><span class="sub">No secrets yet.</span></div></div>'
      }</div>
    </div>`

  const form = body.querySelector('#form')
  body.querySelector('#new').addEventListener('click', () => {
    form.hidden = false
    form.querySelector('#s-name').focus()
  })
  form.querySelector('#s-name').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const name = form.querySelector('#s-name').value.trim()
    const value = form.querySelector('#s-value').value
    const err = body.querySelector('#s-err')
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return (err.textContent = 'Names use capital letters, digits and underscores.')
    if (!value) return (err.textContent = 'Enter a value.')
    store.secrets = store.secrets.filter((s) => s.name !== name)
    store.secrets.unshift({ name, usedBy: '', updated: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) })
    toast(`${name} saved`)
    rerender()
  })
  body.addEventListener('click', (event) => {
    const del = event.target.closest('[data-delete]')
    if (!del) return
    if (!confirm(`Delete ${del.dataset.delete}? Agents that read it will stop working until you add it again.`)) return
    store.secrets = store.secrets.filter((s) => s.name !== del.dataset.delete)
    rerender()
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Billing

function billing(body) {
  const b = store.billing
  const used = 1 + store.members.filter((m) => !m.invited).length
  body.innerHTML = `
    <div class="card solo"><div class="card-row">
      <div class="text"><span class="name">${esc(b.plan)} · ${esc(b.price)}</span>
        <span class="sub">Renews ${esc(b.renews)}. ${b.seats} seats, ${used} of them in use.</span></div>
      <button class="btn">Change plan</button>
    </div></div>
    <div class="group">
      ${group('Usage this period')}
      <div class="card">${b.usage
        .map(
          (u) => `
        <div class="usage"><div class="line"><span>${esc(u.label)}</span><span>${esc(u.format(u.used, u.total))}</span></div>
          <div class="meter" role="meter" aria-label="${esc(u.label)}" aria-valuenow="${u.used}" aria-valuemin="0" aria-valuemax="${u.total}">
            <span style="width:${Math.min(100, (u.used / u.total) * 100).toFixed(1)}%"></span></div></div>`,
        )
        .join('')}</div>
    </div>
    <div class="group">
      ${group('Payment method')}
      <div class="card"><div class="card-row">
        <span class="lead">${icon('credit-card', 16)}</span>
        <div class="text"><span class="name">${esc(b.card.brand)} ending in ${esc(b.card.last4)}</span>
          <span class="sub">Expires ${esc(b.card.expires)} · ${esc(b.card.email)}</span></div>
        <button class="btn">Update</button>
      </div></div>
    </div>
    <div class="group">
      ${group('Invoices')}
      <div class="card">${b.invoices
        .map(
          (i) => `
        <div class="card-row"><div class="text"><span class="name">${esc(i.date)}</span></div>
          <span class="right">Paid <span class="hi" style="min-width:56px;text-align:right">${esc(i.amount)}</span>
          <button class="x-btn" aria-label="Download invoice for ${esc(i.date)}">${icon('download', 14)}</button></span></div>`,
        )
        .join('')}</div>
    </div>`
  body.addEventListener('click', (event) => {
    if (event.target.closest('button')) toast('Billing changes are coming soon')
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Integrations

function integrations(body) {
  body.innerHTML = `
    <div class="group">
      ${group('Channels and apps', 'Connected apps are available to every agent as triggers and MCP connectors.')}
      <div class="card">${store.integrations
        .map(
          (i) => `
        <div class="card-row">
          <span class="app-tile" aria-hidden="true">${esc(i.glyph)}</span>
          <div class="text"><span class="name">${esc(i.name)}</span>
            <span class="sub ellipsis">${esc(i.connected ? `Connected · ${i.detail}` : i.about)}</span></div>
          <button class="btn${i.connected ? '' : ' btn-primary'}" data-app="${i.id}">${i.connected ? 'Disconnect' : 'Connect'}</button>
        </div>`,
        )
        .join('')}</div>
    </div>`
  body.addEventListener('click', (event) => {
    const button = event.target.closest('[data-app]')
    if (!button) return
    const app = store.integrations.find((i) => i.id === button.dataset.app)
    if (app.connected && !confirm(`Disconnect ${app.name}? Agents lose access to it right away.`)) return
    app.connected = !app.connected
    if (app.connected) app.detail ??= app.about
    toast(`${app.name} ${app.connected ? 'connected' : 'disconnected'}`)
    rerender()
  })
}
