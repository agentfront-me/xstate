// 4 · Set up your team: your own mailbox, teammates invited with their own mailboxes, and shared mailboxes.
//
// The same pieces as Settings → Members (docs/members-plan.md), cut down for a first visit: one domain, invites only
// (a temporary password is shown once, which doesn't suit a list; Settings → Members offers it), and every teammate
// added here gets Full access to every shared mailbox. Each mailbox counts toward the plan's mailbox limit
// (docs/pricing-plan.md §1), so the step shows the count and stops before the API would refuse.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { api, errorMessage, initials, isEmail } from '../lib/core'
import { isLocalPart, localOf, localPartFromName } from '../lib/local-part'
import type { Mailbox } from '../lib/types'
import { fetchMembers, postMember, putSharedAccess, type Delivery, type OrgMember } from '../settings/members'
import { domainName, type Data } from './state'
import { Back, Head, Help, useCopied, usePending, type Message } from './ui'

const SHARED_SUGGESTIONS = ['hello', 'support', 'sales']

type Role = 'admin' | 'member'

/** A teammate: being typed (no `member`), or added (in this visit or before). */
type Person = {
  key: number
  name: string
  local: string
  localTouched: boolean
  email: string
  role: Role
  member?: OrgMember
  /** Whether the invite went out, for someone added in this visit. */
  delivery?: Delivery | null
}

type Shared = { key: number; local: string; mailbox?: Mailbox; removable?: boolean }

/** The plan's room for mailboxes, as the API counts it (limits/rules.ts ceiling: 10% over, rounded down). */
type Room = { used: number; limit: number | null }

type Usage = { usage: { limits: { mailboxes: number | null }; mailboxes: number } }

let nextKey = 0

/** 'Asif Khan' → 'asif'. Falls back to the sign-in email's local part. */
export function suggestedLocalPart(data: Data): string {
  const fromName = localPartFromName(data.user.name)
  if (isLocalPart(fromName)) return fromName
  return localPartFromName(data.user.email.split('@')[0]) || 'me'
}

const localOfPerson = (p: Person) => (p.localTouched ? localOf(p.local) : localPartFromName(p.name))
const isBlank = (p: Person) => !p.member && !p.name.trim() && !p.email.trim() && !(p.localTouched && p.local.trim())
const addressOf = (m: OrgMember) => m.mailbox?.addresses[0]?.address ?? m.email

/** An invite that didn't go out: why, and the link to pass on another way when the API gave one. */
function Unsent({ delivery }: { delivery: Delivery }) {
  const [copied, copy] = useCopied()
  const why = `Invite not sent${delivery.reason ? `: ${delivery.reason.replace(/\.$/, '')}` : ''}.`
  if (!delivery.inviteUrl) return <span className="small muted">{why} Resend it from Settings → Members.</span>
  return (
    <>
      <span className="small muted">{why} Share this link with them instead:</span>
      <span className="invite-link">
        <code className="ellipsis">{delivery.inviteUrl}</code>
        <button type="button" className="copy" onClick={() => void copy(delivery.inviteUrl!)} aria-label="Copy invite link">
          <Icon name={copied ? 'check' : 'copy'} size={13} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </>
  )
}

