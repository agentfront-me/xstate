// A person's profile, in the panel that slides over the right of the Users table (design: Users → row click):
// contact details, the segments they're in, custom attributes and their activity.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { useAccount } from '../lib/account'
import { errorMessage, initials } from '../lib/core'
import type { MessageSummary } from '../lib/types'
import { ConfirmDialog } from '../storage/dialogs'
import { PersonDialog } from './PersonDialog'
import {
  type AudienceEvent,
  type Person,
  type PersonFields,
  audienceApi,
  audienceKeys,
  canEditPerson,
  isOtherContact,
  displayName,
  isAnonymous,
  kindLabel,
  longDate,
  relative,
  shortDate,
  shortVisitor,
} from './api'

export function PersonPanel({
  orgId,
  personId,
  memberId,
  canManage,
  onClose,
  onSegment,
  onSaved,
  onDeleted,
}: {
  orgId: string
  personId: string
  /** The viewer's member id: their own contacts are theirs to edit. */
  memberId?: string
  canManage: boolean
  onClose: () => void
  onSegment: (segmentId: string) => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const query = useQuery({ queryKey: [...audienceKeys.all, 'person', personId], queryFn: () => audienceApi.person(orgId, personId) })
  const [dialog, setDialog] = useState<'edit' | 'delete' | null>(null)
  const data = query.data
  const p = data?.person
  const canEdit = p ? canEditPerson(p, memberId, canManage) : false
  const [moving, setMoving] = useState(false)
  // An auto-saved address becomes a real contact: shown in All users, still yours only.
  const moveToContacts = async () => {
    if (!p) return
    setMoving(true)
    try {
      await audienceApi.updatePerson(orgId, p.id, { attributes: { other: null } })
      toast(`${displayName(p)} moved to your contacts`)
      onSaved()
    } catch (e) {
      toast(errorMessage(e))
    } finally {
      setMoving(false)
    }
  }

  return (
    <aside className="u-panel" aria-label="Profile">
      {query.isPending ? (
        <div className="loading"><span className="spinner" /></div>
      ) : query.isError || !p || !data ? (
        <div className="empty">
          <Icon name="circle-alert" size={22} />
          <strong>Couldn't load this person</strong>
          <span>{errorMessage(query.error)}</span>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      ) : (
        <>
          <div className="u-panel-head">
            <Avatar person={p} size={40} orgId={orgId} />
            <div className="u-panel-title">
              <span className="row-gap">
                <span className="hi ellipsis">{isAnonymous(p) ? 'Anonymous visitor' : displayName(p)}</span>
                <span className="tag">{kindLabel(p)}</span>
                {p.kind === 'contact' && !p.owner && <span className="tag">Shared</span>}
              </span>
              <span className={`small ${isAnonymous(p) ? 'mono dim' : 'muted'} ellipsis`}>{isAnonymous(p) ? shortVisitor(p) : p.email ?? p.externalId}</span>
            </div>
            {canEdit && <button className="ghost" title="Edit" aria-label="Edit" onClick={() => setDialog('edit')}><Icon name="square-pen" size={15} /></button>}
            <button className="ghost" title="Close" aria-label="Close" onClick={onClose}><Icon name="x" size={15} /></button>
          </div>
          <div className="u-panel-scroll">
            <dl className="u-kv">
              <Row label="Email" value={p.email} />
              <Row label="Phone" value={p.phone} />
              {p.externalId && <Row label="User ID" value={p.externalId} mono />}
              {p.anonymousId && <Row label="Visitor ID" value={p.anonymousId} mono />}
              <Row label="Source" value={p.source} />
              <Row label="Domain" value={p.domain} />
              <Row label="First seen" value={longDate(p.firstSeenAt)} />
              <Row label="Last seen" value={relative(p.lastSeenAt)} title={new Date(p.lastSeenAt).toLocaleString()} />
            </dl>

            <section className="u-section">
              <h3 className="u-label">Segments</h3>
              {data.segments.length ? (
                <div className="u-chips">
                  {data.segments.map((s) => <button key={s.id} className="u-chip" onClick={() => onSegment(s.id)}>{s.name}</button>)}
                </div>
              ) : (
                <p className="dim small">Not in any segment.</p>
              )}
            </section>

            <section className="u-section">
              <h3 className="u-label">Attributes</h3>
              {Object.keys(p.attributes).length ? (
                <dl className="u-kv u-attrs">
                  {Object.entries(p.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => <Row key={k} label={k} value={String(v)} mono />)}
                </dl>
              ) : (
                <p className="dim small">No attributes yet.{canEdit && <> <button className="link" onClick={() => setDialog('edit')}>Add one</button></>}</p>
              )}
            </section>

            <section className="u-section">
              <h3 className="u-label">Activity</h3>
              {data.events.length || data.emails?.length ? (
                <Timeline person={p} events={data.events} emails={data.emails ?? []} />
              ) : (
                <p className="dim small">No activity in the last 90 days.</p>
              )}
              {data.emails === null && <p className="dim small">Couldn't load emails with this person right now.</p>}
            </section>

            {canEdit && (
              <div className="u-panel-foot">
                {isOtherContact(p) && (
                  <button className="btn btn-sm" disabled={moving} aria-busy={moving} onClick={() => void moveToContacts()}>
                    <Icon name="user-plus" size={13} />Move to contacts
                  </button>
                )}
                <button className="btn btn-sm" onClick={() => setDialog('delete')}><Icon name="trash" size={13} />{p.kind === 'contact' ? 'Delete contact' : 'Delete user'}</button>
              </div>
            )}
          </div>
        </>
      )}
      {dialog === 'edit' && p && (
        <PersonDialog
          title="Edit user"
          person={p}
          onClose={() => setDialog(null)}
          onSubmit={async (fields: PersonFields) => {
            await audienceApi.updatePerson(orgId, p.id, fields)
            onSaved()
          }}
        />
      )}
      {dialog === 'delete' && p && (
        <ConfirmDialog
          title="Delete user"
          body={`Delete ${isAnonymous(p) ? 'this visitor' : displayName(p)} and all their activity? This can't be undone.`}
          action="Delete"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await audienceApi.deletePeople(orgId, [p.id])
            onDeleted()
          }}
        />
      )}
    </aside>
  )
}

