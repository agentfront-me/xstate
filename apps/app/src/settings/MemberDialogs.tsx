// Settings → Members: adding someone with their own mailbox, and one member's details (docs/members-plan.md).
//
// Everyone added here gets a personal mailbox and signs in with its primary address. Extra addresses deliver to the
// same mailbox. Without a verified domain there is no mailbox to give, so Add member falls back to a plain email
// invite: they then sign in with their own email.

import { useQueryClient } from '@tanstack/react-query'
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
  inviteMember,
  memberAction,
  removeMemberAddress,
  resendInvite,
  sendPasswordReset,
  setMemberRole,
  setPrimaryAddress,
  setTemporaryPassword,
  updateMember,
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
  const orgSignIn = !!m.mailbox?.addresses.some((a) => a.address === m.email)

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

  const box = m.mailbox
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
              {suspended && <span className="tag">Suspended</span>}
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

        {box && (
          <section>
            <h3>Addresses</h3>
            <p className="hint">Mail to any of these arrives in one inbox. They sign in with the primary address and can send from any of them.</p>
            <div className="card">
              {box.addresses.map((a) => (
                <div className="card-row address-row" key={a.id}>
                  <Icon name="at-sign" size={14} />
                  <span className="name ellipsis">{a.address}</span>
                  <span className="right">
                    {a.primary ? (
                      <span className="tag">Primary</span>
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
            </div>
            {editable && domains.length > 0 && (
              <form
                className="inline-form"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!localOf(newLocal)) return
                  void act('add-address', () => addMemberAddress(client, orgId, box.id, { localPart: localOf(newLocal), domainId: newDomain }), 'Address added')
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
                  Add address
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

        {canSecure && !m.you && !invited && (
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

        {editable && m.role !== 'owner' && (
          <section>
            <div className="md-row">
              <div>
                <h3 className="danger">{invited ? 'Cancel invite' : 'Remove member'}</h3>
                <p className="hint">{invited ? 'Their invite link stops working.' : 'They lose access right away.'}</p>
              </div>
              <button className="btn btn-sm danger" onClick={() => onRemove(m)}>
                {invited ? 'Cancel invite' : 'Remove member'}
              </button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}
