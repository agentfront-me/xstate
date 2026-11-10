// Users: the people who visit or use the organization's websites (the audience_* API, users/api.ts). Follows the
// Users screen of the "xstate App" design: segments on the left with live counts, people in a bordered table with
// a domain switcher and search above it, a profile panel over the right of the table, and the "New segment" dialog.
// Where you are lives in the URL (#/users?segment=…&domain=…&q=…&person=…).

import '../styles/storage.css'
import '../styles/users.css'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { isOrgAdmin, useAccount } from '../lib/account'
import { apiUrl, copyText, errorMessage } from '../lib/core'
import { ConfirmDialog, Menu, type MenuItem } from '../storage/dialogs'
import { saveBlob } from '../storage/api'
import { type Person, type Segment, audienceApi, audienceKeys, displayName, isAnonymous, keysApi, kindLabel, relative, shortVisitor } from './api'
import { Avatar, PersonPanel } from './PersonPanel'
import { PersonDialog } from './PersonDialog'
import { SegmentDialog } from './SegmentDialog'

/** segment 'other' is the viewer's own auto-saved "Other contacts", not a saved segment. */
export type UsersSearch = { segment?: string; domain?: string; q?: string; person?: string }

const OTHER = 'other'

export function UsersPage({ search }: { search: UsersSearch }) {
  const account = useAccount()
  if (account.mode === 'demo') {
    return (
      <section className="soon">
        <div className="col-head drag"><span className="title">Users</span></div>
        <div className="empty">
          <Icon name="users" size={28} />
          <strong>Users needs a signed-in account</strong>
          <span>Sign in to see the people who visit your websites and group them into segments.</span>
        </div>
      </section>
    )
  }
  const canManage = isOrgAdmin(account.org)
  return <Users orgId={account.org.id} memberId={account.org.memberId} canManage={canManage} search={search} />
}

type Dialog = { kind: 'new-segment' } | { kind: 'edit-segment'; segment: Segment } | { kind: 'delete-segment'; segment: Segment } | { kind: 'add-user' }

