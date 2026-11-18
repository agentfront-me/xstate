// Settings → Members: adding someone with their own mailbox, and one member's details (docs/members-plan.md).
//
// Everyone added here gets a personal mailbox and signs in with its primary address. Extra addresses deliver to the
// same mailbox. Without a verified domain there is no mailbox to give, so Add member falls back to a plain email
// invite: they then sign in with their own email.

import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { refreshAccount, type Account } from '../lib/account'
import { copyText, errorMessage, initials, isEmail } from '../lib/core'
import type { Domain } from '../lib/types'
import { Modal } from '../storage/dialogs'
import '../styles/storage.css'
import {
  addMember,
  addMemberAddress,
  deleteMember,
  giveMailbox,
  inviteMember,
  mailboxAccess,
  memberAction,
  removeMemberAddress,
  resendInvite,
  sendPasswordReset,
  setMemberRole,
  setPrimaryAddress,
  setSharedAccess,
  setTemporaryPassword,
  updateMember,
  useMembers,
  type Delivery,
  type OrgMember,
} from './members'

type Role = 'admin' | 'member'

/** What happened to an invite email, shown in the dialog when it didn't go out. */
export function DeliveryNote({ to, delivery }: { to: string; delivery: Delivery }) {
  if (delivery.sent) return null
  return (
    <div className="invite-note" role="status">
      <Icon name="circle-alert" size={14} />
      <span>
        The email to {to} wasn't sent: {delivery.reason ?? 'unknown reason'}.
        {delivery.inviteUrl ? ' Share this link with them instead:' : ' Try sending it again.'}
        {delivery.inviteUrl && (
          <span className="invite-link">
            <code className="ellipsis">{delivery.inviteUrl}</code>
            <button className="btn btn-sm" type="button" onClick={() => void copyText(delivery.inviteUrl!).then((ok) => ok && toast('Link copied'))}>
              Copy
            </button>
          </span>
        )}
      </span>
    </div>
  )
}

const localOf = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '.')

/** Suggests a mailbox name from a full name: "Jordan Lee" → "jordan". */
const suggestLocal = (name: string) => localOf(name.split(/\s+/)[0] ?? '').replace(/[^a-z0-9._-]/g, '')

// ---------------------------------------------------------------------------------------------------------------
// Add member

type Done = { member: OrgMember; delivery: Delivery | null; password?: string; sentTo?: string }

export function AddMemberDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const client = useQueryClient()
  const orgId = account.org.id
  const domains = account.domains.filter((d) => d.status === 'verified' && d.enabled)
  const isAdmin = account.org.role === 'owner' || account.org.role === 'admin'
  const [done, setDone] = useState<Done | null>(null)

  if (done) return <AddedDialog done={done} onClose={onClose} />
  if (!domains.length) return <InviteByEmailDialog orgId={orgId} isAdmin={isAdmin} onClose={onClose} onDone={setDone} />
  return <AddWithMailboxDialog orgId={orgId} domains={domains} isAdmin={isAdmin} onClose={onClose} onDone={setDone} refresh={() => void refreshAccount(client)} />
}

