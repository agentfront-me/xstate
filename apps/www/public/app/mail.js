// Email: folders and domains, the message list, and the reader with agent drafts and a reply box.
//
// Messages have no API yet, so they live in `store.messages` (sample data in demo mode, empty when signed in) and
// every action here changes them in memory. Domains and addresses are real when signed in.

import { esc, initials, isEmail, toast } from './core.js'
import { icon } from './icons.js'
import { isDemo, mailboxesOf, store } from './store.js'

const FOLDERS = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'pinned', label: 'Pinned', icon: 'pin' },
  { id: 'sent', label: 'Sent', icon: 'send' },
  { id: 'drafts', label: 'Drafts', icon: 'file-pen' },
  { id: 'archive', label: 'Archive', icon: 'archive' },
  { id: 'spam', label: 'Spam', icon: 'shield-alert' },
]

/** What the Email page is showing. Kept across page switches. */
const view = {
  folder: 'inbox',
  /** null for all inboxes, or { domainId } or { address }. */
  scope: null,
  unreadOnly: false,
  query: '',
  searching: false,
  selectedId: null,
  /** Reply text and From address per message id, so a re-render doesn't lose what was typed. */
  replies: {},
}

let root = null
let ctx = null

// ---------------------------------------------------------------------------------------------------------------
// Queries

const byTime = (a, b) => Date.parse(b.time) - Date.parse(a.time)
const domainOf = (address) => address.split('@')[1] ?? ''

function inScope(m) {
  if (!view.scope) return true
  const address = m.folder === 'sent' ? m.from.email : m.to
  if (view.scope.address) return address === view.scope.address
  const domain = store.domains.find((d) => d.id === view.scope.domainId)
  return domain ? domainOf(address) === domain.name : true
}

function inFolder(m, folder) {
  if (folder === 'pinned') return m.pinned && m.folder !== 'spam'
  return m.folder === folder
}

function matches(m) {
  const q = view.query.trim().toLowerCase()
  if (!q) return true
  return [m.from.name, m.from.email, m.to, m.subject, ...m.body].some((s) => s?.toLowerCase().includes(q))
}

function visible() {
  return store.messages
    .filter((m) => inFolder(m, view.folder) && inScope(m) && (!view.unreadOnly || m.unread) && matches(m))
    .sort(byTime)
}

const unreadIn = (filter) => store.messages.filter((m) => m.folder === 'inbox' && m.unread && filter(m)).length

/** Unread messages across every inbox, for the rail. */
export const unreadCount = () => unreadIn(() => true)

function folderCount(id) {
  if (id === 'inbox') return unreadIn(() => true)
  if (id === 'pinned') return store.messages.filter((m) => inFolder(m, 'pinned')).length
  if (id === 'drafts') return store.messages.filter((m) => m.folder === 'drafts').length
  return 0
}

function formatTime(iso) {
  const d = new Date(iso)
  const now = new Date()
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000)
  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const selected = () => store.messages.find((m) => m.id === view.selectedId) ?? null
const fromAddresses = () => store.mailboxes.map((m) => m.address)

// ---------------------------------------------------------------------------------------------------------------
// Render

export function renderMail(container, context) {
  root = container
  ctx = context
  const list = visible()
  if (!list.some((m) => m.id === view.selectedId) && window.innerWidth > 680) view.selectedId = list[0]?.id ?? null
  const open = selected()

  root.innerHTML = `
    <section class="mail${open ? ' has-open' : ''}">
      <nav class="folders" aria-label="Mail folders">${foldersHtml()}</nav>
      <div class="list">${listHeadHtml()}<div class="list-scroll" id="rows">${rowsHtml(list)}</div></div>
      <div class="reader" id="reader">${readerHtml(open)}</div>
    </section>`
  bind()
  if (view.searching) root.querySelector('#search')?.focus()
  ctx.refreshRail?.()
}

