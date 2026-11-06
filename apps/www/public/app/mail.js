// Email: folders and domains, the message list, and the reader. Mail comes from mail-data.js: the email_* API when
// signed in, sample data in demo mode. Reading, pinning, archiving and attachments work in both; sending is
// demo-only until the API has email_send.

import { desktop, esc, initials, isEmail, toast } from './core.js'
import { icon } from './icons.js'
import { source } from './mail-data.js'
import { store } from './store.js'

const FOLDERS = [
  { id: 'inbox', label: 'Inbox', icon: 'inbox' },
  { id: 'pinned', label: 'Pinned', icon: 'pin' },
  { id: 'sent', label: 'Sent', icon: 'send' },
  { id: 'drafts', label: 'Drafts', icon: 'file-pen' },
  { id: 'archive', label: 'Archive', icon: 'archive' },
  { id: 'junk', label: 'Spam', icon: 'shield-alert' },
]
const POLL_MS = 30_000

/** What the Email page shows. Kept across page switches. */
const view = {
  folder: 'inbox',
  /** null for all inboxes, or { domainId } or { mailboxId }. */
  scope: null,
  unreadOnly: false,
  query: '',
  searching: false,
  /** Mail folders per mailbox the user can read, from the source. */
  mailboxes: [],
  list: [],
  nextCursor: null,
  loading: false,
  loadingMore: false,
  error: null,
  selectedId: null,
  /** The open conversation: { id, messages, loading, error, showImages, expanded, quotes } (sets of message indexes). */
  thread: null,
  /** Reply text and From per message id, so re-rendering doesn't lose what was typed. */
  replies: {},
  state: null,
  loaded: false,
}

let root = null
let ctx = null
let listToken = 0
let pollTimer = null

// ---------------------------------------------------------------------------------------------------------------
// Data

const data = () => source()
/** Message ids are only unique within one mailbox (JMAP account), so the list keys messages by both. */
const keyOf = (m) => `${m.mailboxId}/${m.id}`
const selectedSummary = () => view.list.find((m) => keyOf(m) === view.selectedId)
const domainName = (address) => address.split('@')[1] ?? ''

/** Unread messages across every inbox, for the rail. */
export function unreadCount() {
  return view.mailboxes.reduce((n, mb) => n + (mb.folders.find((f) => f.role === 'inbox')?.unread ?? 0), 0)
}

function folderCount(id) {
  const sum = (role, key) => view.mailboxes.reduce((n, mb) => n + (mb.folders.find((f) => f.role === role)?.[key] ?? 0), 0)
  if (id === 'inbox') return sum('inbox', 'unread')
  if (id === 'drafts') return sum('drafts', 'total')
  return 0
}

/** Mailboxes in the current scope, or undefined for all. */
function scopeMailboxIds() {
  if (!view.scope) return undefined
  if (view.scope.mailboxId) return [view.scope.mailboxId]
  const domain = store.domains.find((d) => d.id === view.scope.domainId)
  return view.mailboxes.filter((mb) => domainName(mb.address) === domain?.name).map((mb) => mb.mailboxId)
}

async function loadFolders() {
  view.mailboxes = await data().folders()
}

function listQuery(cursor) {
  const ids = scopeMailboxIds()
  return {
    ids,
    query: {
      folder: view.folder,
      mailboxId: ids?.length === 1 ? ids[0] : undefined,
      unreadOnly: view.unreadOnly,
      query: view.query,
      cursor,
    },
  }
}

/** Loads the first page of the current view. */
async function loadList() {
  const token = ++listToken
  view.loading = true
  view.error = null
  renderRows()
  try {
    const { ids, query } = listQuery()
    // A domain with no readable mailboxes has nothing to show; the API takes one mailbox or all of them.
    const result = ids && !ids.length ? { messages: [], nextCursor: null } : await data().list(query)
    if (token !== listToken) return
    view.list = ids ? result.messages.filter((m) => ids.includes(m.mailboxId)) : result.messages
    view.nextCursor = result.nextCursor
    if (!view.list.some((m) => keyOf(m) === view.selectedId)) {
      view.selectedId = window.innerWidth > 680 && view.list[0] ? keyOf(view.list[0]) : null
      view.thread = null
    }
  } catch (err) {
    if (token !== listToken) return
    view.error = err.message
    view.list = []
  }
  view.loading = false
  render()
  if (view.selectedId && view.thread?.id !== view.selectedId) openThread(view.selectedId, { markRead: false })
}

async function loadMore() {
  if (!view.nextCursor || view.loadingMore) return
  view.loadingMore = true
  const token = listToken
  try {
    const { ids, query } = listQuery(view.nextCursor)
    const result = await data().list(query)
    if (token !== listToken) return
    const more = ids ? result.messages.filter((m) => ids.includes(m.mailboxId)) : result.messages
    // A long conversation can come back on a later page by an older message; keep the row we already have.
    view.list.push(...more.filter((m) => !view.list.some((x) => x.mailboxId === m.mailboxId && x.threadId === m.threadId)))
    view.nextCursor = result.nextCursor
  } catch (err) {
    toast(err.message)
  } finally {
    view.loadingMore = false
  }
  renderRows()
}

async function openThread(id, { markRead = true } = {}) {
  const summary = view.list.find((m) => keyOf(m) === id)
  if (!summary) return
  view.thread = { id, messages: [], loading: true, error: null, showImages: false, expanded: new Set(), quotes: new Set() }
  renderReader()
  try {
    const messages = await data().thread(summary)
    if (view.thread?.id !== id) return
    view.thread.messages = messages
    view.thread.expanded = initialExpanded(messages)
  } catch (err) {
    if (view.thread?.id !== id) return
    view.thread.error = err.message
  }
  view.thread.loading = false
  renderReader()
  if (markRead && !summary.seen) setSeen(summary, true)
}