function AddWithMailboxDialog({
  orgId,
  domains,
  isAdmin,
  onClose,
  onDone,
  refresh,
}: {
  orgId: string
  domains: Domain[]
  isAdmin: boolean
  onClose: () => void
  onDone: (d: Done) => void
  refresh: () => void
}) {
  const client = useQueryClient()
  const [name, setName] = useState('')
  const [local, setLocal] = useState('')
  const [localTouched, setLocalTouched] = useState(false)
  const [domainId, setDomainId] = useState(domains[0]!.id)
  const [also, setAlso] = useState<string[]>([])
  const [role, setRole] = useState<Role>('member')
  const [signIn, setSignIn] = useState<'invite' | 'password'>('invite')
  const [recovery, setRecovery] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const localPart = localTouched ? localOf(local) : suggestLocal(name)
  const domainName = (id: string) => domains.find((d) => d.id === id)?.name ?? ''
  const others = domains.filter((d) => d.id !== domainId)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const email = recovery.trim().toLowerCase()
    if (!name.trim()) return setError('Enter their name.')
    if (!localPart) return setError('Enter a mailbox name.')
    if (signIn === 'invite' && !isEmail(email)) return setError('Enter an email they can read now, for the invite.')
    if (signIn === 'password' && email && !isEmail(email)) return setError('Enter a valid secondary email, or leave it empty.')
    setError('')
    setBusy(true)
    try {
      const result = await addMember(client, orgId, {
        name: name.trim(),
        role,
        mailbox: { localPart, domainId },
        alsoAt: also.filter((id) => id !== domainId).map((id) => ({ localPart, domainId: id })),
        signIn,
        ...(email && { recoveryEmail: email }),
      })
      refresh()
      onDone({ member: result.member, delivery: result.email, password: result.password, sentTo: email || undefined })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Add member" onClose={onClose}>
      <form noValidate onSubmit={(e) => void submit(e)}>
        <div className="modal-body member-form">
          <label className="field">
            Full name
            <input className="text-input" autoFocus placeholder="Jordan Lee" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="field">
            <span>Mailbox</span>
            <span className="inline-form">
              <input
                className="text-input"
                aria-label="Mailbox name"
                placeholder="jordan"
                autoComplete="off"
                value={localTouched ? local : localPart}
                onChange={(e) => {
                  setLocalTouched(true)
                  setLocal(e.target.value)
                }}
              />
              <select className="select" aria-label="Domain" value={domainId} onChange={(e) => setDomainId(e.target.value)}>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    @{d.name}
                  </option>
                ))}
              </select>
            </span>
          </div>
          {others.length > 0 && (
            <div className="field">
              <span>Also receive mail at</span>
              <span className="chips">
                {others.map((d) => {
                  const on = also.includes(d.id)
                  return (
                    <button
                      key={d.id}
                      type="button"
                      className="chip"
                      aria-pressed={on}
                      onClick={() => setAlso((list) => (on ? list.filter((x) => x !== d.id) : [...list, d.id]))}
                    >
                      <Icon name={on ? 'check' : 'plus'} size={12} />
                      {localPart || 'name'}@{d.name}
                    </button>
                  )
                })}
              </span>
              <span className="hint">All of these go to one inbox. They sign in with {localPart || 'name'}@{domainName(domainId)}.</span>
            </div>
          )}
          <label className="field">
            Role
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">Member</option>
              {isAdmin && <option value="admin">Admin</option>}
            </select>
          </label>
          <div className="field">
            <span>How they sign in</span>
            <span className="seg" role="group" aria-label="How they sign in">
              <button type="button" aria-pressed={signIn === 'invite'} onClick={() => setSignIn('invite')}>
                Email an invite
              </button>
              <button type="button" aria-pressed={signIn === 'password'} onClick={() => setSignIn('password')}>
                Set temporary password
              </button>
            </span>
            <input
              className="text-input"
              type="email"
              aria-label={signIn === 'invite' ? 'Email to send the invite to' : 'Secondary email'}
              placeholder={signIn === 'invite' ? 'Personal or secondary email' : 'Secondary email for password resets (optional)'}
              value={recovery}
              onChange={(e) => setRecovery(e.target.value)}
            />
            <span className="hint">
              {signIn === 'invite'
                ? 'We send a link to this address so they can choose a password. It is also used for password resets.'
                : "You'll see the password once, after adding them. They choose their own when they first sign in."}
            </span>
          </div>
        </div>
        <div className="modal-foot">
          <span className="err" role="alert">
            {error}
          </span>
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy} aria-busy={busy || undefined}>
              {signIn === 'invite' ? 'Create and send invite' : 'Create mailbox'}
            </button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

