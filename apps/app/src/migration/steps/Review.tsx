// 4 · Review and start: what will be created, the estimate, three cautions, then one button.

import { Icon, type IconName } from '../../components/Icon'
import { errorMessage } from '../../lib/core'
import { Help, usePending } from '../../onboarding/ui'
import { useState } from 'react'
import * as migrationApi from '../api'
import type { Ctx } from '../main'
import { bytes, duration, num, Panel, Title } from '../ui'

/** Rough read speed Google allows across a domain, for the estimate. */
const BYTES_PER_SECOND = 20 * 1024 ** 2

export function ReviewStep({ ctx }: { ctx: Ctx }) {
  const d = ctx.migration.discovery!
  const plan = ctx.migration.plan!
  const [pending, run] = usePending()
  const [error, setError] = useState('')
  const range = migrationApi.RANGE_SHARE[plan.mailRange]

  const entries = d.users.map((u) => ({ u, p: plan.users[u.id]! }))
  const moving = entries.filter((e) => e.p.action !== 'skip')
  const members = entries.filter((e) => e.p.action === 'create').length
  const sharedUsers = entries.filter((e) => e.p.action === 'shared').length
  const groups = d.groups.filter((g) => plan.groups[g.id]).length
  const drives = d.drives.filter((x) => plan.drives[x.id])
  const skipped = entries.filter((e) => e.p.action === 'skip')

  const mailBytes = moving.filter((e) => e.p.mail).reduce((s, e) => s + e.u.mailBytes * range, 0)
  const messages = moving.filter((e) => e.p.mail).reduce((s, e) => s + (e.u.messages ?? 0) * range, 0)
  const contactsUsers = moving.filter((e) => e.p.contacts).length
  const driveBytes = moving.filter((e) => e.p.drive).reduce((s, e) => s + e.u.driveBytes, 0) + drives.reduce((s, x) => s + (x.bytes ?? 0), 0)
  const files = moving.filter((e) => e.p.drive).reduce((s, e) => s + (e.u.files ?? 0), 0) + drives.reduce((s, x) => s + (x.files ?? 0), 0)
  // Shared drives (and anyone Google wouldn't count) are sized while copying, so the totals leave them out.
  const uncounted = drives.some((x) => x.bytes === null)
  const seconds = (mailBytes + driveBytes) / BYTES_PER_SECOND

  const approx = (n: number) => (n >= 1_000_000 ? `~${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `~${Math.round(n / 1000)}K` : `~${num(Math.round(n))}`)
  const rangeLabel = plan.mailRange === 'all' ? 'all dates' : plan.mailRange === '1y' ? 'last year' : `last ${plan.mailRange[0]} years`

  const startCopy = () =>
    run(async () => {
      try {
        ctx.setMigration(await migrationApi.start(ctx.org.id))
      } catch (err) {
        setError(errorMessage(err))
      }
    })

  return (
    <>
      <Title
        title="Review and start"
        sub={`This is what xstate will create. Copying takes ${duration(seconds)} for ${bytes(mailBytes)} of mail and ${bytes(driveBytes)} of Drive; Google limits how fast we can read.`}
      />
      <div className="tiles five">
        <Tile n={members} label="members" />
        <Tile n={members + entries.filter((e) => e.p.action === 'existing').length} label="mailboxes" />
        <Tile n={sharedUsers + groups} label="shared mailboxes" />
        <Tile n={d.aliases} label="aliases" />
        <Tile n={drives.length} label="team folders" />
      </div>
      <div className="two-col">
        <Panel>
          <ul className="rows">
            <Row icon="mail" label={`Mail · ${rangeLabel}`} value={`${bytes(mailBytes)} · ${approx(messages)} messages`} />
            <Row icon="users" label="Contacts" value={`${contactsUsers} users`} />
            <Row icon="hard-drive" label={`Drive · My Drive + ${drives.length} shared drive${drives.length === 1 ? '' : 's'}`} value={`${bytes(driveBytes)} · ${approx(files)} files${uncounted ? ' + shared drives' : ''}`} />
            <Row
              icon="user-minus"
              label="Skipped"
              value={skipped.length ? `${skipped.length} user${skipped.length === 1 ? '' : 's'} (${skipped.map((e) => e.u.name).join(', ')})` : 'Nobody'}
            />
            <Row icon="clock" label="Estimated time" value={duration(seconds)} />
          </ul>
        </Panel>
        <Panel title="Before you start">
          <ul className="cautions">
            <li>
              <Icon name="info" size={14} />
              <span>Nothing changes in Google. Mail keeps arriving there and your team keeps working as usual.</span>
            </li>
            <li>
              <Icon name="mail" size={14} />
              <span>Users won't be emailed until the end. You decide when invites go out.</span>
            </li>
            <li>
              <Icon name="send" size={14} />
              <span>Don't send mail from xstate until the cutover. Until DNS points here, replies would still land in Google.</span>
            </li>
          </ul>
        </Panel>
      </div>
      <Help message={error ? { text: error } : null} />
      <div className="actions">
        <button className="btn btn-auto" onClick={() => void ctx.go('plan')}>
          Back to plan
        </button>
        <button className="btn btn-primary btn-auto" disabled={pending} aria-busy={pending || undefined} onClick={() => void startCopy()}>
          {pending ? <span className="spinner spinner-on-primary" /> : <Icon name="download" size={14} />}
          Start copying
        </button>
      </div>
    </>
  )
}

function Tile({ n, label }: { n: number; label: string }) {
  return (
    <div className="tile-stat">
      <span className="tile-value">{num(n)}</span>
      <span className="tile-label">{label}</span>
    </div>
  )
}

function Row({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <li>
      <Icon name={icon} size={14} />
      <span className="hi">{label}</span>
      <span className="end small muted">{value}</span>
    </li>
  )
}