async function setSeen(summary, seen) {
  summary.seen = seen
  adjustUnread(summary, seen ? -1 : 1)
  renderRows()
  renderReader()
  try {
    await data().update(summary, { seen })
    // The whole conversation changed, which may be more than one unread message; take the counts from the server.
    if (summary.threadSize > 1) loadFolders().then(() => (renderFolders(), ctx.refreshRail?.()))
  } catch (err) {
    summary.seen = !seen
    adjustUnread(summary, seen ? 1 : -1)
    renderRows()
    toast(err.message)
  }
}

function adjustUnread(summary, delta) {
  if (summary.folder !== 'inbox') return
  const inbox = view.mailboxes.find((mb) => mb.mailboxId === summary.mailboxId)?.folders.find((f) => f.role === 'inbox')
  if (inbox) inbox.unread = Math.max(0, inbox.unread + delta)
  renderFolders()
  ctx.refreshRail?.()
}

/** Reloads when the mail state token changes (new mail, or changes made in another app). */
async function poll() {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(poll, POLL_MS)
  if (document.visibilityState !== 'visible') return
  try {
    const state = await data().state()
    if (view.state && state !== view.state) {
      const before = unreadCount()
      await loadFolders()
      ctx.refreshRail?.()
      if (root?.isConnected && root.querySelector('.mail')) await loadList()
      const after = unreadCount()
      if (after > before) notifyNewMail(after - before)
    }
    view.state = state
  } catch {
    // Offline or signed out: try again next time.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && view.loaded) poll()
})

async function notifyNewMail(count) {
  if (!desktop || !('Notification' in window)) return
  const settings = await desktop.getSettings().catch(() => ({}))
  if (!settings.notifications || document.hasFocus()) return
  new Notification('xstate', { body: count === 1 ? 'You have a new message.' : `You have ${count} new messages.` })
}

// ---------------------------------------------------------------------------------------------------------------
// Render

export function renderMail(container, context) {
  root = container
  ctx = context
  root.innerHTML = `
    <section class="mail">
      <nav class="folders" aria-label="Mail folders" id="folders"></nav>
      <div class="list" id="list"></div>
      <div class="reader" id="reader"></div>
    </section>`
  root.querySelector('.mail').addEventListener('click', onClick)
  render()
  if (!view.loaded) {
    view.loaded = true
    start()
  }
}

/** Loads folder counts and starts watching for new mail before the Email page is opened (for the rail badge). */
export function prefetchMail(context) {
  ctx ??= context
  if (view.loaded) return
  view.loaded = true
  start()
}

async function start() {
  view.loading = true
  render()
  try {
    await loadFolders()
    view.state = await data().state().catch(() => null)
  } catch (err) {
    view.error = err.message
  }
  ctx.refreshRail?.()
  await loadList()
  pollTimer = setTimeout(poll, POLL_MS)
}

function render() {
  if (!root?.isConnected) return
  renderFolders()
  renderList()
  renderReader()
}

function renderFolders() {
  const el = root?.querySelector('#folders')
  if (!el) return
  const all = !view.scope
  el.innerHTML = `
    <div class="drag"><button class="btn btn-primary btn-lg new-mail" data-act="compose">${icon('pencil', 15)}New mail</button></div>
    ${FOLDERS.map((f) => {
      const n = folderCount(f.id)
      return `<button class="folder" data-folder="${f.id}" ${view.folder === f.id && all ? 'aria-current="true"' : ''}>
        ${icon(f.icon, 15)}<span class="label">${f.label}</span>${n ? `<span class="count">${n}</span>` : ''}</button>`
    }).join('')}
    <div class="section-label"><span>Domains</span><button data-act="add-domain" aria-label="Add domain" title="Add domain">${icon('plus', 14)}</button></div>
    <button class="folder" data-act="all-inboxes" ${all && view.folder === 'inbox' ? 'aria-current="true"' : ''}>
      ${icon('layers', 15)}<span class="label">All inboxes</span>${unreadCount() ? `<span class="count">${unreadCount()}</span>` : ''}</button>
    ${store.domains.map(domainHtml).join('')}
    ${store.domains.length ? '' : `<div class="pending-note" style="padding-left:10px">No domains yet. <button data-act="add-domain">Add one</button></div>`}`
}

function domainHtml(d) {
  const verified = d.status === 'verified'
  const boxes = view.mailboxes.filter((mb) => domainName(mb.address) === d.name)
  return `
    <button class="domain-row" data-domain="${d.id}" ${view.scope?.domainId === d.id ? 'aria-current="true"' : ''} title="${esc(d.name)}">
      <span class="badge">${esc(d.name[0].toUpperCase())}</span><span class="label ellipsis">${esc(d.name)}</span>
      <span class="state" title="${verified ? 'Verified' : 'DNS records pending'}">${icon(verified ? 'circle-check' : 'info', 13)}</span>
    </button>
    ${boxes
      .map((mb) => {
        const n = mb.folders.find((f) => f.role === 'inbox')?.unread ?? 0
        return `<button class="folder addr" data-mailbox="${mb.mailboxId}" ${view.scope?.mailboxId === mb.mailboxId ? 'aria-current="true"' : ''} title="${esc(mb.address)}">
          <span class="label ellipsis">${esc(mb.address.split('@')[0])}@</span>${n ? `<span class="count">${n}</span>` : ''}</button>`
      })
      .join('')}
    ${verified ? '' : `<div class="pending-note">DNS records pending. <button data-act="verify">Verify domain</button></div>`}`
}

