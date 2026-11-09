// 2 · Discover: starts by itself after Verify. The loading list names what is being counted; the summary shows
// blockers (a domain not yet in xstate) before the admin spends time on the plan.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { errorMessage } from '../../lib/core'
import * as migrationApi from '../api'
import type { Ctx } from '../main'
import { sizes } from '../sample'
import { bytes, Notice, Panel, plural, Title } from '../ui'

export function DiscoverStep({ ctx }: { ctx: Ctx }) {
  const discovery = ctx.migration.discovery
  // The Workspace is the verified admin's: its primary domain is the admin address's.
  const domain = ctx.migration.connection?.adminEmail.split('@')[1] ?? ctx.domain
  const [done, setDone] = useState(0)
  const [error, setError] = useState('')
  const started = useRef(false)
  const leaving = useRef(new AbortController())

  const run = async () => {
    setError('')
    setDone(0)
    const signal = leaving.current.signal
    try {
      const m = await migrationApi.discover(ctx.org.id, domain, ctx.demo ? null : ctx.domains, setDone, signal)
      if (!signal.aborted) ctx.setMigration(m)
    } catch (err) {
      if (!signal.aborted) setError(errorMessage(err))
    }
  }

  useEffect(() => {
    if (discovery || started.current) return
    started.current = true
    void run()
    // Leaving the step stops the polling; the server keeps counting.
    const controller = leaving.current
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!discovery) {
    return (
      <>
        <Title spinner={!error} title={`Looking through ${domain}`} sub="Reading only. This usually takes 10–60 seconds. Nothing is copied yet." />
        <ul className="loading-list">
          {migrationApi.DISCOVERY_PARTS.map((label, i) => {
            const state = i < done ? 'done' : i === done && !error ? 'active' : 'idle'
            return (
              <li key={label} className={`is-${state}`}>
                {state === 'done' ? <Icon name="circle-check" size={14} /> : state === 'active' ? <span className="spinner" /> : <span className="dot-space" />}
                <span>{label}</span>
                <span className="muted">{state === 'active' ? 'Counting…' : ''}</span>
              </li>
            )
          })}
        </ul>
        {error && (
          <Notice kind="error" action={<button className="mini" onClick={() => void run()}>Try again</button>}>
            {error}
          </Notice>
        )}
      </>
    )
  }

  const users = discovery.users
  const suspended = users.filter((u) => u.suspended).length
  const mail = users.reduce((s, u) => s + u.mailBytes, 0)
  const drive = users.reduce((s, u) => s + u.driveBytes, 0) + discovery.drives.reduce((s, d) => s + (d.bytes ?? 0), 0)
  const missing = discovery.domains.filter((d) => !d.inXstate)
  const big = users.filter((u) => u.mailBytes > 30 * sizes.GB)

  return (
    <>
      <Title
        title="Here's what we found"
        sub="Counted from your Google Workspace just now. Suspended users and alias domains are included so you can decide what to do with them."
      />
      <div className="tiles six">
        <Tile label="Users" value={String(users.length)} sub={suspended ? `${suspended} suspended` : undefined} />
        <Tile label="Groups" value={String(discovery.groups.length)} />
        <Tile label="Shared drives" value={String(discovery.drives.length)} />
        <Tile label="Domains" value={String(discovery.domains.length)} />
        <Tile label="Mail" value={bytes(mail)} />
        <Tile label="Drive" value={bytes(drive)} />
      </div>

      {missing.map((d) => (
        <Notice
          key={d.name}
          kind="warn"
          action={
            <a className="mini" href={`/app/${ctx.demo ? '?demo' : ''}#/settings/domains`} target="_blank" rel="noreferrer">
              Add domain
            </a>
          }
        >
          <b>{d.name} isn't added to xstate yet.</b> Add it before you start, or addresses on it won't be created.
        </Notice>
      ))}

      <div className="two-col">
        <Panel title="Domains">
          <ul className="rows">
            {discovery.domains.map((d) => (
              <li key={d.name}>
                <Icon name="globe" size={14} />
                <span className="hi">{d.name}</span>
                <span className="tag">{d.kind === 'primary' ? 'Primary' : d.kind === 'secondary' ? 'Secondary' : 'Alias domain'}</span>
                <span className={`end small ${d.inXstate ? 'muted' : 'hi'}`}>{d.inXstate ? 'In xstate' : 'Not in xstate'}</span>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="What moves">
          <ul className="rows">
            <li>
              <Icon name="mail" size={14} />
              <span className="hi">Mail</span>
              <span className="end small muted">{bytes(mail)} · labels, read state, attachments</span>
            </li>
            <li>
              <Icon name="users" size={14} />
              <span className="hi">Contacts</span>
              <span className="end small muted">{plural(users.reduce((s, u) => s + (u.contacts ?? 0), 0), 'contact')}</span>
            </li>
            <li>
              <Icon name="hard-drive" size={14} />
              <span className="hi">Drive</span>
              <span className="end small muted">{bytes(drive)} · My Drive, Shared drives, sharing</span>
            </li>
            <li className="is-soon">
              <Icon name="clock" size={14} />
              <span>Calendar</span>
              <span className="end small tag">Coming soon</span>
            </li>
          </ul>
        </Panel>
      </div>

      {big.length > 0 && (
        <p className="muted small">
          {plural(big.length, 'mailbox', 'mailboxes')} over 30 GB. Google limits how fast we can read, so these take longest.
        </p>
      )}

      <div className="actions">
        <button className="btn btn-auto" onClick={() => void ctx.go('connect')}>
          Back
        </button>
        <button className="btn btn-primary btn-auto" disabled={!ctx.isAdmin} onClick={() => void ctx.go('plan')}>
          Continue to plan
          <Icon name="chevron-right" size={14} />
        </button>
        {ctx.isAdmin && (
          <button className="text-btn" onClick={() => void run()}>
            <Icon name="refresh-cw" size={12} />
            Count again
          </button>
        )}
      </div>
    </>
  )
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile-stat">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  )
}