export function TeamStep({ data, update, back, next }: { data: Data; update: (patch: Partial<Data>) => void; back: () => void; next: () => void }) {
  const domain = domainName(data)
  const orgId = data.org.id
  const [loaded, setLoaded] = useState(false)
  const [own, setOwn] = useState<{ local: string; mailbox?: Mailbox }>({ local: suggestedLocalPart(data) })
  const [people, setPeople] = useState<Person[]>([])
  const [shared, setShared] = useState<Shared[]>([])
  const [room, setRoom] = useState<Room | null>(null)
  const [help, setHelp] = useState<Message>(null)
  const [pending, run] = usePending()
  const [focusKey, setFocusKey] = useState<number | null>(null)
  const inputs = useRef(new Map<number, HTMLInputElement>())
  // Whether anything existed when the step opened decides the button label.
  const [hadExisting] = useState(() => data.mailboxes.length > 0)

  // What already exists: your mailbox, teammates and shared mailboxes from an earlier visit, and the plan's room.
  useEffect(() => {
    let live = true
    void (async () => {
      const [members, usage] = await Promise.all([
        fetchMembers(orgId).catch(() => [] as OrgMember[]),
        api<Usage>('GET', `/orgs/${orgId}/billing/usage`).catch(() => null),
      ])
      if (!live) return
      const ownIds = new Set(members.find((m) => m.you)?.mailboxes.map((mb) => mb.id))
      const mine = data.mailboxes.find((mb) => ownIds.has(mb.id))
      if (mine) setOwn({ local: mine.address.split('@')[0]!, mailbox: mine })
      const others = members.filter((m) => !m.you && !m.deleteAfter)
      setPeople(others.map((m) => ({ key: nextKey++, name: m.name ?? '', local: '', localTouched: false, email: '', role: m.role === 'admin' ? 'admin' : 'member', member: m })))
      const existingShared = data.mailboxes.filter((mb) => mb.kind === 'shared')
      setShared(
        existingShared.length || data.mailboxes.length
          ? existingShared.map((mb) => ({ key: nextKey++, local: mb.address.split('@')[0]!, mailbox: mb }))
          : // A first visit: hello@ pre-selected.
            [{ key: nextKey++, local: 'hello', removable: true }],
      )
      if (usage) setRoom({ used: usage.usage.mailboxes, limit: usage.usage.limits.mailboxes })
      update({ teammates: others.length })
      setLoaded(true)
    })()
    return () => {
      live = false
    }
    // Loaded once, when the step opens.
  }, [])

  useEffect(() => {
    if (focusKey === null) return
    inputs.current.get(focusKey)?.focus()
    setFocusKey(null)
  }, [focusKey])

  const ref = (key: number) => (el: HTMLInputElement | null) => {
    if (el) inputs.current.set(key, el)
    else inputs.current.delete(key)
  }

  const changePerson = (key: number, patch: Partial<Person>) => setPeople((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)))

  const addPerson = () => {
    setHelp(null)
    const key = nextKey++
    setPeople((list) => [...list, { key, name: '', local: '', localTouched: false, email: '', role: 'member' }])
    setFocusKey(key)
  }

  const toggleChip = (local: string) => {
    setHelp(null)
    const at = shared.findIndex((s) => s.local === local)
    if (at === -1) setShared([...shared, { key: nextKey++, local, removable: true }])
    else if (!shared[at]!.mailbox) setShared(shared.filter((_, i) => i !== at))
  }

  const addCustom = () => {
    setHelp(null)
    const key = nextKey++
    setShared([...shared, { key, local: '', removable: true }])
    setFocusKey(key)
  }

  // Mailboxes this click would create, for the plan count and the button.
  const newPeople = people.filter((p) => !p.member && !isBlank(p))
  const newShared = shared.filter((s) => !s.mailbox && s.local.trim())
  const toCreate = (own.mailbox ? 0 : 1) + newPeople.length + newShared.length
  const allowed = room?.limit == null ? null : Math.floor(room.limit * 1.1)

  const create = () =>
    run(async () => {
      // Tidy and check everything before creating anything.
      const ownLocal = localOf(own.local)
      const drafts = people.filter((p) => !p.member && !isBlank(p))
      setPeople((list) => list.filter((p) => p.member || !isBlank(p)))
      const sharedList = shared.filter((s) => s.mailbox || s.local.trim()).map((s) => (s.mailbox ? s : { ...s, local: localOf(s.local) }))
      setShared(sharedList)

      if (!own.mailbox && !isLocalPart(ownLocal)) return setHelp({ text: `${ownLocal || 'Your address'}@ can only use letters, numbers, dots, dashes and underscores.` })
      for (const p of drafts) {
        const who = p.name.trim()
        if (!who) return setHelp({ text: 'Enter a name for each teammate, or remove the empty row.' })
        const local = localOfPerson(p)
        if (!isLocalPart(local)) return setHelp({ text: `${who}: ${local || 'the mailbox name'}@ can only use letters, numbers, dots, dashes and underscores.` })
        const email = p.email.trim().toLowerCase()
        if (!isEmail(email)) return setHelp({ text: `${who}: enter an email they can read now, for the invite.` })
        if (email.endsWith(`@${domain}`)) return setHelp({ text: `${who}: use an email they can already read, not one on ${domain}.` })
      }
      const bad = sharedList.find((s) => !s.mailbox && !isLocalPart(s.local))
      if (bad) return setHelp({ text: `${bad.local}@ can only use letters, numbers, dots, dashes and underscores.` })
      const taken = [
        own.mailbox?.address.split('@')[0] ?? ownLocal,
        ...people.filter((p) => p.member).map((p) => addressOf(p.member!).split('@')[0]!),
        ...drafts.map(localOfPerson),
        ...sharedList.map((s) => s.local),
      ]
      const dup = taken.find((l, i) => taken.indexOf(l) !== i)
      if (dup) return setHelp({ text: `${dup}@${domain} is in the list twice.` })
      const creating = (own.mailbox ? 0 : 1) + drafts.length + sharedList.filter((s) => !s.mailbox).length
      if (room && allowed !== null && room.used + creating > allowed) {
        return setHelp({
          text: `Your plan includes ${room.limit} mailboxes, personal and shared together, and this would make ${room.used + creating}. Remove ${room.used + creating - allowed}, or upgrade later in Settings → Billing.`,
        })
      }
      setHelp(null)

      let mailboxes = [...data.mailboxes]
      const counted = () => setRoom((r) => (r ? { ...r, used: r.used + 1 } : r))
      const fail = (address: string, err: unknown) => {
        const message = errorMessage(err)
        setHelp({ text: message.includes(address) ? message : `${address}: ${message}` })
      }

      // 1. Your mailbox, first in the list so the next steps show your address.
      if (!own.mailbox) {
        try {
          const { mailbox } = await api<{ mailbox: Mailbox }>('POST', `/email/domains/${data.domain!.id}/mailboxes`, {
            kind: 'personal',
            localPart: ownLocal,
            ownerMemberId: data.org.memberId,
            displayName: data.user.name,
          })
          mailboxes = [mailbox, ...mailboxes]
          update({ mailboxes })
          setOwn({ local: ownLocal, mailbox })
          counted()
        } catch (err) {
          return fail(`${ownLocal}@${domain}`, err)
        }
      }

      // 2. Shared mailboxes.
      const sharedNow: Mailbox[] = sharedList.flatMap((s) => (s.mailbox ? [s.mailbox] : []))
      const sharedNew = new Set<string>()
      for (const s of sharedList.filter((x) => !x.mailbox)) {
        try {
          const { mailbox } = await api<{ mailbox: Mailbox }>('POST', `/email/domains/${data.domain!.id}/mailboxes`, { kind: 'shared', localPart: s.local })
          mailboxes = [...mailboxes, mailbox]
          update({ mailboxes })
          sharedNow.push(mailbox)
          sharedNew.add(mailbox.id)
          setShared((list) => list.map((x) => (x.key === s.key ? { ...x, mailbox } : x)))
          counted()
        } catch (err) {
          return fail(`${s.local}@${domain}`, err)
        }
      }

      // 3. Teammates, each with their own mailbox and an invite.
      const added: OrgMember[] = []
      let unsentNow = 0
      for (const p of drafts) {
        const local = localOfPerson(p)
        try {
          const result = await postMember(orgId, {
            name: p.name.trim(),
            role: p.role,
            mailbox: { localPart: local, domainId: data.domain!.id },
            alsoAt: [],
            signIn: 'invite',
            recoveryEmail: p.email.trim().toLowerCase(),
          })
          added.push(result.member)
          const box = result.member.mailbox
          if (box) mailboxes = [...mailboxes, { id: box.id, kind: 'personal', address: addressOf(result.member), domainId: data.domain!.id, displayName: result.member.name }]
          update({ mailboxes })
          changePerson(p.key, { member: result.member, delivery: result.email })
          if (result.email && !result.email.sent) unsentNow++
          counted()
        } catch (err) {
          return fail(`${local}@${domain}`, err)
        }
      }
      const teammates = people.filter((p) => p.member).length + added.length
      update({ teammates })

      // 4. Shared mailbox access: every new pair of a teammate (role member; admins open every shared mailbox) and
      // a shared mailbox gets Full access.
      const everyone = [...people.flatMap((p) => (p.member ? [p.member] : [])), ...added]
      const isNew = new Set(added.map((m) => m.id))
      for (const m of everyone.filter((x) => x.role === 'member')) {
        for (const mb of sharedNow) {
          if (!isNew.has(m.id) && !sharedNew.has(mb.id)) continue
          try {
            await putSharedAccess(mb.id, m.id, 'full')
          } catch (err) {
            return setHelp({ text: `${m.name ?? m.email} couldn't be given ${mb.address}: ${errorMessage(err)} You can set it in Settings → Members.` })
          }
        }
      }

      // Invites that didn't go out: say so here rather than move on. Each row says why; Continue moves on.
      if (unsentNow) {
        return setHelp({ text: `${unsentNow === 1 ? 'One invite' : `${unsentNow} invites`} couldn't be sent. Their mailboxes are ready: share the link on their row, or resend from Settings → Members.` })
      }
      next()
    })

  // An invite that didn't go out keeps the person on this step, with the reason on their row.
  const unsent = people.filter((p) => p.delivery && !p.delivery.sent)
  const label = !loaded
    ? 'Create inbox'
    : toCreate === 0
      ? hadExisting || unsent.length
        ? 'Continue'
        : 'Create inbox'
      : newPeople.length
        ? `Create mailboxes and send ${newPeople.length} ${newPeople.length === 1 ? 'invite' : 'invites'}`
        : toCreate === 1 && !own.mailbox
          ? 'Create inbox'
          : 'Create mailboxes'

  return (
    <>
      <Back onClick={back} />
      <Head title="Set up your team" sub="Create your mailbox, invite the people you work with, and add shared inboxes. You can change all of this later in Settings." />

      <section className="stack-8" aria-labelledby="own-label">
        <div className="section-label" id="own-label">
          Your mailbox
        </div>
        <div className="addr">
          <input
            value={own.local}
            aria-label="Your address name"
            autoCapitalize="off"
            spellCheck={false}
            readOnly={!!own.mailbox}
            onChange={(event) => setOwn({ local: event.target.value })}
          />
          <span className="at">@{domain}</span>
          {own.mailbox ? (
            <span className="done" title="Created">
              <Icon name="check" size={14} />
            </span>
          ) : (
            <span className="addr-note">You</span>
          )}
        </div>
      </section>

      <section className="stack-8" aria-labelledby="team-label">
        <div className="section-label" id="team-label">
          Team members
          <span className="dim"> · each gets their own mailbox and an invite</span>
        </div>
        {people.map((p) =>
          p.member ? (
            <div className="person-done" key={p.key}>
              <span className="avatar">{initials(p.member.name || p.member.email)}</span>
              <span className="text">
                <span className="hi ellipsis">{p.member.name || p.member.email}</span>
                <span className="small muted ellipsis">
                  {addressOf(p.member)}
                  {p.delivery && !p.delivery.sent
                    ? ''
                    : p.member.status !== 'invited'
                      ? ''
                      : p.member.invite?.sentAt
                        ? ' · invite sent'
                        : ' · invite not sent yet. Send it from Settings → Members.'}
                </span>
                {p.delivery && !p.delivery.sent && <Unsent delivery={p.delivery} />}
              </span>
              <span className="small muted">{p.member.role === 'admin' ? 'Admin' : 'Member'}</span>
            </div>
          ) : (
            <div className="person" key={p.key}>
              <div className="person-row">
                <div className="input on-panel">
                  <input ref={ref(p.key)} placeholder="Full name" aria-label="Full name" value={p.name} onChange={(e) => changePerson(p.key, { name: e.target.value })} />
                </div>
                <select className="select" aria-label="Role" value={p.role} onChange={(e) => changePerson(p.key, { role: e.target.value as Role })}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button type="button" className="remove" aria-label={`Remove ${p.name || 'this teammate'}`} onClick={() => {
                    setHelp(null)
                    setPeople((list) => list.filter((x) => x.key !== p.key))
                  }}>
                  <Icon name="x" size={14} />
                </button>
              </div>
              <div className="addr">
                <input
                  value={p.localTouched ? p.local : localOfPerson(p)}
                  placeholder="name"
                  aria-label="Mailbox name"
                  autoCapitalize="off"
                  spellCheck={false}
                  onChange={(e) => changePerson(p.key, { local: e.target.value, localTouched: true })}
                />
                <span className="at">@{domain}</span>
              </div>
              <div className="input on-panel">
                <input type="email" placeholder="Personal email for the invite" aria-label="Email to send the invite to" value={p.email} onChange={(e) => changePerson(p.key, { email: e.target.value })} />
              </div>
            </div>
          ),
        )}
        <button type="button" className="addr-add" id="add-person" onClick={addPerson} disabled={!loaded}>
          <Icon name="user-plus" size={14} />
          Add a team member
        </button>
      </section>

      <section className="stack-8" aria-labelledby="shared-label">
        <div className="section-label" id="shared-label">
          Shared mailboxes
          <span className="dim"> · everyone added here can open them</span>
        </div>
        {shared.map((s, i) => (
          <div className="addr" key={s.key}>
            <input
              ref={ref(s.key)}
              value={s.local}
              aria-label="Shared mailbox name"
              autoCapitalize="off"
              spellCheck={false}
              readOnly={!!s.mailbox}
              onChange={(event) => setShared(shared.map((x, j) => (j === i ? { ...x, local: event.target.value } : x)))}
            />
            <span className="at">@{domain}</span>
            {s.mailbox && (
              <span className="done" title="Created">
                <Icon name="check" size={14} />
              </span>
            )}
            {s.removable && !s.mailbox && (
              <button type="button" className="remove" aria-label={`Remove ${s.local}@`} onClick={() => {
                  setHelp(null)
                  setShared(shared.filter((_, j) => j !== i))
                }}>
                <Icon name="x" size={14} />
              </button>
            )}
          </div>
        ))}
        <div className="chips" id="chips">
          {SHARED_SUGGESTIONS.map((local) => {
            const on = shared.some((s) => s.local === local)
            return (
              <button type="button" className="chip" key={local} aria-pressed={on} onClick={() => toggleChip(local)}>
                <Icon name={on ? 'check' : 'plus'} size={12} />
                {local}@
              </button>
            )
          })}
          <button type="button" className="chip" id="custom" onClick={addCustom}>
            <Icon name="plus" size={12} />
            Custom
          </button>
        </div>
      </section>

      <Help id="team-help" message={help} />
      {room && allowed !== null && (
        <div className={`small ${room.used + toCreate > allowed ? 'hi' : 'dim'}`} id="mailbox-count">
          {room.used + toCreate} of {room.limit} mailboxes on your plan, personal and shared together.
        </div>
      )}
      <button className="btn btn-primary" id="create" disabled={pending || !loaded} aria-busy={pending || undefined} onClick={() => void (toCreate === 0 && loaded ? next() : create())}>
        {label}
      </button>
      <div className="small dim center">
        {data.domain?.status === 'verified' ? 'You can add more anytime in Settings → Members.' : `Mail to these addresses starts arriving once ${domain} is verified.`}
      </div>
    </>
  )
}