function listTitle() {
  const folder = FOLDERS.find((f) => f.id === view.folder).label
  if (view.scope?.mailboxId) return { title: view.mailboxes.find((mb) => mb.mailboxId === view.scope.mailboxId)?.address ?? '', sub: folder }
  if (view.scope?.domainId) {
    const d = store.domains.find((x) => x.id === view.scope.domainId)
    const n = scopeMailboxIds().length
    return { title: d?.name ?? '', sub: `${folder} · ${n} ${n === 1 ? 'address' : 'addresses'}` }
  }
  const n = store.domains.length
  return { title: folder, sub: `All inboxes · ${n} ${n === 1 ? 'domain' : 'domains'}` }
}

function renderList() {
  const el = root?.querySelector('#list')
  if (!el) return
  const { title, sub } = listTitle()
  el.innerHTML = `
    <div class="col-head list-head drag">
      <div class="grow"><div class="title ellipsis">${esc(title)}</div><div class="sub ellipsis">${esc(sub)}</div></div>
      <div class="seg" role="group" aria-label="Filter">
        <button data-unread="0" aria-pressed="${!view.unreadOnly}">All</button>
        <button data-unread="1" aria-pressed="${view.unreadOnly}">Unread</button>
      </div>
    </div>
    <div class="list-search" ${view.searching ? '' : 'hidden'}>
      <input id="search" type="search" placeholder="Search mail" value="${esc(view.query)}" aria-label="Search mail" autocomplete="off">
    </div>
    <div class="list-scroll" id="rows"></div>`
  renderRows()
  const search = el.querySelector('#search')
  let debounce
  search.addEventListener('input', () => {
    view.query = search.value
    clearTimeout(debounce)
    debounce = setTimeout(loadList, 300)
  })
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    view.searching = false
    view.query = ''
    renderList()
    loadList()
  })
  if (view.searching) search.focus()
  el.querySelector('#rows').addEventListener('scroll', (event) => {
    const r = event.target
    if (r.scrollTop + r.clientHeight > r.scrollHeight - 200) loadMore()
  })
}

function renderRows() {
  const el = root?.querySelector('#rows')
  if (!el) return
  root.querySelector('.mail')?.classList.toggle('has-open', !!view.selectedId)
  if (view.loading && !view.list.length) {
    el.innerHTML = `<div class="empty" style="height:100%"><span class="spinner"></span></div>`
    return
  }
  if (view.error) {
    el.innerHTML = `<div class="empty" style="height:100%">${icon('circle-alert', 24)}<strong>Couldn't load mail</strong>
      <span class="small">${esc(view.error)}</span><button class="btn" data-act="retry">Try again</button></div>`
    return
  }
  if (!view.list.length) {
    const q = view.query.trim()
    const none = !view.mailboxes.length
    el.innerHTML = `<div class="empty" style="height:100%">${icon(q ? 'search' : 'inbox', 24)}
      <strong>${q ? 'No matches' : none ? 'No mailboxes yet' : 'Nothing here'}</strong>
      <span class="small">${
        q
          ? `Nothing in ${esc(listTitle().title)} matches “${esc(q)}”.`
          : none
            ? 'Add an address in Settings › Domains to start getting mail.'
            : view.unreadOnly
              ? 'You have read everything.'
              : view.folder === 'inbox'
                ? 'Mail sent to your addresses will show up here.'
                : 'No messages in this folder.'
      }</span></div>`
    return
  }
  el.innerHTML =
    view.list
      .map((m) => {
        const who = m.folder === 'sent' ? `To ${m.to.map((a) => a.name || a.email).join(', ')}` : sender(m.from)
        return `
      <button class="row${m.seen ? '' : ' is-unread'}" data-id="${esc(keyOf(m))}" aria-selected="${keyOf(m) === view.selectedId}">
        <div class="row-top"><span class="who ellipsis">${esc(who)}</span>${m.threadSize > 1 ? `<span class="thread-count">${m.threadSize}</span>` : ''}
          <span class="meta">${m.hasAttachment ? icon('paperclip', 12) : ''}${m.pinned ? icon('pin', 12) : ''}${m.seen ? '' : '<span class="dot" aria-label="Unread"></span>'}${esc(formatTime(m.receivedAt))}</span></div>
        <div class="subject ellipsis">${esc(m.subject || '(no subject)')}</div>
        <div class="preview ellipsis">${esc(m.preview)}</div>
      </button>`
      })
      .join('') + (view.nextCursor ? `<div class="empty small" style="padding:14px">${view.loadingMore ? '<span class="spinner"></span>' : ''}</div>` : '')
}

