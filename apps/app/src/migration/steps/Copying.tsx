// 5 · Copying: hours to days. A persistent banner says mail still arrives in Google. Each row shows Mail, Contacts
// and Drive separately, so one stalled part doesn't hide the others. States: running, paused, Google access
// removed (everything paused, with how to reconnect), one user needing attention, and the welcome-back note.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import { errorMessage, initials } from '../../lib/core'
import * as migrationApi from '../api'
import type { Ctx } from '../main'
import type { CopyStatus, UserProgress } from '../types'
import { Bar, bytes, day, Dialog, duration, Notice, PartCell, plural, StateChip, time, Title, useTick } from '../ui'

const PREVIEW_ROWS = 6

export function CopyingStep({ ctx }: { ctx: Ctx }) {
  const orgId = ctx.org.id
  const [status, setStatus] = useState<CopyStatus | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [welcome, setWelcome] = useState(() => Date.now() - Date.parse(ctx.migration.lastSeenAt) > 30 * 60_000)
  const [banner, setBanner] = useState<HTMLElement | null>(null)
  const tick = useTick(2000)

  useEffect(() => setBanner(document.getElementById('banner-slot')), [])

  useEffect(() => {
    let live = true
    void migrationApi.copyStatus(orgId).then((s) => live && setStatus(s))
    return () => {
      live = false
    }
  }, [orgId, tick])

  // Everything copied: the next step is the switch.
  useEffect(() => {
    if (status?.finished) void ctx.go('switch')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.finished])

  const act = async (name: string, work: () => Promise<unknown>) => {
    setBusy(name)
    setError('')
    try {
      await work()
      setStatus(await migrationApi.copyStatus(orgId))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  if (!status) return <div className="loading"><span className="spinner" /></div>

  const total = status.users.length
  const copying = status.users.filter((u) => u.state === 'copying' || u.state === 'slowed').length
  const attention = status.users.filter((u) => u.state === 'attention').length
  const waiting = status.users.filter((u) => u.state === 'waiting').length
  const paused = status.users.filter((u) => u.state === 'paused').length
  // Rows that need a look come first, then the ones moving, then done, then waiting.
  const order = { attention: 0, slowed: 1, copying: 2, paused: 3, done: 4, waiting: 5 } as const
  const rows = [...status.users].sort((a, b) => order[a.state] - order[b.state])
  const shown = showAll ? rows : rows.slice(0, PREVIEW_ROWS)
  const admin = ctx.isAdmin
  const startedBy = ctx.migration.startedBy

  const title = status.accessLost ? 'Paused: Google access removed' : status.paused ? 'Copying is paused' : 'Copying from Google'
  const sub = status.accessLost
    ? `${status.doneUsers} of ${total} users done · ${status.percent}%. Copying stopped at ${time(status.pausedAt!)} and will resume as soon as access is restored.`
    : status.paused
      ? `${status.doneUsers} of ${total} users done · ${status.percent}%. Nothing is being read from Google until you resume.`
      : `${status.doneUsers} of ${total} users done · ${status.percent}% · ${duration(status.remaining)} left. Google limits read speed, so large mailboxes take longest.`

  return (
    <>
      {banner &&
        createPortal(
          status.accessLost ? (
            <div className="page-banner is-error">
              <Icon name="shield-alert" size={14} />
              <span>Copying is paused: xstate can no longer read from Google Workspace. Restore access to continue.</span>
              {admin && (
                <button className="mini" disabled={!!busy} onClick={() => void act('access', () => migrationApi.checkAccess(orgId))}>
                  Check access again
                </button>
              )}
            </div>
          ) : (
            <div className="page-banner">
              <Icon name="info" size={14} />
              <span>Mail still arrives in Google until you switch. Don't send from xstate yet.</span>
            </div>
          ),
          banner,
        )}

      {welcome && !status.accessLost && (
        <Notice icon="history" action={<button className="text-btn" onClick={() => setWelcome(false)}>Dismiss</button>}>
          Welcome back. Copying kept running since you left on {day(ctx.migration.lastSeenAt)}. {status.doneUsers} of {total} users are done.
        </Notice>
      )}

      <Title
        title={title}
        sub={sub}
        aside={
          admin && (
            <>
              {status.paused ? (
                <button className="btn btn-auto btn-sm" disabled={!!busy} onClick={() => void act('resume', () => migrationApi.resume(orgId))}>
                  <Icon name="chevron-right" size={13} />
                  Resume
                </button>
              ) : (
                <button className="btn btn-auto btn-sm" disabled={!!busy || status.accessLost} onClick={() => void act('pause', () => migrationApi.pause(orgId))}>
                  <Icon name="minus" size={13} />
                  Pause
                </button>
              )}
              <button className="btn btn-auto btn-sm" disabled={!!busy} onClick={() => setConfirmCancel(true)}>
                Cancel
              </button>
            </>
          )
        }
      />
      <div className="overall">
        <Bar value={status.percent} />
        <span className="small hi">{status.percent}%</span>
      </div>

      {status.accessLost && (
        <div className="causes is-error" role="alert">
          <div className="causes-head">
            <Icon name="shield-alert" size={14} />
            Google stopped accepting xstate's access at {time(status.pausedAt!)} today. All users are paused. Nothing already copied is lost.
          </div>
          <p>
            Usually the delegation entry was removed, or the admin account <code>{ctx.migration.connection?.adminEmail}</code> was suspended or lost
            super admin. Restore the entry under Security → API controls → Domain-wide delegation (Client ID {migrationApi.CLIENT_ID.slice(0, 6)}…
            {migrationApi.CLIENT_ID.slice(-4)}), or verify with a different admin.
          </p>
          {admin && (
            <div className="actions">
              <button className="btn btn-primary btn-auto btn-sm" disabled={!!busy} aria-busy={busy === 'access' || undefined} onClick={() => void act('access', () => migrationApi.checkAccess(orgId))}>
                {busy === 'access' && <span className="spinner spinner-on-primary" />}
                Check access again
              </button>
              <button className="btn btn-auto btn-sm" onClick={() => void ctx.go('connect')}>
                Verify with another admin
              </button>
              <span className="muted small">Copying resumes where it stopped.</span>
            </div>
          )}
        </div>
      )}

      {error && <Notice kind="error">{error}</Notice>}

      <div className="table copy-table">
        <div className="tr th" role="row">
          <span>User</span>
          <span>Mail</span>
          <span>Contacts</span>
          <span>Drive</span>
          <span>State</span>
        </div>
        {shown.map((p) => (
          <UserRow key={p.user.id} p={p} admin={admin} busy={!!busy} onFix={(fix) => void act('fix', () => migrationApi.fixQuota(orgId, fix, p.user.id))} />
        ))}
        <div className="tfoot">
          <span className="muted small">
            Showing {shown.length} of {total} · {status.doneUsers} done
            {copying ? `, ${copying} copying` : ''}
            {attention ? `, ${attention} needs attention` : ''}
            {paused ? `, ${paused} paused` : ''}
            {waiting ? `, ${waiting} waiting` : ''}
          </span>
          {!showAll && total > PREVIEW_ROWS && (
            <button className="text-btn" onClick={() => setShowAll(true)}>
              Show all {total}
            </button>
          )}
        </div>
      </div>

      <p className="foot-note">
        <Icon name="mail" size={13} />
        {status.accessLost
          ? `We emailed ${startedBy.email} about this at ${time(status.pausedAt!)}. We'll email again when copying resumes.`
          : `You can close this page. We'll email ${startedBy.email} when everything is copied, and right away if anything needs attention.`}
      </p>
      <p className="foot-note">
        <Icon name="lock" size={13} />
        Only organization admins can pause, cancel or fix issues. {startedBy.name} ({startedBy.email}) started this migration.
      </p>

      {confirmCancel && (
        <Dialog
          title="Cancel the migration?"
          onClose={() => setConfirmCancel(false)}
          actions={
            <>
              <button className="btn btn-auto" onClick={() => setConfirmCancel(false)}>
                Keep copying
              </button>
              <button
                className="btn btn-primary btn-auto"
                disabled={!!busy}
                onClick={() =>
                  void act('cancel', async () => {
                    await migrationApi.cancel(orgId)
                    location.reload()
                  })
                }
              >
                Cancel migration
              </button>
            </>
          }
        >
          <p>
            Copying stops for all {plural(total, 'user')}. What's already copied ({status.percent}%) stays in xstate: mailboxes, contacts and
            files aren't removed. Nothing in Google changes.
          </p>
          <p className="muted">To continue later you start again from Connect; copied items aren't copied twice.</p>
        </Dialog>
      )}
    </>
  )
}

function UserRow({ p, admin, busy, onFix }: { p: UserProgress; admin: boolean; busy: boolean; onFix: (fix: migrationApi.QuotaFix) => void }) {
  // Shared drives come as rows of their own (id "drive:…"); "(shared)" is for people imported as shared mailboxes.
  const shared = p.action === 'shared' && !p.user.id.startsWith('drive:')
  const driveText = p.driveBytes && p.driveBytes.done < p.driveBytes.total ? `${bytes(p.driveBytes.done)} of ${bytes(p.driveBytes.total)}` : undefined
  return (
    <>
      <div className={`tr${p.state === 'attention' ? ' is-attention' : ''}`} role="row">
        <span className="who">
          <span className="avatar">{initials(p.user.name)}</span>
          <span className="who-text">
            <span className="hi ellipsis">
              {p.user.name}
              {shared && <span className="muted"> (shared)</span>}
            </span>
            <span className="muted small ellipsis">{p.user.email}</span>
          </span>
        </span>
        <span data-label="Mail">
          <PartCell count={p.mail} unit="messages" tone={p.state === 'attention' ? 'warn' : undefined} />
        </span>
        <span data-label="Contacts">
          <PartCell count={p.contacts} unit="contacts" off={p.later?.includes('contacts') ? 'Coming soon' : undefined} />
        </span>
        <span data-label="Drive">
          <PartCell count={p.drive} unit="files" text={driveText} off={p.later?.includes('drive') ? 'Coming soon' : undefined} />
        </span>
        <span>
          <StateChip state={p.state} />
        </span>
      </div>
      {p.state === 'attention' && p.issueText && (
        <div className="tr-issue" role="row">
          <Icon name="circle-alert" size={13} />
          <span>{p.issueText}</span>
          {admin && (
            <span className="fix">
              {p.issue === 'quota' && (
                <button className="mini" disabled={busy} onClick={() => onFix('raise')}>
                  Remove the mailbox quota
                </button>
              )}
              <button className="mini" disabled={busy} onClick={() => onFix('retry')}>
                Try again
              </button>
              <button className="mini" disabled={busy} onClick={() => onFix('skip')}>
                Skip
              </button>
            </span>
          )}
        </div>
      )}
      {p.state === 'attention' && !p.issueText && p.issue === 'quota' && (
        <div className="tr-issue" role="row">
          <Icon name="circle-alert" size={13} />
          <span>
            Mailbox quota (10 GB) is smaller than this Gmail account ({bytes(p.user.mailBytes)}). Mail copying stopped at{' '}
            {bytes(p.user.mailBytes * 0.635)}; Contacts and Drive are unaffected.
          </span>
          {admin && (
            <span className="fix">
              <button className="mini" disabled={busy} onClick={() => onFix('raise')}>
                Raise quota to 20 GB
              </button>
              <button className="mini" disabled={busy} onClick={() => onFix('range')}>
                Copy last 5 years only
              </button>
            </span>
          )}
        </div>
      )}
    </>
  )
}
