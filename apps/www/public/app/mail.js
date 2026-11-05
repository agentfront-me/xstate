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
  /** The open conversation: { id, messages, loading, error, showImages }. */
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
    view.list.push(...more.filter((m) => !view.list.some((x) => keyOf(x) === keyOf(m))))
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
  view.thread = { id, messages: [], loading: true, error: null, showImages: false }
  renderReader()
  try {
    const messages = await data().thread(summary)
    if (view.thread?.id !== id) return
    view.thread.messages = messages
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
        <div class="row-top"><span class="who ellipsis">${esc(who)}</span>
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

function messageHtml(m, index, t) {
  const from = m.from[0] ?? { name: null, email: '' }
  const files = m.attachments.filter((a) => !a.inline)
  const remote = !!m.html && /\bsrc\s*=\s*["']?https?:/i.test(m.html)
  return `
    <div class="message${index ? ' thread-reply' : ''}">
      <div class="sender">
        <span class="avatar lg">${esc(initials(from.name || from.email))}</span>
        <div class="who"><div class="ellipsis"><span class="from">${esc(from.name || from.email)}</span>
          ${from.name ? `<span class="email"> ${esc(from.email)}</span>` : ''}</div>
          <div class="to ellipsis">To ${esc(m.to.map((a) => a.email).join(', '))}${m.cc.length ? `, cc ${esc(m.cc.map((a) => a.email).join(', '))}` : ''}</div></div>
        <span class="time">${esc(formatTime(m.receivedAt))}</span>
      </div>
      ${
        m.html
          ? `${remote && !t.showImages ? `<div class="images-note">${icon('info', 14)}<span>Remote images are hidden to protect your privacy.</span><button data-act="show-images">Show images</button></div>` : ''}
             <iframe class="mail-html" data-index="${index}" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" title="Message"></iframe>`
          : `<div class="message-text">${m.text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join('')}</div>`
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

function replyHtml(summary) {
  const addresses = fromAddresses()
  const own = view.mailboxes.find((mb) => mb.mailboxId === summary.mailboxId)?.address
  const reply = (view.replies[keyOf(summary)] ??= { text: '', from: own ?? addresses[0] ?? '' })
  const canSend = data().canSend
  return `<div class="reply-wrap"><form class="reply" id="reply">
    <div class="reply-from">From
      <span class="select-chip"><span id="from-label">${esc(reply.from)}</span>${icon('chevron-down', 12)}
        <select id="reply-from" aria-label="Send from">${addresses.map((a) => `<option ${a === reply.from ? 'selected' : ''}>${esc(a)}</option>`).join('')}</select></span>
    </div>
    <textarea id="reply-text" rows="2" placeholder="${canSend ? 'Write a reply…' : 'Replying from xstate is coming soon'}" aria-label="Reply" ${canSend ? '' : 'disabled'}>${esc(reply.text)}</textarea>
    <div class="reply-foot">
      <button type="button" class="attach" aria-label="Attach a file" title="Attachments are coming soon" disabled>${icon('paperclip', 15)}</button>
      <button class="btn btn-primary" type="submit" ${canSend ? '' : 'disabled title="Sending is coming soon"'}>Send</button>
    </div></form></div>`
}

/** Writes each HTML body into its sandboxed iframe. No scripts run; remote images load only after "Show images". */
async function fillFrames(el, t) {
  for (const frame of el.querySelectorAll('iframe.mail-html')) {
    const m = t.messages[Number(frame.dataset.index)]
    const html = await withInlineImages(m)
    const images = t.showImages ? 'https: http: data: blob:' : 'data: blob:'
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument
      if (doc?.body) frame.style.height = `${doc.body.scrollHeight}px`
    })
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; font-src data:">
      <base target="_blank">
      <style>html,body{margin:0;background:#fff;color:#18181b;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere}
      body{padding:16px}img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}
      ${t.showImages ? '' : 'img[src^="http:"],img[src^="https:"]{display:none}'}</style></head>
      <body>${html}</body></html>`
  }
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
  text.addEventListener('input', () => {
    reply.text = text.value
    text.style.height = 'auto'
    text.style.height = `${Math.min(text.scrollHeight, 220)}px`
  })
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) form.requestSubmit()
  })
  form.querySelector('#reply-from').addEventListener('change', (event) => {
    reply.from = event.target.value
    form.querySelector('#from-label').textContent = event.target.value
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const body = reply.text.trim()
    if (!body) return text.focus()
    reply.text = ''
    await sendReply(summary, reply.from, body)
    toast('Reply sent')
  })
}

async function sendReply(summary, from, text) {
  const latest = view.thread?.messages[view.thread.messages.length - 1]
  data().send({
    inReplyTo: summary,
    from,
    to: (latest?.from[0] ?? summary.from[0])?.email,
    subject: summary.subject.startsWith('Re:') ? summary.subject : `Re: ${summary.subject}`,
    text,
  })
  await openThread(keyOf(summary), { markRead: false })
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
    case 'show-images':
      view.thread.showImages = true
      return renderReader()
    case 'send-draft': {
      const latest = view.thread.messages[view.thread.messages.length - 1]
      const { from, body } = latest.draft
      data().clearDraft(summary)
      return sendReply(summary, from, body).then(() => toast('Draft sent'))
    }
    case 'edit-draft': {
      const latest = view.thread.messages[view.thread.messages.length - 1]
      view.replies[keyOf(summary)] = { text: latest.draft.body, from: latest.draft.from }
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
    if (!data().canSend) return (err.textContent = "Sending from xstate isn't available yet.")
    data().send({ from: $('#c-from').value, to, subject: $('#c-subject').value.trim(), text: $('#c-body').value.trim() })
    close()
    toast('Sent')
    if (view.folder === 'sent') loadList()
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