function renderReader() {
  const el = root?.querySelector('#reader')
  if (!el) return
  root.querySelector('.mail')?.classList.toggle('has-open', !!view.selectedId)
  const summary = selectedSummary()
  if (!summary) {
    el.innerHTML = `<div class="col-head drag"></div><div class="empty">${icon('inbox', 28)}<strong>No message selected</strong></div>`
    return
  }
  const t = view.thread?.id === keyOf(summary) ? view.thread : null
  const archived = summary.folder === 'archive'
  const latest = t?.messages[t.messages.length - 1]
  el.innerHTML = `
    <div class="col-head reader-tools drag">
      <button class="ghost" data-act="close" aria-label="Back to list" style="display:${window.innerWidth <= 680 ? 'flex' : 'none'}">${icon('chevron-left', 16)}</button>
      <button class="btn-tool" data-act="pin" aria-pressed="${summary.pinned}">${icon(summary.pinned ? 'pin-off' : 'pin', 15)}${summary.pinned ? 'Unpin' : 'Pin'}</button>
      <button class="btn-tool" data-act="archive">${icon(archived ? 'inbox' : 'archive', 15)}${archived ? 'Move to inbox' : 'Archive'}</button>
      <button class="btn-tool" data-act="unread">${icon('circle', 15)}${summary.seen ? 'Mark unread' : 'Mark read'}</button>
      <span style="flex:1"></span>
      ${data().canSend && t && !t.loading && !t.error ? `<button class="btn-tool" data-act="forward-mail">${icon('forward', 15)}Forward</button>` : ''}
    </div>
    <div class="reader-scroll">
      <article class="reader-body">
        <h1>${esc(summary.subject || '(no subject)')}</h1>
        ${
          !t || t.loading
            ? `<div class="empty"><span class="spinner"></span></div>`
            : t.error
              ? `<div class="empty">${icon('circle-alert', 22)}<strong>Couldn't open this conversation</strong><span class="small">${esc(t.error)}</span></div>`
              : t.messages.map((m, i) => messageHtml(m, i, t)).join('')
        }
        ${latest?.draft ? draftHtml(latest.draft) : ''}
      </article>
    </div>
    ${summary.folder === 'sent' || !t || t.loading || t.error ? '' : replyHtml(summary)}`
  bindReader(el, summary, t)
}

function sender(list) {
  const a = list[0]
  return a ? a.name || a.email : '(no sender)'
}

/** A stable colour per sender, so a conversation is easy to follow at a glance. */
function avatarStyle(email) {
  let h = 0
  for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360
  return `background:hsl(${h} 45% 42%);border-color:transparent;color:#fff`
}

/** Which messages of a conversation start open: the newest, and any not read yet. */
function initialExpanded(messages) {
  return new Set(messages.flatMap((m, i) => (i === messages.length - 1 || !m.seen ? [i] : [])))
}

const ATTRIBUTION = /^\s*On\b.*\bwrote:\s*$/i
const ATTRIBUTION_START = /^\s*On\b.{6,}/
const OUTLOOK_HEADER = /^\s*(-{2,}\s*Original Message\s*-{2,}|_{20,})\s*$/i

/**
 * Splits a plain-text body into what was written and the quoted history under it ("On … wrote:" and "> " lines,
 * or an Outlook "Original Message" block). Returns quote: '' when there is none, or nothing would be left.
 */
export function splitQuote(text) {
  const lines = text.split('\n')
  const quoted = (from) => lines.slice(from).every((l) => !l.trim() || /^\s*>/.test(l))
  let cut = -1
  for (let i = 0; i < lines.length && cut < 0; i++) {
    const line = lines[i]
    if (ATTRIBUTION.test(line) || OUTLOOK_HEADER.test(line)) cut = i
    // Long attributions wrap: "On Tue, … Name <a@b.c>" then "wrote:" on the next line.
    else if (ATTRIBUTION_START.test(line) && /^\s*\S*.*wrote:\s*$/i.test(lines[i + 1] ?? '') && !/^\s*>/.test(line)) cut = i
    else if (/^\s*From:\s/.test(line) && /^\s*(Sent|Date):\s/.test(lines[i + 1] ?? '')) cut = i
    else if (/^\s*>/.test(line) && quoted(i)) cut = i
  }
  if (cut <= 0) return { body: text, quote: '' }
  const body = lines.slice(0, cut).join('\n').trimEnd()
  return body.trim() ? { body, quote: lines.slice(cut).join('\n').trim() } : { body: text, quote: '' }
}