function Users({ orgId, memberId, canManage, search }: { orgId: string; memberId?: string; canManage: boolean; search: UsersSearch }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const go = (next: UsersSearch, replace = false) => void navigate({ to: '/users', search: next, replace })
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const overview = useQuery({ queryKey: [...audienceKeys.all, 'overview'], queryFn: () => audienceApi.overview(orgId) })
  const segments = overview.data?.segments ?? []
  const segment = segments.find((s) => s.id === search.segment)
  const other = search.segment === OTHER
  const otherCount = overview.data?.otherContacts ?? 0
  const refresh = () => client.invalidateQueries({ queryKey: audienceKeys.all })

  const saveSegment = async (input: { name: string; filter: Segment['filter'] }, existing?: Segment) => {
    if (existing) await audienceApi.updateSegment(orgId, existing.id, { ...input, icon: existing.icon })
    else {
      const { segment: created } = await audienceApi.createSegment(orgId, input)
      go({ segment: created.id })
    }
    void refresh()
    toast(existing ? `Saved ${input.name}` : `Created ${input.name}`)
  }

  return (
    <div className="storage users">
      <aside className="s-side" aria-label="Segments">
        <div className="col-head drag s-side-head">
          <span className="title grow">Users</span>
          {canManage && <button className="ghost" title="New segment" aria-label="New segment" onClick={() => setDialog({ kind: 'new-segment' })}><Icon name="plus" size={16} /></button>}
        </div>
        <nav className="s-sections">
          <button className="s-section" aria-current={!search.segment ? 'true' : undefined} onClick={() => go({ domain: search.domain })}>
            <span className="s-tile"><Icon name="users" size={15} /></span>
            <span className="s-section-name">All users</span>
            {overview.data && <span className="s-section-meta">{overview.data.total.toLocaleString()}</span>}
          </button>
          {segments.length > 0 && <div className="u-side-label">Segments</div>}
          {segments.map((s) => (
            <div key={s.id} className="u-seg-item">
              <button className="s-section" aria-current={search.segment === s.id ? 'true' : undefined} onClick={() => go({ segment: s.id, domain: search.domain })}>
                <span className="s-tile"><Icon name={s.icon as IconName} size={15} /></span>
                <span className="s-section-name">{s.name}</span>
                <span className="s-section-meta">{s.count.toLocaleString()}</span>
              </button>
              {canManage && (
                <button
                  className="ghost u-seg-more"
                  aria-label={`${s.name} options`}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenu({
                      x: r.left,
                      y: r.bottom + 4,
                      items: [
                        { icon: 'square-pen', label: 'Edit segment', run: () => setDialog({ kind: 'edit-segment', segment: s }) },
                        { icon: 'trash', label: 'Delete segment', run: () => setDialog({ kind: 'delete-segment', segment: s }) },
                      ],
                    })
                  }}
                >
                  <Icon name="ellipsis" size={14} />
                </button>
              )}
            </div>
          ))}
          {/* Only yours, and only once an import brought some in (or you're looking at them). */}
          {(otherCount > 0 || other) && (
            <>
              <div className="u-side-label">Contacts</div>
              <button
                className="s-section"
                aria-current={other ? 'true' : undefined}
                title="Addresses Gmail saved when you emailed someone. They're suggested when you write an address."
                onClick={() => go({ segment: OTHER })}
              >
                <span className="s-tile"><Icon name="user" size={15} /></span>
                <span className="s-section-name">Other contacts</span>
                <span className="s-section-meta">{otherCount.toLocaleString()}</span>
              </button>
            </>
          )}
        </nav>
      </aside>

      <PeopleList
        orgId={orgId}
        canManage={canManage}
        search={search}
        go={go}
        title={other ? 'Other contacts' : (segment?.name ?? 'All users')}
        other={other}
        domains={overview.data?.domains ?? []}
        empty={!other && overview.data?.total === 0}
        onAdd={() => setDialog({ kind: 'add-user' })}
      />

      {search.person && (
        <PersonPanel
          key={search.person}
          orgId={orgId}
          personId={search.person}
          memberId={memberId}
          canManage={canManage}
          onClose={() => go({ ...search, person: undefined })}
          onSegment={(id) => go({ segment: id, person: search.person })}
          onSaved={() => void refresh()}
          onDeleted={() => {
            toast('Deleted')
            go({ ...search, person: undefined }, true)
            void refresh()
          }}
        />
      )}

      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog?.kind === 'new-segment' && <SegmentDialog orgId={orgId} onSave={(input) => saveSegment(input)} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit-segment' && (
        <SegmentDialog orgId={orgId} segment={dialog.segment} onSave={(input) => saveSegment(input, dialog.segment)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete-segment' && (
        <ConfirmDialog
          title="Delete segment"
          body={`Delete ${dialog.segment.name}? The people in it stay; only the saved filter goes.`}
          action="Delete"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await audienceApi.deleteSegment(orgId, dialog.segment.id)
            if (search.segment === dialog.segment.id) go({ domain: search.domain }, true)
            void refresh()
            toast(`Deleted ${dialog.segment.name}`)
          }}
        />
      )}
      {dialog?.kind === 'add-user' && (
        <PersonDialog
          title={canManage ? 'Add user' : 'Add contact'}
          domains={(overview.data?.domains ?? []).map((d) => d.domain)}
          canManage={canManage}
          onClose={() => setDialog(null)}
          onSubmit={async ({ domain, kind, shared, ...fields }) => {
            const { person } = await audienceApi.addPerson(orgId, { ...fields, kind: kind ?? 'lead', shared, ...(kind !== 'contact' && { domain: domain ?? '' }) })
            void refresh()
            go({ ...search, person: person.id })
            toast(`Added ${displayName(person)}`)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The table

function PeopleList({
  orgId,
  canManage,
  search,
  go,
  title,
  other,
  domains,
  empty,
  onAdd,
}: {
  orgId: string
  canManage: boolean
  search: UsersSearch
  go: (s: UsersSearch, replace?: boolean) => void
  title: string
  other: boolean
  domains: { domain: string; count: number }[]
  empty: boolean
  onAdd: () => void
}) {
  const params = other ? { other: true, q: search.q } : { segmentId: search.segment, domain: search.domain, q: search.q }
  const [term, setTerm] = useState(search.q ?? '')
  const [exporting, setExporting] = useState(false)
  useEffect(() => setTerm(search.q ?? ''), [search.q])
  useEffect(() => {
    const next = term.trim() || undefined
    if (next === search.q) return
    const t = setTimeout(() => go({ ...search, q: next, person: undefined }, true), 250)
    return () => clearTimeout(t)
    // Only typing should search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term])

  const query = useInfiniteQuery({
    queryKey: [...audienceKeys.all, 'people', params],
    queryFn: ({ pageParam }) => audienceApi.people(orgId, { ...params, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const people = query.data?.pages.flatMap((p) => p.people) ?? []
  const total = query.data?.pages[0]?.total

  const exportCsv = async () => {
    setExporting(true)
    try {
      saveBlob(await audienceApi.exportCsv(orgId, params), `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`)
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="s-main">
      <div className="col-head drag s-head">
        <div className="grow s-head-text">
          <span className="crumb" aria-current="page">{title}</span>
          {total !== undefined && <span className="sub">{total.toLocaleString()} {other ? (total === 1 ? 'address' : 'addresses') : total === 1 ? 'user' : 'users'}</span>}
        </div>
        <span className="spacer-grow" />
        {!other && <label className="u-domain" title="Domain">
          <Icon name="globe" size={14} />
          <span className="ellipsis">{search.domain ?? 'All domains'}</span>
          <Icon name="chevron-down" size={13} />
          <select aria-label="Domain" value={search.domain ?? ''} onChange={(e) => go({ ...search, domain: e.target.value || undefined, person: undefined })}>
            <option value="">All domains</option>
            {domains.map((d) => <option key={d.domain} value={d.domain}>{d.domain} ({d.count.toLocaleString()})</option>)}
            {search.domain && !domains.some((d) => d.domain === search.domain) && <option value={search.domain}>{search.domain}</option>}
          </select>
        </label>}
        <label className="s-search">
          <Icon name="search" size={14} />
          <input type="search" placeholder={other ? 'Search other contacts' : 'Search users'} aria-label={other ? 'Search other contacts' : 'Search users'} value={term} onChange={(e) => setTerm(e.target.value)} />
        </label>
        <button className="btn btn-sm" onClick={() => void exportCsv()} disabled={exporting || !total}>
          {exporting ? <span className="spinner" /> : <Icon name="download" size={14} />}Export
        </button>
        {/* Anyone can add their own contacts; adding website leads needs the manage permission. */}
        {!other && <button className="btn btn-sm btn-primary" onClick={onAdd}><Icon name="user-plus" size={14} />Add user</button>}
      </div>

      <div className="s-scroll">
        {query.isPending ? (
          <div className="loading"><span className="spinner" /></div>
        ) : query.isError ? (
          <div className="empty">
            <Icon name="circle-alert" size={24} />
            <strong>Couldn't load users</strong>
            <span>{errorMessage(query.error)}</span>
            <button className="btn" onClick={() => void query.refetch()}>Try again</button>
          </div>
        ) : empty ? (
          <Setup orgId={orgId} canManage={canManage} />
        ) : (
          <div className="s-table" role="table" aria-label={title}>
            {other && (
              <p className="u-other-note muted small">
                Addresses Gmail saved when you emailed someone, copied from Google. Only you see them; they're suggested when you write an address.
                Open one to move it to your contacts.
              </p>
            )}
            <div className="s-row u-row s-row-head" role="row">
              <span role="columnheader">User</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Domain</span>
              <span role="columnheader">Source</span>
              <span role="columnheader" className="num">Last seen</span>
            </div>
            {people.length === 0 ? (
              <div className="s-empty">{search.q ? `No one matches “${search.q}”.` : other ? 'No other contacts.' : 'No one matches yet.'}</div>
            ) : (
              people.map((p) => <PersonRow key={p.id} person={p} selected={search.person === p.id} onOpen={() => go({ ...search, person: p.id })} />)
            )}
          </div>
        )}
        {query.hasNextPage && (
          <div className="more-row">
            <button className="btn" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {query.isFetchingNextPage && <span className="spinner" />}Load more
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function PersonRow({ person: p, selected, onOpen }: { person: Person; selected: boolean; onOpen: () => void }) {
  const anon = isAnonymous(p)
  return (
    <div
      role="row"
      tabIndex={0}
      className={`s-row u-row${selected ? ' is-selected' : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
    >
      <span className="u-person" role="cell">
        <Avatar person={p} />
        <span className="u-person-text">
          <span className="hi ellipsis">{anon ? 'Anonymous visitor' : displayName(p)}</span>
          <span className={`small ellipsis ${anon ? 'mono dim' : 'muted'}`}>{anon ? shortVisitor(p) : p.email ?? (p.name ? p.externalId : null) ?? ''}</span>
        </span>
      </span>
      <span role="cell"><span className="u-type">{kindLabel(p)}</span></span>
      <span role="cell" className="ellipsis muted">{p.domain || '—'}</span>
      <span role="cell" className="ellipsis muted">{p.source}</span>
      <span role="cell" className="num muted" title={new Date(p.lastSeenAt).toLocaleString()}>{relative(p.lastSeenAt)}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// No one yet: how to start tracking.

function Setup({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const navigate = useNavigate()
  const keys = useQuery({ queryKey: [...audienceKeys.all, 'keys'], queryFn: () => keysApi.get(orgId), enabled: canManage })
  const pk = keys.data?.keys.publishable.key ?? 'pk_live_…'
  const code = snippetFor(pk)
  return (
    <div className="u-setup">
      <div className="u-setup-head">
        <span className="s-tile"><Icon name="users" size={16} /></span>
        <div>
          <strong className="hi">No users yet</strong>
          <p className="muted small">Add this snippet to your website. Visitors show up here as leads, and as users once you identify them.</p>
        </div>
      </div>
      <CodeBlock code={code} />
      <p className="muted small">
        After sign-in, call <code className="mono">xstate('identify', userId, {'{ email, name }'}, userHash)</code>, where userHash is an
        HMAC-SHA256 of the user id made on your server with your secret key. Track anything else with{' '}
        <code className="mono">xstate('track', 'event_name', {'{ … }'})</code>.
      </p>
      {canManage && (
        <div>
          <button className="btn btn-sm" onClick={() => void navigate({ to: '/settings/$section', params: { section: 'api-keys' } })}>
            <Icon name="key-round" size={13} />API keys
          </button>
        </div>
      )}
    </div>
  )
}

/** Where the snippet loads from: the API this dashboard talks to. */
const API_ORIGIN = apiUrl('').replace(/\/v1$/, '')

export function snippetFor(publishableKey: string): string {
  return `<script>window.xstate=window.xstate||function(){(xstate.q=xstate.q||[]).push(arguments)};xstate('init','${publishableKey}')</script>
<script async src="${API_ORIGIN}/js/xstate.js"></script>`
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="u-code">
      <pre className="mono">{code}</pre>
      <button className="btn btn-sm" onClick={() => void copyText(code).then((ok) => toast(ok ? 'Copied' : "Couldn't copy"))}>
        <Icon name="copy" size={13} />Copy
      </button>
    </div>
  )
}
