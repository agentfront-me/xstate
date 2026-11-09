// 7 · Final sync: the catch-up pass for mail, contacts and files that changed in Google since the bulk copy. It runs
// once more by itself 24 hours later, for mail Google received while DNS updated.

import { useEffect, useState } from 'react'
import { Icon, type IconName } from '../../components/Icon'
import * as migrationApi from '../api'
import type { Ctx } from '../main'
import type { FinalPart, FinalStatus } from '../types'
import { Bar, day, num, time, Title, useTick } from '../ui'

export function FinalStep({ ctx }: { ctx: Ctx }) {
  const orgId = ctx.org.id
  const [status, setStatus] = useState<FinalStatus | null>(null)
  const tick = useTick(1500, !status?.finished)

  useEffect(() => {
    let live = true
    void migrationApi.finalStatus(orgId).then((s) => live && setStatus(s))
    return () => {
      live = false
    }
  }, [orgId, tick])

  if (!status) return <div className="loading"><span className="spinner" /></div>

  const domain = ctx.migration.discovery!.domain
  // From the API, progress is people finished (the number of changes isn't known until a pass ends).
  const share = status.mail.people ? (status.mail.people.total ? status.mail.people.done / status.mail.people.total : 1) : status.mail.total ? status.mail.done / status.mail.total : 1
  const left = Math.max(1, Math.round((1 - share) * 25))
  const tomorrow = new Date(status.rerunAt).toDateString() === new Date(Date.now() + 86_400_000).toDateString()

  return (
    <>
      <Title
        spinner={!status.finished}
        title={status.finished ? 'Final sync done' : 'Final sync running'}
        sub={
          status.finished
            ? `Everything that changed in Google since the first copy is in xstate. Mail sent to ${domain} now arrives in xstate.`
            : `Picking up mail, contacts and files that changed in Google since the first copy. About ${left} minutes left. Mail sent to ${domain} now arrives in xstate.`
        }
      />
      <div className="sync-list">
        <SyncRow icon="mail" label="Mail" count={status.mail} unit="new or changed messages" />
        <SyncRow icon="users" label="Contacts" count={status.contacts} unit="changed" />
        <SyncRow icon="hard-drive" label="Drive" count={status.drive} unit="changed files" />
      </div>
      <div className="notice is-info">
        <Icon name="clock" size={14} />
        <div className="notice-body">
          We'll run it once more automatically in 24 hours, for mail Google received while DNS updated. Scheduled for{' '}
          <b>
            {tomorrow ? `tomorrow, ${day(status.rerunAt)}` : day(status.rerunAt)} at {time(status.rerunAt)}
          </b>
          . You don't need to be here for it.
        </div>
      </div>
      <div className="actions">
        <button className="btn btn-primary btn-auto" disabled={!status.finished || !ctx.isAdmin} onClick={() => void ctx.go('finish')}>
          Continue to finish
          <Icon name="chevron-right" size={14} />
        </button>
        {!status.finished && <span className="muted small">Available when this pass is done.</span>}
      </div>
    </>
  )
}

function SyncRow({ icon, label, count, unit }: { icon: IconName; label: string; count: FinalPart; unit: string }) {
  // From the API: changes found so far while running, the bar following people finished.
  const live = !!count.people
  const done = live ? !count.running : count.done >= count.total
  const text = live ? `${num(count.done)} ${unit}${done ? '' : ' so far'}` : done ? `${num(count.total)} ${unit}` : `${num(count.done)} of ${num(count.total)} ${unit}`
  const share = live ? (count.people!.total ? count.people!.done / count.people!.total : 1) : count.total ? count.done / count.total : 1
  return (
    <div className="sync-row">
      <div className="sync-top">
        <Icon name={icon} size={14} />
        <span className="hi">{label}</span>
        <span className="end small muted">{text}</span>
        {done ? <Icon name="circle-check" size={14} /> : <span className="spinner" />}
      </div>
      <Bar value={done ? 100 : share * 100} />
    </div>
  )
}