function foldersHtml() {
  const scopeAll = !view.scope
  return `
    <div class="drag" style="padding-top:0"><button class="btn btn-primary btn-lg new-mail" data-act="compose">${icon('pencil', 15)}New mail</button></div>
    ${FOLDERS.map((f) => {
      const n = folderCount(f.id)
      return `<button class="folder" data-folder="${f.id}" ${view.folder === f.id && scopeAll ? 'aria-current="true"' : ''}>
        ${icon(f.icon, 15)}<span class="label">${f.label}</span>${n ? `<span class="count">${n}</span>` : ''}</button>`
    }).join('')}
    <div class="section-label"><span>Domains</span><button data-act="add-domain" aria-label="Add domain" title="Add domain">${icon('plus', 14)}</button></div>
    <button class="folder" data-act="all-inboxes" ${scopeAll && view.folder === 'inbox' ? 'aria-current="true"' : ''}>
      ${icon('layers', 15)}<span class="label">All inboxes</span>${unreadCount() ? `<span class="count">${unreadCount()}</span>` : ''}</button>
    ${store.domains.map(domainHtml).join('')}
    ${store.domains.length ? '' : `<div class="pending-note" style="padding-left:10px">No domains yet. <button data-act="add-domain">Add one</button></div>`}`
}

function domainHtml(d) {
  const verified = d.status === 'verified'
  const current = view.scope?.domainId === d.id
  const boxes = mailboxesOf(d.id)
  return `
    <button class="domain-row" data-domain="${d.id}" ${current ? 'aria-current="true"' : ''} title="${esc(d.name)}">
      <span class="badge">${esc(d.name[0].toUpperCase())}</span><span class="label ellipsis">${esc(d.name)}</span>
      <span class="state" title="${verified ? 'Verified' : 'DNS records pending'}">${icon(verified ? 'circle-check' : 'info', 13)}</span>
    </button>
    ${boxes
      .map((b) => {
        const n = unreadIn((m) => m.to === b.address)
        return `<button class="folder addr" data-address="${esc(b.address)}" ${view.scope?.address === b.address ? 'aria-current="true"' : ''}>
          <span class="label ellipsis">${esc(b.address.split('@')[0])}@</span>${n ? `<span class="count">${n}</span>` : ''}</button>`
      })
      .join('')}
    ${verified ? '' : `<div class="pending-note">DNS records pending. <button data-act="verify" data-id="${d.id}">Verify domain</button></div>`}`
}

function listTitle() {
  if (view.scope?.address) return { title: view.scope.address, sub: FOLDERS.find((f) => f.id === view.folder).label }
  if (view.scope?.domainId) {
    const d = store.domains.find((x) => x.id === view.scope.domainId)
    const n = mailboxesOf(d?.id).length
    return { title: d?.name ?? '', sub: `${n} ${n === 1 ? 'address' : 'addresses'}` }
  }
  const folder = FOLDERS.find((f) => f.id === view.folder)
  const n = store.domains.length
  return { title: folder.label, sub: `All inboxes · ${n} ${n === 1 ? 'domain' : 'domains'}` }
}

function listHeadHtml() {
  const { title, sub } = listTitle()
  return `
    <div class="col-head list-head drag">
      <div class="grow"><div class="title ellipsis">${esc(title)}</div><div class="sub ellipsis">${esc(sub)}</div></div>
      <div class="seg" role="group" aria-label="Filter">
        <button data-unread="0" aria-pressed="${!view.unreadOnly}">All</button>
        <button data-unread="1" aria-pressed="${view.unreadOnly}">Unread</button>
      </div>
    </div>
    <div class="list-search" ${view.searching ? '' : 'hidden'}>
      <input id="search" type="search" placeholder="Search mail" value="${esc(view.query)}" aria-label="Search mail" autocomplete="off">
    </div>`
}

function rowsHtml(list) {
  if (!list.length) {
    const searching = view.query.trim()
    const live = !isDemo() && !store.messages.length
    return `<div class="empty" style="height:100%">${icon(searching ? 'search' : 'inbox', 24)}
      <strong>${searching ? 'No matches' : live ? 'No mail yet' : 'Nothing here'}</strong>
      <span class="small">${
        searching
          ? `Nothing in ${esc(listTitle().title)} matches “${esc(searching)}”.`
          : live
            ? 'Mail sent to your addresses will show up here.'
            : view.unreadOnly
              ? 'You have read everything.'
              : 'No messages in this folder.'
      }</span></div>`
  }
  return list
    .map((m) => {
      const who = m.folder === 'sent' ? `To ${m.to}` : m.from.name || m.from.email
      return `
      <button class="row${m.unread ? ' is-unread' : ''}" data-id="${m.id}" aria-selected="${m.id === view.selectedId}">
        <div class="row-top"><span class="who ellipsis">${esc(who)}</span>
          <span class="meta">${m.pinned ? icon('pin', 12) : ''}${m.unread ? '<span class="dot" aria-label="Unread"></span>' : ''}${esc(formatTime(m.time))}</span></div>
        <div class="subject ellipsis">${esc(m.subject || '(no subject)')}</div>
        <div class="preview ellipsis">${esc(m.body.join(' '))}</div>
      </button>`
    })
    .join('')
}