/** No verified domain yet: invite by email, as before. They sign in with that email and get no mailbox. */
function InviteByEmailDialog({ orgId, isAdmin, onClose, onDone }: { orgId: string; isAdmin: boolean; onClose: () => void; onDone: (d: Done) => void }) {
  const client = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = email.trim().toLowerCase()
    if (!isEmail(value)) return setError('Enter a valid email address.')
    setError('')
    setBusy(true)
    try {
      const result = await inviteMember(client, orgId, { email: value, role })
      onDone({ member: result.member, delivery: result.email, sentTo: value })
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Add member" onClose={onClose}>
      <form noValidate onSubmit={(e) => void submit(e)}>
        <div className="modal-body member-form">
          <p className="muted">Verify a domain to give members their own mailbox. Until then you can invite people by email: they sign in with it.</p>
          <label className="field">
            Email
            <input className="text-input" type="email" autoFocus placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            Role
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">Member</option>
              {isAdmin && <option value="admin">Admin</option>}
            </select>
          </label>
        </div>
        <div className="modal-foot">
          <span className="err" role="alert">
            {error}
          </span>
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={busy} aria-busy={busy || undefined}>
              Send invite
            </button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

/** After adding: the temporary password (shown once), or whether the invite went out. */
function AddedDialog({ done, onClose }: { done: Done; onClose: () => void }) {
  const who = done.member.name || done.member.email
  return (
    <Modal title={`${who} added`} onClose={onClose}>
      <div className="modal-body member-form">
        {done.password ? (
          <>
            <p className="muted">
              They sign in with <strong>{done.member.email}</strong> and this temporary password, then choose their own. It isn't shown again.
            </p>
            <span className="inline-form">
              <input className="text-input mono" readOnly aria-label="Temporary password" value={done.password} />
              <button className="btn" type="button" onClick={() => void copyText(done.password!).then((ok) => ok && toast('Password copied'))}>
                <Icon name="copy" size={14} />
                Copy
              </button>
            </span>
          </>
        ) : done.delivery?.sent ? (
          <p className="muted">
            We emailed an invite to {done.sentTo}. Once they choose a password they sign in with <strong>{done.member.email}</strong>.
          </p>
        ) : (
          done.delivery && <DeliveryNote to={done.sentTo ?? done.member.email} delivery={done.delivery} />
        )}
      </div>
      <div className="modal-foot">
        <span />
        <button className="btn btn-primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// One member

export function MemberDialog({
  account,
  member: m,
  onClose,
  onRemove,
}: {
  account: Account
  member: OrgMember
  onClose: () => void
  onRemove: (m: OrgMember) => void
}) {
  const client = useQueryClient()
  const orgId = account.org.id
  const manage = account.org.role === 'owner' || account.org.role === 'admin'
  const editable = manage && (m.role !== 'owner' || m.you)
  const invited = m.status === 'invited'
  const label = m.name || m.email
  const domains = account.domains.filter((d) => d.status === 'verified' && d.enabled)
  const [newLocal, setNewLocal] = useState(m.email.split('@')[0] ?? '')
  const [newDomain, setNewDomain] = useState(domains[0]?.id ?? '')
  const [recovery, setRecovery] = useState(m.recoveryEmail ?? '')
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const [reset, setReset] = useState<(Delivery & { to: string }) | null>(null)
  const [busy, setBusy] = useState('')
  // Admins help with someone else's password: never the owner's, and an admin's only by the owner.
  const canHelpPassword = manage && !m.you && m.role !== 'owner' && (m.role !== 'admin' || account.org.role === 'owner')
  // Sign out everywhere and suspend: the same people, but suspending never yourself.
  const canSecure = manage && m.role !== 'owner' && (m.role !== 'admin' || account.org.role === 'owner' || account.org.role === 'admin')
  const suspended = !!m.suspendedAt
  // A temporary password only when their sign-in is an address of their mailbox here, not an email of their own.
  const orgSignIn = m.mailboxes.some((b) => b.addresses.some((a) => a.address === m.email))

  const act = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what)
    try {
      await fn()
      if (done) toast(done)
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy('')
    }
  }

  const recoveryChanged = recovery.trim().toLowerCase() !== (m.recoveryEmail ?? '')

  return (
    <Modal title={label} onClose={onClose}>
      <div className="modal-body member-detail">
        <div className="member-head">
          <span className="avatar md">{initials(label)}</span>
          <div className="text">
            <span className="name ellipsis">
              {label}
              {invited && <span className="tag">Invite pending</span>}
              {suspended && <span className="tag">{m.deleteAfter ? 'Being deleted' : 'Suspended'}</span>}
            </span>
            <span className="sub ellipsis">{m.email}</span>
          </div>
        </div>

        <section>
          <div className="md-row">
            <h3>Role</h3>
            {editable && m.role !== 'owner' ? (
              <select
                className="select sm"
                aria-label="Role"
                value={m.role}
                onChange={(e) => void act('role', () => setMemberRole(client, orgId, m.id, e.target.value as Role), 'Role updated')}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            ) : (
              <span className="muted">{m.role[0]!.toUpperCase() + m.role.slice(1)}</span>
            )}
          </div>
        </section>

        {m.mailboxes.length > 0 && (
          <section>
            <h3>{m.mailboxes.length > 1 ? 'Mailboxes' : 'Addresses'}</h3>
            <p className="hint">
              {m.mailboxes.length > 1
                ? `${m.mailboxes.length} separate mailboxes, each with its own inbox. They sign in with ${m.email}.`
                : 'Mail to any of these arrives in one inbox. They sign in with the primary address and can send from any of them.'}
            </p>
            {m.mailboxes.map((box) => (
              <div className="card" key={box.id}>
                {box.addresses.map((a) => (
                  <div className="card-row address-row" key={a.id}>
                    <Icon name="at-sign" size={14} />
                    <span className="name ellipsis">{a.address}</span>
                    <span className="right">
                      {a.primary ? (
                        m.mailboxes.length === 1 && <span className="tag">Primary</span>
                      ) : (
                        editable && (
                          <>
                            {box.backend === 'store' && (
                              <button
                                className="btn btn-sm btn-quiet"
                                disabled={!!busy}
                                onClick={() => void act('primary', () => setPrimaryAddress(client, orgId, m.id, a.id), `${a.address} is now primary`)}
                              >
                                Make primary
                              </button>
                            )}
                            <button
                              className="x-btn"
                              aria-label={`Remove ${a.address}`}
                              disabled={!!busy}
                              onClick={() => void act('remove-address', () => removeMemberAddress(client, orgId, box.id, a.address), 'Address removed')}
                            >
                              <Icon name="x" size={14} />
                            </button>
                          </>
                        )
                      )}
                    </span>
                  </div>
                ))}
                {manage && <GiveMailbox account={account} member={m} mailboxId={box.id} address={box.addresses.find((a) => a.primary)?.address ?? box.addresses[0]!.address} />}
              </div>
            ))}
            {editable && domains.length > 0 && (
              <form
                className="inline-form"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!localOf(newLocal)) return
                  void act('add-address', () => addMemberAddress(client, orgId, m.mailboxes[0]!.id, { localPart: localOf(newLocal), domainId: newDomain }), 'Address added')
                }}
              >
                <input className="text-input" aria-label="New address" placeholder="name" value={newLocal} onChange={(e) => setNewLocal(e.target.value)} />
                <select className="select" aria-label="Domain for the new address" value={newDomain} onChange={(e) => setNewDomain(e.target.value)}>
                  {domains.map((d) => (
                    <option key={d.id} value={d.id}>
                      @{d.name}
                    </option>
                  ))}
                </select>
                <button className="btn" disabled={busy === 'add-address'}>
                  {m.mailboxes.length > 1 ? `Add to ${m.mailboxes[0]!.addresses[0]!.address.split('@')[0]}@` : 'Add address'}
                </button>
              </form>
            )}
          </section>
        )}

        {(editable || m.you) && (
          <section>
            <h3>Secondary email</h3>
            <p className="hint">Used for invites and password reset links.</p>
            <form
              className="inline-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault()
                const value = recovery.trim().toLowerCase()
                if (value && !isEmail(value)) return toast('Enter a valid email address')
                void act('recovery', () => updateMember(client, orgId, m.id, { recoveryEmail: value || null }), 'Secondary email saved')
              }}
            >
              <input className="text-input" type="email" aria-label="Secondary email" placeholder="name@gmail.com" value={recovery} onChange={(e) => setRecovery(e.target.value)} />
              {recoveryChanged && (
                <button className="btn" disabled={busy === 'recovery'}>
                  Save
                </button>
              )}
            </form>
          </section>
        )}

        {invited && manage && (
          <section>
            <div className="md-row">
              <div>
                <h3>Invite pending</h3>
                <p className="hint">They haven't accepted yet.</p>
              </div>
              <button
                className="btn btn-sm"
                disabled={busy === 'resend'}
                onClick={() =>
                  void act('resend', async () => {
                    const r = await resendInvite(client, orgId, m.id)
                    setDelivery(r.email)
                    if (r.email.sent) toast(`Invite sent to ${m.recoveryEmail ?? m.email}`)
                  })
                }
              >
                <Icon name="send" size={14} />
                {m.invite?.sentAt ? 'Resend invite' : 'Send invite'}
              </button>
            </div>
            {delivery && <DeliveryNote to={m.recoveryEmail ?? m.email} delivery={delivery} />}
          </section>
        )}

        {manage && !m.deleteAfter && <SharedAccessSection account={account} member={m} />}

        {canHelpPassword && (
          <section>
            <h3>Password</h3>
            <p className="hint">
              {orgSignIn ? 'Set a temporary password, or email them a link to choose a new one.' : 'Email them a link to choose a new password.'}
            </p>
            <span className="row-gap">
              {orgSignIn && (
                <button
                  className="btn btn-sm"
                  disabled={!!busy}
                  onClick={() => void act('password', async () => setTempPassword(await setTemporaryPassword(client, orgId, m.id)))}
                >
                  <Icon name="key-round" size={14} />
                  Set temporary password
                </button>
              )}
              {!invited && (
                <button className="btn btn-sm" disabled={!!busy} onClick={() => void act('reset', async () => setReset(await sendPasswordReset(m.id)))}>
                  <Icon name="mail" size={14} />
                  Email reset link
                </button>
              )}
            </span>
            {tempPassword && (
              <>
                <p className="hint">
                  Give them this password. They choose their own when they next sign in. It isn't shown again.
                </p>
                <span className="inline-form">
                  <input className="text-input mono" readOnly aria-label="Temporary password" value={tempPassword} />
                  <button className="btn" type="button" onClick={() => void copyText(tempPassword).then((ok) => ok && toast('Password copied'))}>
                    <Icon name="copy" size={14} />
                    Copy
                  </button>
                </span>
              </>
            )}
            {reset && (reset.sent ? <p className="hint">Reset link sent to {reset.to}. It works for 24 hours.</p> : <DeliveryNote to={reset.to} delivery={reset} />)}
          </section>
        )}

        {(canSecure || m.you) && !invited && (
          <section>
            <h3>Security</h3>
            <div className="md-row">
              <div>
                <span>Signed-in devices</span>
                <p className="hint">Signs {m.you ? 'you' : 'them'} out of xstate on every computer and phone.</p>
              </div>
              <button
                className="btn btn-sm"
                disabled={!!busy}
                onClick={() => void act('sign-out', () => memberAction(client, orgId, m.id, 'sign-out'), m.you ? 'Signed out on every device' : `${label} was signed out everywhere`)}
              >
                <Icon name="monitor" size={14} />
                Sign out everywhere
              </button>
            </div>
          </section>
        )}

        {canSecure && !m.you && !invited && m.deleteAfter && (
          <section>
            <div className="md-row">
              <div>
                <h3 className="danger">Being deleted</h3>
                <p className="hint">
                  Deleted for good on {new Date(m.deleteAfter).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}. Until then you can
                  restore them, with their access and mailbox as they were.
                </p>
              </div>
              <button
                className="btn btn-sm"
                disabled={!!busy}
                onClick={() => void act('restore', () => memberAction(client, orgId, m.id, 'restore'), `${label} is restored`)}
              >
                Restore member
              </button>
            </div>
          </section>
        )}

        {canSecure && !m.you && !invited && !m.deleteAfter && (
          <section>
            <div className="md-row">
              <div>
                <h3>{suspended ? 'Access suspended' : 'Suspend access'}</h3>
                <p className="hint">
                  {suspended
                    ? `Since ${new Date(m.suspendedAt!).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}. Mail to their addresses is still kept.`
                    : 'Blocks sign-in and signs them out of all devices. Mail and data are kept.'}
                </p>
              </div>
              <button
                className="btn btn-sm"
                disabled={!!busy}
                onClick={() =>
                  void act(suspended ? 'restore' : 'suspend', () => memberAction(client, orgId, m.id, suspended ? 'restore' : 'suspend'), suspended ? 'Access restored' : `${label} is suspended`)
                }
              >
                {suspended ? 'Restore access' : 'Suspend access'}
              </button>
            </div>
          </section>
        )}

        {editable && m.role !== 'owner' && invited && (
          <section>
            <div className="md-row">
              <div>
                <h3 className="danger">Cancel invite</h3>
                <p className="hint">Their invite link stops working.</p>
              </div>
              <button className="btn btn-sm danger" onClick={() => onRemove(m)}>
                Cancel invite
              </button>
            </div>
          </section>
        )}

        {canSecure && !m.you && !invited && !m.deleteAfter && <DeleteSection account={account} member={m} />}
      </div>
    </Modal>
  )
}