function Row({ label, value, mono, title }: { label: string; value: string | null | undefined; mono?: boolean; title?: string }) {
  return (
    <div className="u-kv-row">
      <dt className={mono ? 'mono' : undefined}>{label}</dt>
      <dd className={`${mono ? 'mono ' : ''}${value ? '' : 'dim'}`} title={title ?? value ?? undefined}>{value || '—'}</dd>
    </div>
  )
}

/** Initials, or a contact's photo when one was imported (pass `orgId` to load it). */
export function Avatar({ person, size = 28, orgId }: { person: Person; size?: number; orgId?: string }) {
  const [photo, setPhoto] = useState<string | null>(null)
  const hasPhoto = !!orgId && typeof person.attributes.photoKey === 'string'
  useEffect(() => {
    if (!hasPhoto) return
    let url: string | null = null
    let live = true
    audienceApi
      .photo(orgId, person.id)
      .then((u) => {
        if (!live) return URL.revokeObjectURL(u)
        url = u
        setPhoto(u)
      })
      .catch(() => null)
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [hasPhoto, orgId, person.id])
  return (
    <span className="u-avatar" style={{ width: size, height: size, fontSize: size > 32 ? 13 : 11 }}>
      {photo ? <img src={photo} alt="" className="u-avatar-img" /> : isAnonymous(person) ? <Icon name="user" size={size > 32 ? 16 : 13} /> : initials(person.name || person.email)}
    </span>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Activity

const PAGEVIEW = '$pageview'

function describe(e: AudienceEvent): { icon: IconName; text: string } {
  if (e.name === PAGEVIEW) {
    let path = e.url ?? ''
    try {
      const u = new URL(path)
      path = u.pathname + u.search
    } catch {
      // Keep whatever was sent.
    }
    return { icon: 'eye', text: `Viewed ${path || 'a page'}` }
  }
  const words = e.name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase()
  const text = words.charAt(0).toUpperCase() + words.slice(1)
  const icon: IconName = /mail|subscrib|newsletter/.test(words) ? 'mail' : /form|submit|sign ?up/.test(words) ? 'file-text' : 'mouse-pointer-2'
  return { icon, text }
}

type Item =
  | { kind: 'event'; at: string; key: string; event: AudienceEvent }
  | { kind: 'email'; at: string; key: string; email: MessageSummary }

/** Website events and emails with the person, newest first. */
function Timeline({ person, events, emails }: { person: Person; events: AudienceEvent[]; emails: MessageSummary[] }) {
  const account = useAccount()
  const mailboxAddress = (id: string) => account.mailboxes.find((m) => m.id === id)?.address ?? 'your team'
  const items: Item[] = [
    ...events.map((e): Item => ({ kind: 'event', at: e.occurredAt, key: `e${e.id}`, event: e })),
    ...emails.map((m): Item => ({ kind: 'email', at: m.receivedAt, key: `m${m.mailboxId}/${m.id}`, email: m })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))

  return (
    <ol className="u-timeline">
      {items.map((item) => {
        if (item.kind === 'email') {
          const d = describeEmail(item.email, person, mailboxAddress(item.email.mailboxId))
          return (
            <li key={item.key}>
              <span className="u-dot"><Icon name={d.icon} size={13} /></span>
              <div className="u-event">
                <span className="hi u-event-text">{d.text}</span>
                {item.email.preview && <span className="muted small u-preview">{item.email.preview}</span>}
                <span className="dim small" title={new Date(item.at).toLocaleString()}>{dayLabel(item.at)}</span>
              </div>
            </li>
          )
        }
        const e = item.event
        const d = describe(e)
        const props = Object.entries(e.properties).filter(([k, v]) => v !== undefined && v !== null && v !== '' && !(e.name === PAGEVIEW && k === 'title'))
        return (
          <li key={item.key}>
            <span className="u-dot"><Icon name={d.icon} size={13} /></span>
            <div className="u-event">
              <span className="hi u-event-text" title={e.name === PAGEVIEW ? e.url ?? undefined : e.name}>{d.text}</span>
              {props.length > 0 && (
                <span className="u-props">
                  {props.slice(0, 6).map(([k, v]) => <span key={k} className="u-prop mono">{k}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>)}
                </span>
              )}
              <span className="dim small" title={new Date(e.occurredAt).toLocaleString()}>{dayLabel(e.occurredAt)}</span>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** As in the design: 'Replied to sales@…: "Can we start next week?"' or 'sales@… sent "Pricing for Brightloop"'. */
function describeEmail(m: MessageSummary, person: Person, mailbox: string): { icon: IconName; text: string } {
  const subject = m.subject.trim() || '(no subject)'
  const fromPerson = m.from.some((a) => a.email.toLowerCase() === person.email?.toLowerCase())
  if (fromPerson) {
    const reply = /^(re|aw|sv):/i.test(subject)
    const clean = subject.replace(/^((re|aw|sv|fwd?):\s*)+/i, '')
    return { icon: 'mail', text: `${reply ? 'Replied to' : 'Emailed'} ${mailbox}: “${clean}”` }
  }
  const sender = m.from[0]?.email ?? mailbox
  return { icon: 'send', text: `${sender} sent “${subject}”` }
}

function dayLabel(iso: string): string {
  const days = (Date.now() - Date.parse(iso)) / 86_400_000
  return days < 1 ? relative(iso) : days < 2 ? 'Yesterday' : shortDate(iso)
}