function readerHtml(m) {
  if (!m) {
    return `<div class="col-head drag"></div><div class="empty">${icon('inbox', 28)}<strong>No message selected</strong></div>`
  }
  const reply = (view.replies[m.id] ??= { text: '', from: defaultFrom(m) })
  const assignee = m.assignee && assignees().find((a) => a.id === m.assignee)
  const archived = m.folder === 'archive'
  return `
    <div class="col-head reader-tools drag">
      <button class="ghost only-narrow" data-act="close" aria-label="Back to list" style="display:none">${icon('chevron-left', 16)}</button>
      <button class="btn-tool" data-act="pin" aria-pressed="${!!m.pinned}">${icon(m.pinned ? 'pin-off' : 'pin', 15)}${m.pinned ? 'Unpin' : 'Pin'}</button>
      <button class="btn-tool" data-act="archive">${icon(archived ? 'inbox' : 'archive', 15)}${archived ? 'Move to inbox' : 'Archive'}</button>
      <span style="flex:1"></span>
      <button class="btn" data-act="assign" aria-haspopup="menu">${icon('user-plus', 14)}${esc(assignee ? assignee.name : 'Assign')}</button>
    </div>
    <div class="reader-scroll">
      <article class="reader-body">
        <h1>${esc(m.subject || '(no subject)')}</h1>
        ${senderHtml(m.from, m.to, m.time)}
        <div class="message-text">${m.body.map((p) => `<p>${esc(p)}</p>`).join('')}</div>
        ${(m.thread ?? [])
          .map(
            (r) => `<div class="thread-reply">${senderHtml({ name: store.user?.name ?? r.from, email: r.from }, m.from.email, r.time)}
              <div class="message-text">${r.body.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('')}</div></div>`,
          )
          .join('')}
        ${m.draft ? draftHtml(m.draft) : ''}
      </article>
    </div>
    ${
      m.folder === 'sent'
        ? ''
        : `<div class="reply-wrap"><form class="reply" id="reply">
      <div class="reply-from">From
        <span class="select-chip">${esc(reply.from)}${icon('chevron-down', 12)}
          <select id="reply-from" aria-label="Send from">${fromAddresses()
            .map((a) => `<option ${a === reply.from ? 'selected' : ''}>${esc(a)}</option>`)
            .join('')}</select></span>
      </div>
      <textarea id="reply-text" rows="2" placeholder="Write a reply…" aria-label="Reply">${esc(reply.text)}</textarea>
      <div class="reply-foot">
        <button type="button" class="attach" aria-label="Attach a file" title="Attachments are coming soon" disabled>${icon('paperclip', 15)}</button>
        <button class="btn btn-primary" type="submit">Send</button>
      </div></form></div>`
    }`
}

function senderHtml(from, to, time) {
  return `
    <div class="sender">
      <span class="avatar lg">${esc(initials(from.name || from.email))}</span>
      <div class="who"><div class="ellipsis"><span class="from">${esc(from.name || from.email)}</span>
        ${from.name ? `<span class="email"> ${esc(from.email)}</span>` : ''}</div>
        <div class="to ellipsis">To ${esc(to)}</div></div>
      <span class="time">${esc(formatTime(time))}</span>
    </div>`
}

function draftHtml(draft) {
  return `
    <div class="draft">
      <div class="draft-head"><span class="by">${icon('sparkles', 14)}Drafted by ${esc(draft.agent)}</span><span class="from">From ${esc(draft.from)}</span></div>
      <p>${esc(draft.body)}</p>
      <div class="actions">
        <button class="btn btn-primary" data-act="send-draft">${icon('send', 14)}Send draft</button>
        <button class="btn" data-act="edit-draft">Edit</button>
      </div>
    </div>`
}