/** Deleting a member: what happens to their mail, files and agents, then a confirmation. */
function DeleteSection({ account, member: m }: { account: Account; member: OrgMember }) {
  const client = useQueryClient()
  const orgId = account.org.id
  const people = (useMembers(orgId, true).data ?? []).filter((x) => x.id !== m.id && x.status === 'active' && !x.suspendedAt)
  const me = people.find((x) => x.you)
  const label = m.name || m.email
  const boxes = m.mailboxes
  const box = boxes[0]
  // On the current mail server a personal mailbox can't become a shared one.
  const canShare = boxes.length > 0 && boxes.every((b) => b.backend === 'store')
  const [open, setOpen] = useState(false)
  const [mail, setMail] = useState<'shared' | 'delete'>(canShare ? 'shared' : 'delete')
  const [shareWith, setShareWith] = useState<string[]>(me ? [me.id] : [])
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const confirmWord = m.email
  const ready = typed.trim().toLowerCase() === confirmWord.toLowerCase() && (!box || mail === 'delete' || shareWith.length > 0)

  const submit = async () => {
    setBusy(true)
    try {
      await deleteMember(client, orgId, m.id, { mail: box ? mail : 'delete', shareWith: mail === 'shared' ? shareWith : [] })
      toast(`${label} will be deleted in 30 days`)
      setOpen(false)
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <div className="md-row">
        <div>
          <h3 className="danger">Delete member</h3>
          <p className="hint">Signs them out and blocks access now. Deleted for good after 30 days; you can restore them until then.</p>
        </div>
        {!open && (
          <button className="btn btn-sm danger" onClick={() => setOpen(true)}>
            Delete member
          </button>
        )}
      </div>
      {open && (
        <div className="delete-panel">
          {box && (
            <label className="field">
              What should happen to the mail in {boxes.flatMap((b) => b.addresses.map((a) => a.address)).join(', ')}?
              <select className="select" value={mail} onChange={(e) => setMail(e.target.value as 'shared' | 'delete')}>
                {canShare && <option value="shared">{boxes.length > 1 ? 'Turn them into shared mailboxes' : 'Turn it into a shared mailbox'}</option>}
                <option value="delete">Delete all its mail after 30 days</option>
              </select>
            </label>
          )}
          {box && !canShare && <p className="hint">This mailbox is on the current mail server, so it can't become a shared mailbox yet.</p>}
          {box && mail === 'shared' && (
            <div className="field">
              <span>Who can open it (from now on; mail to their addresses keeps arriving)</span>
              <span className="chips">
                {people.map((p) => {
                  const on = shareWith.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="chip"
                      aria-pressed={on}
                      onClick={() => setShareWith((list) => (on ? list.filter((x) => x !== p.id) : [...list, p.id]))}
                    >
                      <Icon name={on ? 'check' : 'plus'} size={12} />
                      {p.name || p.email}
                    </button>
                  )
                })}
              </span>
            </div>
          )}
          <p className="hint">
            Their My Files move into a folder in {me ? 'your' : "the owner's"} My Files. Agents they made are paused now and passed to{' '}
            {me ? 'you' : 'the owner'}. Personal API tokens stop working.
          </p>
          <label className="field">
            Type {confirmWord} to confirm
            <input className="text-input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
          <span className="row-gap">
            <button className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-sm danger" disabled={!ready || busy} aria-busy={busy || undefined} onClick={() => void submit()}>
              Delete member
            </button>
          </span>
        </div>
      )}
    </section>
  )
}

/** The shared mailboxes a member can open, with Full or Read only. Owners and admins open them all anyway. */
function SharedAccessSection({ account, member: m }: { account: Account; member: OrgMember }) {
  const client = useQueryClient()
  const orgId = account.org.id
  const shared = account.mailboxes.filter((mb) => mb.kind === 'shared').sort((a, b) => a.address.localeCompare(b.address))
  const [busy, setBusy] = useState<string | null>(null)
  if (!shared.length) return null

  if (m.role === 'owner' || m.role === 'admin') {
    return (
      <section>
        <h3>Shared mailboxes</h3>
        <p className="hint">{m.role === 'owner' ? 'Owners' : 'Admins'} can open every shared mailbox.</p>
      </section>
    )
  }

  const change = async (mailboxId: string, access: 'full' | 'read' | null) => {
    setBusy(mailboxId)
    try {
      await setSharedAccess(client, orgId, mailboxId, m.id, access)
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section>
      <h3>Shared mailboxes</h3>
      <p className="hint">Full access can read, send and organize. Read only can't change or send anything.</p>
      <div className="shared-list">
        {shared.map((mb) => {
          const current = m.sharedAccess.find((a) => a.mailboxId === mb.id)?.access ?? null
          return (
            <div className="shared-row" key={mb.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!current}
                  disabled={busy === mb.id}
                  onChange={(e) => void change(mb.id, e.target.checked ? 'full' : null)}
                />
                <span className="ellipsis">{mb.displayName || mb.address.split('@')[0]}</span>
              </label>
              <span className="muted ellipsis">{mb.address}</span>
              {current && (
                <select
                  className="select sm"
                  aria-label={`Access to ${mb.address}`}
                  value={current}
                  disabled={busy === mb.id}
                  onChange={(e) => void change(mb.id, e.target.value as 'full' | 'read')}
                >
                  <option value="full">Full</option>
                  <option value="read">Read only</option>
                </select>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** Gives one of a member's personal mailboxes, with all its mail, to someone else in the organization. */
function GiveMailbox({ account, member: m, mailboxId, address }: { account: Account; member: OrgMember; mailboxId: string; address: string }) {
  const client = useQueryClient()
  const orgId = account.org.id
  const people = (useMembers(orgId, true).data ?? []).filter((x) => x.id !== m.id && !x.deleteAfter)
  const [open, setOpen] = useState(false)
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  if (!people.length) return null

  const give = async () => {
    const person = people.find((p) => p.id === to)
    if (!person) return
    const who = person.name || person.email
    if (!confirm(`Give ${address} and all its mail to ${who}? ${who} becomes its owner and can read everything in it. ${m.name || m.email} loses access.`)) return
    setBusy(true)
    try {
      await giveMailbox(client, orgId, mailboxId, person.id)
      void refreshAccount(client)
      toast(`${address} now belongs to ${who}`)
      setOpen(false)
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card-row give-row">
      {open ? (
        <>
          <select className="select sm" aria-label={`Give ${address} to`} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Give {address} to…</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.email}
                {p.status === 'invited' ? ' (invited)' : ''}
              </option>
            ))}
          </select>
          <span className="row-gap">
            <button className="btn btn-sm btn-quiet" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-sm" disabled={!to || busy} aria-busy={busy || undefined} onClick={() => void give()}>
              Give mailbox
            </button>
          </span>
        </>
      ) : (
        <button className="text-btn" onClick={() => setOpen(true)}>
          Give this mailbox to someone else…
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Shared mailboxes (on the Members page)

const accessKey = (mailboxId: string) => ['mailbox-access', mailboxId] as const

/** The organization's shared mailboxes and how many people can open each; opening one manages who. */
export function SharedMailboxesSection({ account }: { account: Account }) {
  const shared = account.mailboxes.filter((mb) => mb.kind === 'shared').sort((a, b) => a.address.localeCompare(b.address))
  const access = useQueries({ queries: shared.map((mb) => ({ queryKey: accessKey(mb.id), queryFn: () => mailboxAccess(mb.id) })) })
  const [openId, setOpenId] = useState<string | null>(null)
  const open = shared.find((mb) => mb.id === openId)
  const manage = account.org.role === 'owner' || account.org.role === 'admin'

  return (
    <div className="group">
      <div className="group-head">
        <div className="text">
          <h2>Shared mailboxes</h2>
          <p>One address that several members read and reply from. Owners and admins can open all of them. Add one from Domains.</p>
        </div>
      </div>
      <div className="card">
        {shared.length === 0 && (
          <div className="card-row">
            <span className="muted">No shared mailboxes yet.</span>
          </div>
        )}
        {shared.map((mb, i) => {
          const n = access[i]?.data?.length
          return (
            <button className="card-row member-row" key={mb.id} onClick={() => setOpenId(mb.id)}>
              <span className="avatar md">
                <Icon name="inbox" size={14} />
              </span>
              <div className="text">
                <span className="name ellipsis">{mb.displayName || mb.address.split('@')[0]}</span>
                <span className="sub ellipsis">{mb.address}</span>
              </div>
              <span className="right">
                <span className="muted">{n === undefined ? '' : n === 0 ? 'Only admins' : `${n} ${n === 1 ? 'member' : 'members'}`}</span>
                <Icon name="chevron-right" size={14} />
              </span>
            </button>
          )
        })}
      </div>
      {open && <SharedMailboxDialog account={account} mailbox={open} manage={manage} onClose={() => setOpenId(null)} />}
    </div>
  )
}

function SharedMailboxDialog({
  account,
  mailbox,
  manage,
  onClose,
}: {
  account: Account
  mailbox: { id: string; address: string; displayName?: string | null }
  manage: boolean
  onClose: () => void
}) {
  const client = useQueryClient()
  const orgId = account.org.id
  const access = useQuery({ queryKey: accessKey(mailbox.id), queryFn: () => mailboxAccess(mailbox.id) })
  const people = (useMembers(orgId, true).data ?? []).filter((p) => p.role === 'member' && !p.deleteAfter)
  const [busy, setBusy] = useState<string | null>(null)

  const change = async (memberId: string, level: 'full' | 'read' | null) => {
    setBusy(memberId)
    try {
      await setSharedAccess(client, orgId, mailbox.id, memberId, level)
      await client.invalidateQueries({ queryKey: accessKey(mailbox.id) })
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal title={mailbox.displayName || mailbox.address} onClose={onClose}>
      <div className="modal-body member-detail">
        <div className="member-head">
          <span className="avatar md">
            <Icon name="inbox" size={14} />
          </span>
          <div className="text">
            <span className="name ellipsis">{mailbox.displayName || mailbox.address.split('@')[0]}</span>
            <span className="sub ellipsis">{mailbox.address}</span>
          </div>
        </div>
        <section>
          <h3>Who can open it</h3>
          <p className="hint">Owners and admins can always open it. Full access can read, send and organize; Read only can't change or send anything.</p>
          {people.length === 0 ? (
            <p className="hint">Everyone in the organization is an owner or admin.</p>
          ) : (
            <div className="shared-list">
              {people.map((p) => {
                const current = access.data?.find((a) => a.memberId === p.id)?.access ?? null
                const level = current === 'owner' ? null : current
                return (
                  <div className="shared-row" key={p.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={!!level}
                        disabled={!manage || busy === p.id || !access.data}
                        onChange={(e) => void change(p.id, e.target.checked ? 'full' : null)}
                      />
                      <span className="ellipsis">{p.name || p.email}</span>
                    </label>
                    <span className="muted ellipsis">{p.status === 'invited' ? 'Invited' : p.email}</span>
                    {level && (
                      <select
                        className="select sm"
                        aria-label={`Access for ${p.name || p.email}`}
                        value={level}
                        disabled={!manage || busy === p.id}
                        onChange={(e) => void change(p.id, e.target.value as 'full' | 'read')}
                      >
                        <option value="full">Full</option>
                        <option value="read">Read only</option>
                      </select>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </Modal>
  )
}