function messageHtml(m, index, t) {
  const from = m.from[0] ?? { name: null, email: '' }
  const files = m.attachments.filter((a) => !a.inline)
  const remote = !!m.html && /\bsrc\s*=\s*["']?https?:/i.test(m.html)
  const last = index === t.messages.length - 1
  const open = t.expanded.has(index)
  const to = [...m.to, ...m.cc].map((a) => a.name || a.email).join(', ')
  const head = `
      <span class="avatar lg" style="${avatarStyle(from.email)}">${esc(initials(from.name || from.email))}</span>
      <div class="who"><div class="ellipsis"><span class="from">${esc(from.name || from.email)}</span>
        ${open && from.name ? `<span class="email"> ${esc(from.email)}</span>` : ''}</div>
        <div class="to ellipsis">${open ? `to ${esc(to)}` : esc(m.preview)}</div></div>
      <span class="time">${files.length ? icon('paperclip', 12) : ''}${esc(formatTime(m.receivedAt))}</span>`
  if (!open) {
    return `<div class="message is-collapsed"><button class="sender" data-act="toggle-msg" data-index="${index}"
      title="${esc(from.email)}">${head}</button></div>`
  }
  const text = m.html ? null : splitQuote(m.text)
  const quoteOpen = t.quotes.has(index)
  return `
    <div class="message">
      ${last ? `<div class="sender" title="${esc(from.email)}">${head}</div>` : `<button class="sender" data-act="toggle-msg" data-index="${index}" title="${esc(from.email)}">${head}</button>`}
      ${
        m.html
          ? `${remote && !t.showImages ? `<div class="images-note">${icon('info', 14)}<span>Remote images are hidden to protect your privacy.</span><button data-act="show-images">Show images</button></div>` : ''}
             <iframe class="mail-html" data-index="${index}" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Message"></iframe>
             <button class="quote-toggle" data-act="toggle-quote" data-index="${index}" aria-expanded="${quoteOpen}" title="Show quoted text" hidden>•••</button>`
          : `<div class="message-text">${paragraphs(text.body)}</div>
             ${
               text.quote
                 ? `<button class="quote-toggle" data-act="toggle-quote" data-index="${index}" aria-expanded="${quoteOpen}" title="${quoteOpen ? 'Hide' : 'Show'} quoted text">•••</button>
                    ${quoteOpen ? `<div class="message-text quoted">${paragraphs(text.quote.replace(/^\s*> ?/gm, ''))}</div>` : ''}`
                 : ''
             }`
      }
      ${
        files.length
          ? `<div class="attachments">${files
              .map(
                (a, j) => `<button class="attachment" data-download="${index}:${j}" title="Download ${esc(a.name)}">
                  ${icon('paperclip', 14)}<span class="ellipsis">${esc(a.name)}</span><span class="muted small">${esc(formatSize(a.size))}</span>${icon('download', 14)}</button>`,
              )
              .join('')}</div>`
          : ''
      }
    </div>`
}

const paragraphs = (text) => text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('')

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

const fromAddresses = () => view.mailboxes.map((mb) => mb.address)
const addressOf = (mailboxId) => view.mailboxes.find((mb) => mb.mailboxId === mailboxId)?.address ?? ''
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** Splits "a@x.com, b@y.com" into addresses; returns the invalid ones separately. */
function parseRecipients(value) {
  const all = value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
  return { valid: all.filter(isEmail), invalid: all.filter((a) => !isEmail(a)) }
}

/**
 * Who a reply goes to: the latest message's Reply-To or sender. If the latest message is one we sent, reply to
 * its recipients instead.
 */
function replyTarget(latest, ownAddress) {
  if (!latest) return []
  const fromSelf = latest.from[0]?.email?.toLowerCase() === ownAddress.toLowerCase()
  const list = fromSelf ? latest.to : latest.replyTo?.length ? latest.replyTo : latest.from
  return list.map((a) => a.email)
}

/** Attachment chips with upload state. `files`: [{ id, name, size, status: 'uploading'|'ready'|'error', attachment }] */
function filesHtml(files) {
  if (!files.length) return ''
  return `<div class="attachments files">${files
    .map(
      (f) => `<span class="attachment${f.status === 'error' ? ' is-error' : ''}" data-file="${f.id}" title="${esc(f.error ?? f.name)}">
        ${f.status === 'uploading' ? '<span class="spinner"></span>' : icon(f.status === 'error' ? 'circle-alert' : 'paperclip', 14)}
        <span class="ellipsis">${esc(f.name)}</span><span class="muted small">${esc(formatSize(f.size))}</span>
        <button type="button" class="x-btn" data-remove-file="${f.id}" aria-label="Remove ${esc(f.name)}">${icon('x', 12)}</button></span>`,
    )
    .join('')}</div>`
}

/** Uploads picked files for a message from `mailboxId`, updating `files` and calling `onChange` as they finish. */
function addFiles(mailboxId, fileList, files, onChange) {
  for (const file of fileList) {
    const entry = { id: `f${Date.now()}${Math.random().toString(36).slice(2, 6)}`, name: file.name, size: file.size, status: 'uploading' }
    files.push(entry)
    if (file.size > MAX_ATTACHMENT_BYTES) {
      Object.assign(entry, { status: 'error', error: 'Larger than 25 MB' })
      continue
    }
    data()
      .upload(mailboxId, file)
      .then((attachment) => Object.assign(entry, { status: 'ready', attachment }))
      .catch((err) => Object.assign(entry, { status: 'error', error: err.message }))
      .finally(onChange)
  }
  onChange()
}

function readyAttachments(files) {
  if (files.some((f) => f.status === 'uploading')) return { error: 'Wait for attachments to finish uploading.' }
  if (files.some((f) => f.status === 'error')) return { error: 'Remove the attachments that failed to upload.' }
  return { attachments: files.map((f) => f.attachment) }
}

function replyHtml(summary) {
  const reply = (view.replies[keyOf(summary)] ??= { text: '', files: [], sending: false, error: '' })
  const canSend = data().canSend
  return `<div class="reply-wrap"><form class="reply" id="reply">
    <div class="reply-from">From <span class="select-chip">${esc(addressOf(summary.mailboxId))}</span></div>
    <textarea id="reply-text" rows="2" placeholder="${canSend ? 'Write a reply…' : 'Replying from xstate is coming soon'}" aria-label="Reply" ${canSend ? '' : 'disabled'}>${esc(reply.text)}</textarea>
    <div id="reply-files">${filesHtml(reply.files)}</div>
    <div class="reply-foot">
      <label class="attach" title="Attach files" ${canSend ? '' : 'hidden'}>${icon('paperclip', 15)}<input type="file" id="reply-attach" multiple hidden></label>
      <span class="reply-err" id="reply-err" role="alert">${esc(reply.error)}</span>
      <button class="btn btn-primary" type="submit" ${canSend && !reply.sending ? '' : 'disabled'}>${reply.sending ? '<span class="spinner"></span>' : ''}Send</button>
    </div></form></div>`
}

/** Where mail apps put the quoted history in an HTML reply (Spark, Apple Mail, Gmail, Outlook, Thunderbird, Yahoo). */
const HTML_QUOTE = [
  '[name="messageReplySection"]',
  '.gmail_quote',
  '#appendonsend',
  '[id^="divRplyFwdMsg"]',
  '.moz-cite-prefix',
  '.yahoo_quoted',
  'blockquote[type="cite"]',
].join(',')

/** Simple mail (no layout colours or tables) reads better in the app's own colours than in a white box. */
const isPlainHtml = (html) => !/<table|bgcolor\s*=|background(-color|-image)?\s*:|<img/i.test(html)

/**
 * Marks the quoted history in an HTML body (and the "On … wrote:" line above it) so it can be hidden. Returns
 * false when there is none, or hiding it would leave nothing to read.
 */
function markQuote(doc) {
  const quote = doc.body.querySelector(HTML_QUOTE)
  if (!quote) return false
  const marked = [quote]
  for (let n = quote.nextSibling; n; n = n.nextSibling) marked.push(n)
  let prev = quote.previousSibling
  while (prev && ((prev.nodeType === 3 && !prev.textContent.trim()) || prev.nodeName === 'BR')) prev = prev.previousSibling
  if (prev && /wrote:\s*$/i.test(prev.textContent ?? '')) marked.push(prev)
  const wrap = (n) => {
    if (n.nodeType === 1) return n
    const span = doc.createElement('span')
    n.replaceWith(span)
    span.append(n)
    return span
  }
  const els = marked.map(wrap)
  els.forEach((el) => el.setAttribute('data-xq', ''))
  doc.body.classList.add('xq-hide')
  if (!doc.body.innerText.trim()) {
    doc.body.classList.remove('xq-hide')
    return false
  }
  return true
}

function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// Simple HTML mail is drawn in the theme's colours, so redraw the open conversation when the theme changes.
new MutationObserver(() => {
  if (view.thread && !view.thread.loading && root?.isConnected) renderReader()
}).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

/** Writes each HTML body into its sandboxed iframe. No scripts run; remote images load only after "Show images". */
async function fillFrames(el, t) {
  for (const frame of el.querySelectorAll('iframe.mail-html')) {
    const index = Number(frame.dataset.index)
    const m = t.messages[index]
    const html = await withInlineImages(m)
    const images = t.showImages ? 'https: http: data: blob:' : 'data: blob:'
    const plain = isPlainHtml(m.html)
    frame.classList.toggle('is-plain', plain)
    const base = plain
      ? `:root{color-scheme:${themeColor('color-scheme') || 'light'}}
         html,body{background:transparent;color:${themeColor('--text-hi')}}body{padding:0}
         body *{color:inherit!important;background-color:transparent!important;font-family:inherit!important}
         a{color:${themeColor('--text-hi')}!important;text-decoration:underline}
         blockquote{margin:6px 0;padding-left:12px;border-left:2px solid ${themeColor('--border-strong')};opacity:.8}`
      : `html,body{background:#fff;color:#18181b}body{padding:16px}a{color:#2563eb}`
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument
      if (!doc?.body) return
      const toggle = frame.parentElement.querySelector('.quote-toggle')
      if (markQuote(doc) && toggle) {
        toggle.hidden = false
        doc.body.classList.toggle('xq-hide', !t.quotes.has(index))
      }
      frame.style.height = `${doc.body.scrollHeight}px`
    })
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:">
      <base target="_blank">
      <style>html,body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
      ${base}img{max-width:100%;height:auto}table{max-width:100%}
      body.xq-hide [data-xq]{display:none!important}
      ${t.showImages ? '' : 'img[src^="http:"],img[src^="https:"]{display:none}'}</style></head>
      <body>${html}</body></html>`
  }
}

/** Shows or hides the quoted history of one message, in place for HTML so the frame isn't reloaded. */
function toggleQuote(button) {
  const index = Number(button.dataset.index)
  const t = view.thread
  if (t.quotes.has(index)) t.quotes.delete(index)
  else t.quotes.add(index)
  const frame = button.parentElement.querySelector('iframe.mail-html')
  const doc = frame?.contentDocument
  if (!doc?.body) return renderReader()
  doc.body.classList.toggle('xq-hide', !t.quotes.has(index))
  button.setAttribute('aria-expanded', String(t.quotes.has(index)))
  frame.style.height = '0px'
  frame.style.height = `${doc.body.scrollHeight}px`
}

/** Replaces cid: references with blob URLs of the message's inline attachments. */
async function withInlineImages(m) {
  let html = m.html
  for (const a of m.attachments.filter((x) => x.cid && html.includes(`cid:${x.cid}`))) {
    try {
      const url = URL.createObjectURL(await data().attachment(m, a))
      html = html.split(`cid:${a.cid}`).join(url)
    } catch {
      // Leave that image broken; the rest of the message still shows.
    }
  }
  return html
}

function bindReader(el, summary, t) {
  if (t && !t.loading && !t.error) fillFrames(el, t)
  const form = el.querySelector('#reply')
  if (!form) return
  const text = form.querySelector('#reply-text')
  const reply = view.replies[keyOf(summary)]
  const filesEl = form.querySelector('#reply-files')
  const refreshFiles = () => (filesEl.innerHTML = filesHtml(reply.files))
  text.addEventListener('input', () => {
    reply.text = text.value
    text.style.height = 'auto'
    text.style.height = `${Math.min(text.scrollHeight, 220)}px`
  })
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) form.requestSubmit()
  })
  form.querySelector('#reply-attach')?.addEventListener('change', (event) => {
    addFiles(summary.mailboxId, [...event.target.files], reply.files, refreshFiles)
    event.target.value = ''
  })
  filesEl.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-file]')
    if (!remove) return
    reply.files = reply.files.filter((f) => f.id !== remove.dataset.removeFile)
    refreshFiles()
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const body = reply.text.trim()
    if (!body) return text.focus()
    const { attachments, error } = readyAttachments(reply.files)
    if (error) {
      reply.error = error
      return (form.querySelector('#reply-err').textContent = error)
    }
    reply.sending = true
    reply.error = ''
    renderReader()
    try {
      await sendReply(summary, body, attachments)
      view.replies[keyOf(summary)] = { text: '', files: [], sending: false, error: '' }
      toast('Reply sent')
    } catch (err) {
      Object.assign(reply, { sending: false, error: err.message })
    }
    renderReader()
  })
}

/** Replies to the latest message in the open conversation, from the conversation's own mailbox. */
async function sendReply(summary, text, attachments = []) {
  const messages = view.thread?.messages ?? []
  const latest = messages[messages.length - 1]
  const to = replyTarget(latest, addressOf(summary.mailboxId))
  if (!to.length) throw new Error('No one to reply to.')
  const subject = /^re:/i.test(summary.subject) ? summary.subject : `Re: ${summary.subject}`
  await data().send({ mailboxId: summary.mailboxId, to, subject, text, inReplyTo: latest?.id, attachments })
  await openThread(keyOf(summary), { markRead: false })
  loadFolders().then(() => (renderFolders(), ctx.refreshRail?.()))
}

// ---------------------------------------------------------------------------------------------------------------
// Events

function onClick(event) {
  const el = event.target.closest('button')
  if (!el || el.disabled) return
  const summary = selectedSummary()

  if (el.dataset.folder) return setView({ folder: el.dataset.folder, scope: null })
  if (el.dataset.domain) return setView({ folder: 'inbox', scope: { domainId: el.dataset.domain } })
  if (el.dataset.mailbox) return setView({ folder: 'inbox', scope: { mailboxId: el.dataset.mailbox } })
  if (el.dataset.unread) return setView({ unreadOnly: el.dataset.unread === '1' })
  if (el.dataset.id) {
    view.selectedId = el.dataset.id
    renderRows()
    return openThread(el.dataset.id)
  }
  if (el.dataset.download) return download(el)

  switch (el.dataset.act) {
    case 'compose':
      return openComposer()
    case 'all-inboxes':
      return setView({ folder: 'inbox', scope: null })
    case 'add-domain':
    case 'verify':
      return ctx.navigate('#/settings/domains')
    case 'retry':
      return loadList()
    case 'close':
      view.selectedId = null
      view.thread = null
      renderRows()
      return renderReader()
    case 'pin':
      return change(summary, { pinned: !summary.pinned }, summary.pinned ? 'Unpinned' : 'Pinned')
    case 'unread':
      return setSeen(summary, !summary.seen)
    case 'archive': {
      const toInbox = summary.folder === 'archive'
      return change(summary, { folder: toInbox ? 'inbox' : 'archive' }, toInbox ? 'Moved to inbox' : 'Archived', true)
    }
    case 'toggle-msg': {
      const index = Number(el.dataset.index)
      if (view.thread.expanded.has(index)) view.thread.expanded.delete(index)
      else view.thread.expanded.add(index)
      return renderReader()
    }
    case 'toggle-quote':
      return toggleQuote(el)
    case 'show-images':
      view.thread.showImages = true
      return renderReader()
    case 'send-draft': {
      const latest = view.thread.messages[view.thread.messages.length - 1]
      const { body } = latest.draft
      data().clearDraft(summary)
      latest.draft = null
      return sendReply(summary, body)
        .then(() => toast('Draft sent'))
        .catch((err) => toast(err.message))
    }
    case 'forward-mail':
      return openComposer({ forward: summary })
    case 'edit-draft': {
      const latest = view.thread.messages[view.thread.messages.length - 1]
      view.replies[keyOf(summary)] = { text: latest.draft.body, files: [], sending: false, error: '' }
      data().clearDraft(summary)
      latest.draft = null
      renderReader()
      return root.querySelector('#reply-text')?.focus()
    }
  }
}

function setView(changes) {
  Object.assign(view, changes)
  view.selectedId = null
  view.thread = null
  view.list = []
  renderFolders()
  renderList()
  renderReader()
  loadList()
}

/** Pins, unpins or moves a message: updates the screen right away, and reloads if the server says no. */
async function change(summary, patch, message, leavesList = false) {
  const before = { ...summary }
  Object.assign(summary, patch)
  if (leavesList && view.folder !== 'pinned' && summary.folder !== view.folder) {
    view.list = view.list.filter((m) => m !== summary)
    view.selectedId = window.innerWidth > 680 && view.list[0] ? keyOf(view.list[0]) : null
    view.thread = null
  }
  renderRows()
  renderReader()
  if (view.selectedId && !view.thread) openThread(view.selectedId, { markRead: false })
  try {
    await data().update(before, patch)
    toast(message)
    if (patch.folder) loadFolders().then(() => (renderFolders(), ctx.refreshRail?.()))
  } catch (err) {
    toast(err.message)
    loadList()
  }
}

async function download(button) {
  const [i, j] = button.dataset.download.split(':').map(Number)
  const m = view.thread.messages[i]
  const a = m.attachments.filter((x) => !x.inline)[j]
  button.setAttribute('aria-busy', 'true')
  try {
    const url = URL.createObjectURL(await data().attachment(m, a))
    const link = Object.assign(document.createElement('a'), { href: url, download: a.name })
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  } catch (err) {
    toast(err.message)
  } finally {
    button.removeAttribute('aria-busy')
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Composer

/**
 * The New mail window, also used to forward (`{ forward: summary }`): a forward keeps the original's attachments
 * and is sent from the conversation's own mailbox.
 */
function openComposer({ forward = null } = {}) {
  const canSend = data().canSend
  const mailboxes = forward ? view.mailboxes.filter((mb) => mb.mailboxId === forward.mailboxId) : view.mailboxes
  const files = []
  const original = forward ? view.thread?.messages[view.thread.messages.length - 1] : null
  const forwardText = original
    ? `\n\n---------- Forwarded message ----------\nFrom: ${original.from.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')}\n` +
      `Date: ${new Date(original.receivedAt).toLocaleString()}\nSubject: ${original.subject}\nTo: ${original.to.map((a) => a.email).join(', ')}\n\n${original.text}`
    : ''
  const kept = original?.attachments.filter((a) => !a.inline) ?? []
  const scrim = document.createElement('div')
  scrim.className = 'scrim'
  scrim.innerHTML = `
    <form class="modal" role="dialog" aria-modal="true" aria-labelledby="compose-title" novalidate>
      <div class="modal-head"><span id="compose-title">${forward ? 'Forward' : 'New mail'}</span><button type="button" class="x-btn" data-close aria-label="Close">${icon('x', 16)}</button></div>
      <div class="modal-row"><label for="c-from">From</label>
        <select id="c-from" ${forward ? 'disabled' : ''}>${mailboxes.map((mb) => `<option value="${mb.mailboxId}">${esc(mb.address)}</option>`).join('') || '<option value="">Add an address in Settings first</option>'}</select></div>
      <div class="modal-row"><label for="c-to">To</label><input id="c-to" placeholder="name@example.com, …" autocomplete="off">
        <button type="button" class="btn-quiet small" id="c-show-cc">Cc / Bcc</button></div>
      <div class="modal-row" id="c-cc-row" hidden><label for="c-cc">Cc</label><input id="c-cc" autocomplete="off"></div>
      <div class="modal-row" id="c-bcc-row" hidden><label for="c-bcc">Bcc</label><input id="c-bcc" autocomplete="off"></div>
      <div class="modal-row"><label for="c-subject">Subject</label><input id="c-subject" autocomplete="off" value="${esc(forward ? (/^fwd?:/i.test(forward.subject) ? forward.subject : `Fwd: ${forward.subject}`) : '')}"></div>
      <textarea id="c-body" placeholder="Write your message…" aria-label="Message">${esc(forwardText)}</textarea>
      ${kept.length ? `<div class="modal-note">${icon('paperclip', 13)}${kept.length} ${kept.length === 1 ? 'attachment' : 'attachments'} from the original will be included.</div>` : ''}
      <div id="c-files" style="padding:0 16px"></div>
      <div class="modal-foot">
        <label class="btn" title="Attach files">${icon('paperclip', 14)}Attach<input type="file" id="c-attach" multiple hidden></label>
        <span class="err" id="c-err" role="alert"></span>
        <button class="btn btn-primary" type="submit" id="c-send">${icon('send', 14)}Send</button>
      </div>
    </form>`
  document.body.append(scrim)
  const form = scrim.querySelector('form')
  const $ = (sel) => form.querySelector(sel)
  const refreshFiles = () => ($('#c-files').innerHTML = filesHtml(files))
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
  $('#c-show-cc').addEventListener('click', (event) => {
    $('#c-cc-row').hidden = false
    $('#c-bcc-row').hidden = false
    event.target.remove()
    $('#c-cc').focus()
  })
  $('#c-attach').addEventListener('change', (event) => {
    addFiles($('#c-from').value, [...event.target.files], files, refreshFiles)
    event.target.value = ''
  })
  $('#c-files').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-file]')
    if (!remove) return
    files.splice(files.findIndex((f) => f.id === remove.dataset.removeFile), 1)
    refreshFiles()
  })
  // Uploads belong to the mailbox they were made for; switching From starts the attachments over.
  $('#c-from').addEventListener('change', () => {
    if (!files.length) return
    files.length = 0
    refreshFiles()
    $('#c-err').textContent = 'Attachments were removed because you changed the From address. Attach them again.'
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const err = $('#c-err')
    err.textContent = ''
    const mailboxId = $('#c-from').value
    if (!mailboxId) return (err.textContent = 'Add an address first.')
    if (!canSend) return (err.textContent = "Sending from xstate isn't available yet.")
    const to = parseRecipients($('#c-to').value)
    const cc = parseRecipients($('#c-cc').value)
    const bcc = parseRecipients($('#c-bcc').value)
    const invalid = [...to.invalid, ...cc.invalid, ...bcc.invalid]
    if (invalid.length) return (err.textContent = `Not a valid address: ${invalid.join(', ')}`)
    if (!to.valid.length && !cc.valid.length && !bcc.valid.length) {
      err.textContent = 'Add at least one recipient.'
      return $('#c-to').focus()
    }
    const { attachments, error } = readyAttachments(files)
    if (error) return (err.textContent = error)
    const send = $('#c-send')
    send.disabled = true
    send.setAttribute('aria-busy', 'true')
    try {
      await data().send({
        mailboxId,
        to: to.valid,
        cc: cc.valid,
        bcc: bcc.valid,
        subject: $('#c-subject').value.trim(),
        text: $('#c-body').value,
        forwardOf: original?.id,
        attachments,
      })
      close()
      toast('Sent')
      loadFolders().then(() => (renderFolders(), ctx.refreshRail?.()))
      if (view.folder === 'sent') loadList()
    } catch (e) {
      err.textContent = e.message
      send.disabled = false
      send.removeAttribute('aria-busy')
    }
  })
}

window.addEventListener('xstate:compose', () => openComposer())
window.addEventListener('xstate:search', () => {
  view.searching = true
  if (root?.isConnected && root.querySelector('.mail')) renderList()
})

// ---------------------------------------------------------------------------------------------------------------
// Formatting

function formatTime(iso) {
  const d = new Date(iso)
  const now = new Date()
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000)
  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