function defaultFrom(m) {
  const addresses = fromAddresses()
  return addresses.includes(m.to) ? m.to : (addresses[0] ?? '')
}

function assignees() {
  const me = store.user ? [{ id: 'me', name: store.user.name || store.user.email }] : []
  return [...me, ...store.members.filter((m) => !m.invited).map((m) => ({ id: m.id, name: m.name || m.email }))]
}

// ---------------------------------------------------------------------------------------------------------------
// Events

function bind() {
  const section = root.querySelector('.mail')
  section.addEventListener('click', onClick)

  const search = root.querySelector('#search')
  search?.addEventListener('input', () => {
    view.query = search.value
    root.querySelector('#rows').innerHTML = rowsHtml(visible())
  })
  search?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      view.searching = false
      view.query = ''
      renderMail(root, ctx)
    }
  })

  const text = root.querySelector('#reply-text')
  const m = selected()
  if (text && m) {
    text.addEventListener('input', () => {
      view.replies[m.id].text = text.value
      text.style.height = 'auto'
      text.style.height = `${Math.min(text.scrollHeight, 220)}px`
    })
    text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) root.querySelector('#reply').requestSubmit()
    })
    root.querySelector('#reply-from').addEventListener('change', (event) => {
      view.replies[m.id].from = event.target.value
      event.target.parentElement.firstChild.textContent = event.target.value
    })
    root.querySelector('#reply').addEventListener('submit', (event) => {
      event.preventDefault()
      const body = view.replies[m.id].text.trim()
      if (!body) return text.focus()
      sendReply(m, view.replies[m.id].from, body)
      view.replies[m.id].text = ''
      renderMail(root, ctx)
      toast('Reply sent')
    })
  }
  // The reader's back button only shows on narrow windows, where the list and reader take turns.
  const close = root.querySelector('[data-act="close"]')
  if (close && window.innerWidth <= 680) close.style.display = 'flex'
}

function onClick(event) {
  const el = event.target.closest('button')
  if (!el || el.disabled) return
  const m = selected()

  if (el.dataset.folder) {
    view.folder = el.dataset.folder
    view.scope = null
    view.selectedId = null
    return renderMail(root, ctx)
  }
  if (el.dataset.domain) {
    view.folder = 'inbox'
    view.scope = { domainId: el.dataset.domain }
    view.selectedId = null
    return renderMail(root, ctx)
  }
  if (el.dataset.address) {
    view.folder = 'inbox'
    view.scope = { address: el.dataset.address }
    view.selectedId = null
    return renderMail(root, ctx)
  }
  if (el.dataset.unread) {
    view.unreadOnly = el.dataset.unread === '1'
    view.selectedId = null
    return renderMail(root, ctx)
  }
  if (el.dataset.id) {
    view.selectedId = el.dataset.id
    store.messages.find((x) => x.id === el.dataset.id).unread = false
    return renderMail(root, ctx)
  }

  switch (el.dataset.act) {
    case 'compose':
      return openComposer()
    case 'all-inboxes':
      view.folder = 'inbox'
      view.scope = null
      view.selectedId = null
      return renderMail(root, ctx)
    case 'add-domain':
      return ctx.navigate('#/settings/domains')
    case 'verify':
      return ctx.navigate('#/settings/domains')
    case 'close':
      view.selectedId = null
      return renderMail(root, ctx)
    case 'pin':
      m.pinned = !m.pinned
      toast(m.pinned ? 'Pinned' : 'Unpinned')
      return renderMail(root, ctx)
    case 'archive':
      m.folder = m.folder === 'archive' ? 'inbox' : 'archive'
      toast(m.folder === 'archive' ? 'Archived' : 'Moved to inbox')
      view.selectedId = null
      return renderMail(root, ctx)
    case 'assign':
      return openAssignMenu(el, m)
    case 'send-draft':
      sendReply(m, m.draft.from, m.draft.body)
      m.draft = null
      toast('Draft sent')
      return renderMail(root, ctx)
    case 'edit-draft':
      view.replies[m.id] = { text: m.draft.body, from: fromAddresses().includes(m.draft.from) ? m.draft.from : defaultFrom(m) }
      m.draft = null
      renderMail(root, ctx)
      return root.querySelector('#reply-text')?.focus()
  }
}

