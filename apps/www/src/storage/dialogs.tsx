// Storage dialogs and the context menu: naming, sharing, versions, moving, confirming.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { copyText, desktop, errorMessage, initials } from '../lib/core'
import { formatSize, formatTime } from '../mail/format'
import { type Access, type OrgAccess, type Role, type Space, type StorageItem, fileKind, publicLinkUrl, saveBlob, storageApi } from './api'

// ---------------------------------------------------------------------------------------------------------------
// Menu

export type MenuItem = { icon: IconName; label: string; run: () => void }

export function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({ x: Math.max(8, Math.min(x, innerWidth - width - 8)), y: Math.max(8, Math.min(y, innerHeight - height - 8)) })
  }, [x, y])
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          onClick={() => {
            onClose()
            item.run()
          }}
        >
          <Icon name={item.icon} size={14} />
          {item.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Modal shell

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <span className="ellipsis">{title}</span>
          <button className="x-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Name (new folder, new file, rename)

export function NameDialog({
  title,
  action,
  initial,
  selectUntil,
  onSubmit,
  onClose,
}: {
  title: string
  action: string
  initial: string
  /** Select the name up to the last occurrence of this, so the extension stays: "report|.csv". */
  selectUntil?: string
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    const end = selectUntil ? initial.lastIndexOf(selectUntil) : -1
    el.setSelectionRange(0, end > 0 ? end : initial.length)
  }, [initial, selectUntil])
  const submit = async () => {
    const value = name.trim()
    if (!value) return setError('Enter a name')
    setBusy(true)
    try {
      await onSubmit(value)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <div className="modal-body">
          <input ref={input} className="text-input" value={name} onChange={(e) => { setName(e.target.value); setError(null) }} maxLength={180} aria-label="Name" />
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-foot">
          <span />
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy && <span className="spinner" />}{action}</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

export function ConfirmDialog({ title, body, action, onConfirm, onClose }: { title: string; body: string; action: string; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-body"><p className="muted">{body}</p></div>
      <div className="modal-foot">
        <span />
        <span className="row-gap">
          <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await onConfirm()
              onClose()
            }}
          >
            {action}
          </button>
        </span>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Share

const ROLE_LABEL: Record<Role, string> = { viewer: 'Viewer', editor: 'Editor', manager: 'Manager' }
const ROLES: Role[] = ['viewer', 'editor', 'manager']

/** A link to the item in the app. Opens only for people who already have access. */
function itemLink(item: StorageItem): string {
  const base = desktop || !/^https?:/.test(location.origin) ? 'https://xstate.com/app/' : `${location.origin}${location.pathname}`
  return `${base}#/storage?view=shared&${item.kind === 'folder' ? 'folder' : 'open'}=${encodeURIComponent(item.id)}`
}

/**
 * Share: add people from the organization by email, change or remove their access, and choose the general access:
 * only those people, the whole organization, or anyone with the link (a public, view-only link). Follows the share
 * dialog of the "xstate App" design; its "domain members" option isn't offered.
 */
export function ShareDialog({ orgId, item, onClose }: { orgId: string; item: StorageItem; onClose: () => void }) {
  const client = useQueryClient()
  const access = useQuery({ queryKey: ['storage', 'access', item.id], queryFn: () => storageApi.access(item.id) })
  const members = useQuery({ queryKey: ['storage', 'members', orgId], queryFn: () => storageApi.members(orgId), enabled: item.role === 'manager' })
  const [email, setEmail] = useState('')
  const [addRole, setAddRole] = useState<Role>('viewer')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const apply = async (input: { orgAccess?: OrgAccess | null; publicLink?: boolean; grants?: { memberId: string; role: Role | null }[] }) => {
    setBusy(true)
    try {
      const { publicLink, ...rest } = input
      let next = publicLink === undefined ? null : await storageApi.setPublicLink(item.id, publicLink)
      if (rest.orgAccess !== undefined || rest.grants) next = await storageApi.setAccess(item.id, rest)
      if (next) client.setQueryData(['storage', 'access', item.id], next)
      void client.invalidateQueries({ queryKey: ['storage', 'top'] })
      void client.invalidateQueries({ queryKey: ['storage', 'folder'] })
      return true
    } catch (err) {
      toast(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const a: Access | undefined = access.data
  const manage = !!a?.canManage
  const taken = new Set([a?.owner?.memberId, ...(a?.grants.map((g) => g.memberId) ?? [])])

  const invite = async () => {
    const value = email.trim().toLowerCase()
    if (!value) return
    const member = members.data?.find((m) => m.email.toLowerCase() === value)
    if (!member) return setError(`${value} isn't in your organization. Invite them to the organization first.`)
    if (taken.has(member.id)) return setError(`${member.name ?? member.email} already has access.`)
    if (await apply({ grants: [{ memberId: member.id, role: addRole }] })) {
      setEmail('')
      setError(null)
      toast(`Shared with ${member.name ?? member.email}`)
    }
  }

  const publicUrl = access.data?.publicLink ? publicLinkUrl(access.data.publicLink.token) : null
  const copyLink = async () => {
    const ok = await copyText(publicUrl ?? itemLink(item))
    toast(ok ? (publicUrl ? 'Public link copied' : 'Link copied') : "Couldn't copy the link")
  }

  const people = a
    ? [
        ...(a.owner ? [{ key: `o-${a.owner.memberId}`, name: a.owner.name, email: a.owner.email, right: <span className="dim small pad-r">Owner</span> }] : []),
        ...a.grants.map((g) => ({
          key: `g-${g.memberId}`,
          name: g.name,
          email: g.email,
          right: manage ? (
            <>
              <select className="select sm" value={g.role} disabled={busy} aria-label={`Access for ${g.name ?? g.email}`}
                onChange={(e) => void apply({ grants: [{ memberId: g.memberId, role: e.target.value as Role }] })}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <button className="ghost" title="Remove access" aria-label={`Remove ${g.name ?? g.email}`} disabled={busy}
                onClick={() => void apply({ grants: [{ memberId: g.memberId, role: null }] })}>
                <Icon name="x" size={14} />
              </button>
            </>
          ) : <span className="dim small pad-r">{ROLE_LABEL[g.role]}</span>,
        })),
        ...a.inherited.map((g) => ({
          key: `i-${g.from.id}-${g.memberId}`,
          name: g.name,
          email: g.email,
          right: <span className="dim small pad-r" title={`From the folder “${g.from.name}”`}>{g.owner ? 'Owner' : ROLE_LABEL[g.role]} · via “{g.from.name}”</span>,
        })),
      ]
    : []

  type Scope = 'private' | 'org' | 'public'
  const scope: Scope = a?.publicLink ? 'public' : a?.orgAccess ? 'org' : 'private'
  const scopes: { id: Scope; icon: IconName; label: string; desc: string }[] = [
    { id: 'private', icon: 'lock', label: 'Only invited people', desc: 'Just the owner and the people listed above.' },
    { id: 'org', icon: 'building-2', label: 'Whole organization', desc: 'Every member of this organization.' },
    {
      id: 'public',
      icon: 'globe',
      label: 'Anyone with the link',
      desc: `Anyone on the internet with the link can view and download${item.kind === 'folder' ? ' everything in this folder' : ''}, without signing in.`,
    },
  ]
  /** Moving between scopes. The public link is separate from organization access, so leaving it turns it off. */
  const choose = (next: Scope) => {
    if (!manage || next === scope || busy) return
    if (next === 'public') return void apply({ publicLink: true })
    return void apply({
      ...(a?.publicLink && { publicLink: false }),
      orgAccess: next === 'org' ? (a?.orgAccess ?? 'viewer') : null,
    })
  }

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal" role="dialog" aria-modal="true" aria-label={`Share ${item.name}`}>
        <EscapeCloses onClose={onClose} />
        <div className="share-head">
          <FileGlyph item={item} />
          <span className="grow ellipsis hi">Share “{item.name}”</span>
          <button className="ghost" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="share-body">
          {access.isPending ? (
            <div className="loading" style={{ height: 160 }}><span className="spinner" /></div>
          ) : access.isError ? (
            <p className="form-error">{errorMessage(access.error)}</p>
          ) : a ? (
            <>
              {manage && (
                <div className="share-invite-wrap">
                  <form className="share-invite" onSubmit={(e) => { e.preventDefault(); void invite() }}>
                    <input className="text-input" list={`members-${item.id}`} value={email} placeholder="Add people by email" aria-label="Email"
                      onChange={(e) => { setEmail(e.target.value); setError(null) }} />
                    <datalist id={`members-${item.id}`}>
                      {(members.data ?? []).filter((m) => !taken.has(m.id)).map((m) => <option key={m.id} value={m.email}>{m.name ?? ''}</option>)}
                    </datalist>
                    <select className="select" value={addRole} onChange={(e) => setAddRole(e.target.value as Role)} aria-label="Access to give">
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                    </select>
                    <button className="btn btn-primary" type="submit" disabled={busy || !email.trim()}>Invite</button>
                  </form>
                  {error && <p className="form-error">{error}</p>}
                </div>
              )}

              <div className="share-section">
                <div className="share-label">People with access</div>
                <div className="share-list">
                  {people.map((p) => (
                    <div key={p.key} className="share-person">
                      <span className="share-avatar">{initials(p.name ?? p.email)}</span>
                      <div className="text">
                        <span className="hi ellipsis">{p.name ?? p.email}</span>
                        {p.name && <span className="sub ellipsis">{p.email}</span>}
                      </div>
                      {p.right}
                    </div>
                  ))}
                </div>
              </div>

              <div className="share-section">
                <div className="share-label">General access</div>
                <div className="share-list" role="radiogroup" aria-label="General access">
                  {scopes.map((sc) => {
                    const active = scope === sc.id
                    return (
                      <div
                        key={sc.id}
                        role="radio"
                        aria-checked={active}
                        aria-disabled={!manage}
                        tabIndex={manage ? 0 : -1}
                        className={`share-scope${active ? ' is-active' : ''}`}
                        onClick={() => choose(sc.id)}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && choose(sc.id)}
                      >
                        <span className="s-tile"><Icon name={sc.icon} size={15} /></span>
                        <div className="text">
                          <span className="hi">{sc.label}</span>
                          <span className="sub">{sc.desc}</span>
                        </div>
                        {active && sc.id === 'org' && (
                          <select className="select sm" value={a.orgAccess ?? 'viewer'} disabled={!manage || busy} aria-label="What everyone gets"
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => void apply({ orgAccess: e.target.value as OrgAccess })}>
                            <option value="viewer">Viewer</option>
                            <option value="editor">Editor</option>
                          </select>
                        )}
                        <span className={`radio${active ? ' is-on' : ''}`}><Icon name={active ? 'circle-check' : 'circle'} size={16} /></span>
                      </div>
                    )
                  })}
                </div>
                {publicUrl && (
                  <div className="share-link">
                    <input className="text-input" readOnly value={publicUrl} aria-label="Public link" onFocus={(e) => e.currentTarget.select()} />
                    <button className="btn" onClick={() => void copyLink()}><Icon name="copy" size={14} />Copy</button>
                  </div>
                )}
                {a.publicLink && (
                  <p className="share-note">
                    {a.orgAccess === 'editor' && 'Everyone in the organization can still edit it. '}
                    Turning the link off stops it working; turning it on again makes a new link.
                  </p>
                )}
                {a.inheritedPublicLink && (
                  <p className="share-note">
                    Anyone with the public link to the folder “{a.inheritedPublicLink.from.name}” can view this.
                  </p>
                )}
                {a.inheritedOrgAccess && (
                  <p className="share-note">
                    Everyone in the organization can {a.inheritedOrgAccess.access === 'editor' ? 'edit' : 'view'} this through the folder “{a.inheritedOrgAccess.from.name}”. Access set here adds to the folder’s; it can’t take it away.
                  </p>
                )}
                <p className="share-note">
                  {item.space === 'organization'
                    ? 'Admins can manage everything in team folders.'
                    : 'Admins can’t see My Files unless you share with them.'}
                  {item.kind === 'folder' && ' Access on this folder applies to everything inside it.'}
                </p>
              </div>
            </>
          ) : null}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => void copyLink()}><Icon name="link" size={14} />{publicUrl ? 'Copy public link' : 'Copy link'}</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

function EscapeCloses({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return null
}

function FileGlyph({ item }: { item: StorageItem }) {
  const k = fileKind(item.name, item.contentType, item.kind)
  return <span className="muted"><Icon name={k === 'folder' ? 'folder' : k === 'csv' ? 'file-spreadsheet' : k === 'image' ? 'image' : 'file-text'} size={16} /></span>
}

// ---------------------------------------------------------------------------------------------------------------
// Versions

export function VersionsDialog({ item, onClose, onRestored }: { item: StorageItem; onClose: () => void; onRestored: (item: StorageItem) => void }) {
  const versions = useQuery({ queryKey: ['storage', 'versions', item.id, item.version], queryFn: () => storageApi.versions(item.id) })
  const [busy, setBusy] = useState<number | null>(null)
  const editable = item.role !== 'viewer'
  return (
    <Modal title={`Versions of “${item.name}”`} onClose={onClose} wide>
      <div className="modal-body">
        {versions.isPending ? (
          <div className="loading" style={{ height: 120 }}><span className="spinner" /></div>
        ) : versions.isError ? (
          <p className="form-error">{errorMessage(versions.error)}</p>
        ) : (
          <div className="card">
            {versions.data.map((v) => (
              <div key={v.version} className="card-row">
                <div className="text">
                  <span className="name">Version {v.version}{v.current && <span className="tag" style={{ marginLeft: 8 }}>Current</span>}</span>
                  <span className="sub">
                    {new Date(v.savedAt).toLocaleString()}{v.savedBy ? ` · ${v.savedBy}` : ''} · {formatSize(v.size)}
                    {v.expiresAt && ` · kept until ${formatTime(v.expiresAt)}`}
                  </span>
                </div>
                <div className="right">
                  <button
                    className="btn-tool"
                    aria-label={`Download version ${v.version}`}
                    onClick={async () => {
                      try {
                        saveBlob(await storageApi.content(item.id, v.version), item.name)
                      } catch (err) {
                        toast(errorMessage(err))
                      }
                    }}
                  >
                    <Icon name="download" size={14} />
                  </button>
                  {!v.current && editable && (
                    <button
                      className="btn"
                      disabled={busy !== null}
                      onClick={async () => {
                        setBusy(v.version)
                        try {
                          const restored = await storageApi.restoreVersion(item.id, v.version)
                          toast(`Restored version ${v.version} as version ${restored.version}`)
                          onRestored(restored)
                          onClose()
                        } catch (err) {
                          toast(errorMessage(err))
                          setBusy(null)
                        }
                      }}
                    >
                      {busy === v.version && <span className="spinner" />}Restore
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="muted small" style={{ marginTop: 10 }}>The last 5 earlier versions are kept, each for 30 days after it was replaced.</p>
      </div>
      <div className="modal-foot"><span /><button className="btn" onClick={onClose}>Done</button></div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Move

type Place = { space: Space; folderId: string | null; name: string }

export function MoveDialog({ orgId, item, onClose, onMoved }: { orgId: string; item: StorageItem; onClose: () => void; onMoved: (to: string) => void }) {
  const [place, setPlace] = useState<Place>({ space: item.space, folderId: null, name: item.space === 'personal' ? 'My Files' : 'Team folders' })
  const [trail, setTrail] = useState<Place[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const list = useQuery({
    queryKey: ['storage', 'move', place.space, place.folderId],
    queryFn: async () =>
      place.folderId
        ? (await storageApi.folder(place.folderId)).items
        : storageApi.top(orgId, place.space === 'personal' ? 'personal' : 'organization'),
  })
  const folders = (list.data ?? []).filter((i) => i.kind === 'folder' && i.id !== item.id)
  const here = place.folderId === item.parentId && (place.folderId !== null || place.space === item.space)

  const enter = (to: Place) => {
    setTrail((t) => [...t, place])
    setPlace(to)
    setError(null)
  }

  const move = async () => {
    setBusy(true)
    try {
      await storageApi.update(item.id, place.folderId ? { parentId: place.folderId } : { parentId: null, space: place.space })
      onMoved(place.name)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={`Move “${item.name}”`} onClose={onClose}>
      <div className="modal-body">
        <div className="move-head">
          {trail.length > 0 && (
            <button className="ghost" aria-label="Back" onClick={() => { setPlace(trail.at(-1)!); setTrail((t) => t.slice(0, -1)) }}>
              <Icon name="arrow-left" size={15} />
            </button>
          )}
          <span className="hi ellipsis">{place.name}</span>
          {!place.folderId && (
            <div className="seg" style={{ marginLeft: 'auto' }}>
              <button aria-pressed={place.space === 'personal'} onClick={() => { setTrail([]); setPlace({ space: 'personal', folderId: null, name: 'My Files' }) }}>My Files</button>
              <button aria-pressed={place.space === 'organization'} onClick={() => { setTrail([]); setPlace({ space: 'organization', folderId: null, name: 'Team folders' }) }}>Team folders</button>
            </div>
          )}
        </div>
        <div className="move-list">
          {list.isPending ? (
            <div className="loading" style={{ height: 80 }}><span className="spinner" /></div>
          ) : !folders.length ? (
            <p className="muted small" style={{ padding: 12 }}>No folders here.</p>
          ) : (
            folders.map((f) => (
              <button key={f.id} className="folder" disabled={f.role === 'viewer'} onClick={() => enter({ space: f.space, folderId: f.id, name: f.name })}>
                <Icon name="folder" size={15} />
                <span className="label ellipsis">{f.name}</span>
                <Icon name="chevron-right" size={13} />
              </button>
            ))
          )}
        </div>
        {error && <p className="form-error">{error}</p>}
      </div>
      <div className="modal-foot">
        <span className="muted small">{here ? 'It’s already here' : `Move to ${place.name}`}</span>
        <span className="row-gap">
          <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || here} onClick={() => void move()}>Move here</button>
        </span>
      </div>
    </Modal>
  )
}
