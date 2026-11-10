// 8 · Finish: remove xstate's access in Google (with a live check), invite the team, keep the report. Then the
// final "<Org> is on xstate" screen.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { errorMessage, initials } from '../../lib/core'
import * as migrationApi from '../api'
import type { Ctx } from '../main'
import type { FinishStatus } from '../types'
import { CopyButton, day, Notice, num, Panel, plural, Title, useTick } from '../ui'

const SHOWN_MEMBERS = 6
const REPORT_ROWS = 5

async function download(orgId: string, f: FinishStatus, org: string) {
  const blob = await migrationApi.reportBlob(orgId, f)
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: `${org.toLowerCase().replace(/\W+/g, '-')}-google-migration-report.csv` })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function FinishStep({ ctx }: { ctx: Ctx }) {
  const orgId = ctx.org.id
  const [status, setStatus] = useState<FinishStatus | null>(null)
  const [skipAccess, setSkipAccess] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [links, setLinks] = useState<migrationApi.InviteLink[]>([])
  const tick = useTick(1000)

  const inFlight = useRef(false)
  useEffect(() => {
    let live = true
    // The access check runs every few seconds (every minute on the server); the countdown ticks every second. One
    // request at a time, so a slow first answer doesn't pile up requests.
    if ((!status || tick % 5 === 0) && !inFlight.current) {
      inFlight.current = true
      migrationApi
        .finishStatus(orgId)
        .then((s) => live && setStatus(s), (err: unknown) => live && setError(errorMessage(err)))
        .finally(() => (inFlight.current = false))
    }
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, tick])

  if (!status) return <div className="loading"><span className="spinner" /></div>

  const seconds = Math.max(0, Math.ceil((Date.parse(status.nextCheckAt) - Date.now()) / 1000))
  const id = migrationApi.CLIENT_ID
  const shortId = `${id.slice(0, 6)}…${id.slice(-4)}`
  const totals = status.report.reduce(
    (s, r) => ({ messages: s.messages + r.messages, contacts: s.contacts + (r.contacts ?? 0), events: s.events + (r.events ?? 0), files: s.files + r.files }),
    { messages: 0, contacts: 0, events: 0, files: 0 },
  )
  const skippedTotal = status.skipped.reduce((s, x) => s + x.count, 0)
  const first = status.newMembers[0]
  const noAddress = status.newMembers.filter((m) => m.sendTo === null).length

  const send = async () => {
    setSending(true)
    setError('')
    try {
      setLinks((await migrationApi.sendInvites(orgId)).links)
      setStatus(await migrationApi.finishStatus(orgId))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <Title title="Finish up" sub="Three last things: remove xstate's access from Google, invite your team, and keep the report." />
      <div className="two-col">
        <div className="stack">
          <Panel title={<Numbered n={1}>Remove xstate's access in Google</Numbered>}>
            <p className="small">
              In the Google Admin console: Security → API controls → Domain-wide delegation. Find Client ID <b>{shortId}</b> and choose Delete.
              xstate checks every minute until the access is gone.
            </p>
            {status.accessRemoved ? (
              <div className="status-line is-ok">
                <Icon name="circle-check" size={14} />
                Access removed. xstate can no longer read from Google Workspace.
              </div>
            ) : skipAccess ? (
              <div className="status-line">
                <Icon name="clock" size={14} />
                Skipped for now. Settings will remind you until the access is removed.
              </div>
            ) : (
              <div className="status-line">
                <span className="spinner" />
                <span>xstate can still read from Google. Checking again in {seconds} s.</span>
                <button className="text-btn end" onClick={() => setSkipAccess(true)}>
                  Skip for now
                </button>
              </div>
            )}
          </Panel>

          <Panel title={<Numbered n={2}>Invite your team</Numbered>} aside={<span className="muted small">{plural(status.newMembers.length, 'new member')}</span>}>
            <div className="people">
              {status.newMembers.slice(0, SHOWN_MEMBERS).map((m) => (
                <span className="person" key={m.email} title={m.email}>
                  <span className="avatar sm">{initials(m.name)}</span>
                  {m.name}
                </span>
              ))}
              {status.newMembers.length > SHOWN_MEMBERS && <span className="muted small">and {status.newMembers.length - SHOWN_MEMBERS} more</span>}
            </div>
            {first && (
              <div className="email-preview">
                <div className="preview-head muted small">
                  <span>Preview · to each member</span>
                </div>
                <div className="hi strong">Your {ctx.org.name} email has moved to xstate</div>
                <p className="small">
                  Hi {first.name.split(' ')[0]}, your mailbox, contacts, calendar and files from Google are already in xstate. Set your password to get started,
                  then follow the one-page guide to add your account to Apple Mail, Outlook or the xstate app.
                </p>
                <span className="fake-btn">Set your password</span>
              </div>
            )}
            {links.length > 0 && (
              <div className="invite-links">
                <p className="small">
                  {plural(links.length, 'person has', 'people have')} no personal email in Google, so their invite couldn't be emailed: their
                  own address now delivers to the xstate mailbox they can't open yet. Pass these links on to them yourself.
                </p>
                <ul>
                  {links.map((l) => (
                    <li key={l.email}>
                      <span className="who-text">
                        <span className="hi ellipsis">{l.name}</span>
                        <span className="muted small ellipsis">{l.email}</span>
                      </span>
                      <CopyButton text={l.url} label={`Copy invite link for ${l.name}`} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {status.invitesSent ? (
              <div className="status-line is-ok">
                <Icon name="circle-check" size={14} />
                Invites sent to {plural(status.newMembers.length, 'member')}.
              </div>
            ) : (
              <div className="actions">
                <button className="btn btn-primary btn-auto btn-sm" disabled={sending || !ctx.isAdmin || !status.newMembers.length} aria-busy={sending || undefined} onClick={() => void send()}>
                  {sending ? <span className="spinner spinner-on-primary" /> : <Icon name="send" size={13} />}
                  Send {status.newMembers.length} invites
                </button>
                <span className="muted small">
                  Sent to the personal email Google has for each person
                  {noAddress ? `; for the ${noAddress} without one you'll get a link to pass on` : ''}.
                </span>
              </div>
            )}
          </Panel>
        </div>

        <Panel
          title={<Numbered n={3}>Report</Numbered>}
          aside={
            <button className="text-btn" onClick={() => void download(orgId, status, ctx.org.name).catch((err) => setError(errorMessage(err)))}>
              <Icon name="download" size={12} />
              Download CSV
            </button>
          }
        >
          <div className="table report">
            <div className="tr th" role="row">
              <span>User</span>
              <span className="num">Messages</span>
              <span className="num">Contacts</span>
              <span className="num">Events</span>
              <span className="num">Files</span>
            </div>
            {status.report.slice(0, REPORT_ROWS).map((r, i) => (
              <div className="tr" role="row" key={`${i}-${r.name}`}>
                <span className="hi ellipsis">
                  {r.name}
                  {r.shared && <span className="muted"> (shared)</span>}
                </span>
                <span className="num">{num(r.messages)}</span>
                <span className="num">{r.contacts === null ? '—' : num(r.contacts)}</span>
                <span className="num">{r.events == null ? '—' : num(r.events)}</span>
                <span className="num">{num(r.files)}</span>
              </div>
            ))}
            <div className="tr total" role="row">
              <span className="muted">All {status.report.length} users</span>
              <span className="num hi">{num(totals.messages)}</span>
              <span className="num hi">{num(totals.contacts)}</span>
              <span className="num hi">{num(totals.events)}</span>
              <span className="num hi">{num(totals.files)}</span>
            </div>
          </div>
          <div className="skipped">
            <div className="muted small">
              <Icon name="circle-alert" size={12} /> Skipped · {num(skippedTotal)} items
            </div>
            <ul>
              {status.skipped.map((s) => (
                <li key={s.label}>
                  <span className="num hi">{num(s.count)}</span>
                  <span>
                    <span className="hi">{s.label}</span> <span className="muted">· {s.reason}</span>
                  </span>
                </li>
              ))}
            </ul>
            <KeptNote status={status} />
          </div>
        </Panel>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="actions">
        <button className="btn btn-primary btn-auto" disabled={!status.invitesSent || !ctx.isAdmin} onClick={() => void ctx.go('done')}>
          Finish migration
        </button>
        {!status.invitesSent && <span className="muted small">Send the invites to finish.</span>}
        {status.invitesSent && !status.accessRemoved && <span className="muted small">You can finish now and remove Google access later.</span>}
      </div>
    </>
  )
}

function Numbered({ n, children }: { n: number; children: ReactNode }) {
  return (
    <span className="numbered">
      <span className="n">{n}</span>
      {children}
    </span>
  )
}

export function DoneStep({ ctx }: { ctx: Ctx }) {
  const orgId = ctx.org.id
  const [status, setStatus] = useState<FinishStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    migrationApi.finishStatus(orgId).then(
      (s) => live && setStatus(s),
      (err: unknown) => live && setError(errorMessage(err)),
    )
    return () => {
      live = false
    }
  }, [orgId])
  const totals = migrationApi.copiedTotals(orgId)
  const app = `/app/${ctx.demo ? '?demo' : ''}`
  const plan = ctx.migration.plan!
  const d = ctx.migration.discovery!
  const mailboxes = d.users.filter((u) => plan.users[u.id]!.action !== 'skip').length
  const members = d.users.filter((u) => ['create', 'existing'].includes(plan.users[u.id]!.action)).length
  const folders = d.drives.filter((x) => plan.drives[x.id]).length
  const finished = ctx.migration.finishedAt ? day(ctx.migration.finishedAt) : 'today'

  return (
    <div className="done-state">
      <span className="done-icon">
        <Icon name="check" size={18} />
      </span>
      <h1>{ctx.org.name} is on xstate</h1>
      <p>
        {num(totals.users)} users, {num(totals.messages)} messages, {num(totals.contacts)} contacts{totals.events ? `, ${num(totals.events)} calendar events` : ''} and {num(totals.files)} files moved.
        {totals.contacts > 0 && ' Addresses Gmail saved on its own are under Users → Other contacts.'}
        <br />
        {status?.accessRemoved ? `Google access was removed on ${status.accessRemovedAt ? day(status.accessRemovedAt) : finished}.` : 'Google access is still on; Settings will remind you to remove it.'}{' '}
        {status && `Invites went out to ${plural(status.newMembers.length, 'member')}.`}
      </p>
      <div className="done-links">
        <a className="chip-link" href={`${app}#/mail`}>
          <Icon name="inbox" size={14} />
          Mail <span className="muted">{mailboxes} mailboxes</span>
        </a>
        <a className="chip-link" href={`${app}#/storage`}>
          <Icon name="hard-drive" size={14} />
          Storage <span className="muted">{folders} team folders</span>
        </a>
        <a className="chip-link" href={`${app}#/users`}>
          <Icon name="users" size={14} />
          Users <span className="muted">{members} members</span>
        </a>
      </div>
      {status && (
        <button className="text-btn" onClick={() => download(orgId, status, ctx.org.name).catch((err: unknown) => setError(errorMessage(err)))}>
          Download the report (CSV)
        </button>
      )}
      {status && <KeptNote status={status} />}
      {ctx.isAdmin && (
        <button
          className="text-btn"
          onClick={() =>
            migrationApi
              .startNew(orgId)
              .then((m) => ctx.setMigration(m))
              .catch((err: unknown) => setError(errorMessage(err)))
          }
        >
          Import another Google Workspace
        </button>
      )}
      {error && <Notice kind="error">{error}</Notice>}
    </div>
  )
}

/** How long the report keeps every skipped item: 30 days after finishing, then only the counts. */
function KeptNote({ status }: { status: FinishStatus }) {
  if (status.skippedDeleted) {
    return <p className="muted small">The list of skipped items was deleted 30 days after the import finished. The counts stay.</p>
  }
  if (!status.skippedKeptUntil) return null
  return <p className="muted small">The report lists every skipped item until {day(status.skippedKeptUntil)}. Download it to keep it.</p>
}