function sendReply(m, from, body) {
  ;(m.thread ??= []).push({ from, body, time: new Date().toISOString() })
  m.unread = false
}

function openAssignMenu(button, m) {
  closeMenus()
  const menu = document.createElement('div')
  menu.className = 'menu'
  menu.setAttribute('role', 'menu')
  const people = assignees()
  menu.innerHTML =
    people
      .map(
        (p) => `<button role="menuitem" data-who="${p.id}"><span class="avatar md">${esc(initials(p.name))}</span>
          <span class="ellipsis">${esc(p.name)}${p.id === 'me' ? ' <span class="muted">(you)</span>' : ''}</span>
          ${m.assignee === p.id ? `<span class="check">${icon('check', 14)}</span>` : ''}</button>`,
      )
      .join('') + (m.assignee ? `<button role="menuitem" data-who="">${icon('x', 14)}Unassign</button>` : '')
  document.body.append(menu)
  const r = button.getBoundingClientRect()
  menu.style.top = `${r.bottom + 6}px`
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`
  menu.querySelector('button')?.focus()
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-who]')
    if (!item) return
    m.assignee = item.dataset.who || null
    closeMenus()
    toast(m.assignee ? `Assigned to ${people.find((p) => p.id === m.assignee).name}` : 'Unassigned')
    renderMail(root, ctx)
  })
  setTimeout(() => document.addEventListener('click', closeMenus, { once: true }))
}

function closeMenus() {
  document.querySelectorAll('.menu').forEach((el) => el.remove())
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenus()
})

// ---------------------------------------------------------------------------------------------------------------
// Composer

function openComposer() {
  const addresses = fromAddresses()
  const scrim = document.createElement('div')
  scrim.className = 'scrim'
  scrim.innerHTML = `
    <form class="modal" role="dialog" aria-modal="true" aria-labelledby="compose-title" novalidate>
      <div class="modal-head"><span id="compose-title">New mail</span><button type="button" class="x-btn" data-close aria-label="Close">${icon('x', 16)}</button></div>
      <div class="modal-row"><label for="c-from">From</label>
        <select id="c-from">${addresses.map((a) => `<option>${esc(a)}</option>`).join('') || '<option value="">Add an address in Settings first</option>'}</select></div>
      <div class="modal-row"><label for="c-to">To</label><input id="c-to" type="email" placeholder="name@example.com" autocomplete="off"></div>
      <div class="modal-row"><label for="c-subject">Subject</label><input id="c-subject" autocomplete="off"></div>
      <textarea id="c-body" placeholder="Write your message…" aria-label="Message"></textarea>
      <div class="modal-foot">
        <button type="button" class="btn" disabled title="Agents can draft for you once the Agents page ships">${icon('sparkles', 14)}Draft with agent</button>
        <span class="err" id="c-err" role="alert"></span>
        <button class="btn btn-primary" type="submit">${icon('send', 14)}Send</button>
      </div>
    </form>`
  document.body.append(scrim)
  const form = scrim.querySelector('form')
  const $ = (s) => form.querySelector(s)
  $('#c-to').focus()

  const close = () => {
    scrim.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (event) => {
    if (event.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  scrim.addEventListener('mousedown', (event) => {
    if (event.target === scrim) close()
  })
  $('[data-close]').addEventListener('click', close)

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const to = $('#c-to').value.trim()
    const err = $('#c-err')
    if (!$('#c-from').value) return (err.textContent = 'Add an address first.')
    if (!isEmail(to)) {
      err.textContent = 'Enter a valid email address.'
      return $('#c-to').focus()
    }
    if (!isDemo()) {
      // No send endpoint yet. Say so rather than pretend.
      err.textContent = "Sending from xstate isn't available yet."
      return
    }
    store.messages.push({
      id: `msg_${Date.now()}`,
      from: { name: store.user.name, email: $('#c-from').value },
      to,
      subject: $('#c-subject').value.trim(),
      body: ($('#c-body').value.trim() || ' ').split(/\n{2,}/),
      time: new Date().toISOString(),
      folder: 'sent',
    })
    close()
    toast('Sent')
    renderMail(root, ctx)
  })
}

window.addEventListener('xstate:compose', () => openComposer())
window.addEventListener('xstate:search', () => {
  view.searching = true
  if (root?.isConnected && root.querySelector('.mail')) renderMail(root, ctx)
})
