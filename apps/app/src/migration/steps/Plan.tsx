// 3 · Plan: one row per Google user with what to include and what they become in xstate. Suspended users default to
// "Import as shared mailbox" (or Skip when nearly empty). A bulk bar appears on selection. Groups and shared drives
// sit below, and the mail date range applies to everyone. The plan is saved as it changes.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { errorMessage, initials } from '../../lib/core'
import * as migrationApi from '../api'
import type { Ctx } from '../main'
import { sizes } from '../sample'
import type { Action, GoogleUser, MailRange, Part, Plan, UserPlan } from '../types'
import { bytes, Checkbox, Menu, Panel, plural, Title, Toggle, type MenuItem } from '../ui'

const PREVIEW_ROWS = 7

type Filter = 'all' | 'suspended' | 'large'

const RANGES: [MailRange, string][] = [
  ['all', 'All mail'],
  ['5y', 'Last 5 years'],
  ['3y', 'Last 3 years'],
  ['1y', 'Last year'],
]

function actionItems(user: GoogleUser | null, mailboxes: string[]): MenuItem<string>[] {
  const existing = user?.existingMailbox ? [user.existingMailbox, ...mailboxes.filter((m) => m !== user.existingMailbox)] : mailboxes
  return [
    { value: 'create', label: 'Create member + mailbox', sub: 'A new xstate member with the same address. They get an invite at the end.' },
    ...existing.slice(0, 4).map((address) => ({ value: `existing:${address}`, label: `Use existing: ${address}`, sub: 'Copy into a mailbox that already exists in xstate.' })),
    { value: 'shared', label: 'Import as shared mailbox', sub: 'For people who left. No member is created; you choose who can open it.' },
    { value: 'skip', label: 'Skip', sub: 'Nothing is copied for this user.' },
  ]
}

const actionLabel = (p: UserPlan) =>
  p.action === 'create' ? 'Create member + mailbox' : p.action === 'existing' ? `Use existing: ${p.existing}` : p.action === 'shared' ? 'Import as shared mailbox' : 'Skip'

const actionValue = (p: UserPlan) => (p.action === 'existing' ? `existing:${p.existing}` : p.action)

function applyAction(p: UserPlan, value: string): UserPlan {
  if (value.startsWith('existing:')) return { ...p, action: 'existing', existing: value.slice(9), mail: true, contacts: true, drive: true }
  const action = value as Action
  if (action === 'skip') return { action, mail: false, contacts: false, drive: false }
  if (action === 'shared') return { action, mail: true, contacts: false, drive: p.drive || p.action === 'skip' }
  return { action, mail: true, contacts: true, drive: true }
}

export function PlanStep({ ctx }: { ctx: Ctx }) {
  const discovery = ctx.migration.discovery!
  const [plan, setPlanState] = useState<Plan>(ctx.migration.plan!)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const mailboxes = ctx.mailboxes.filter((m) => m.kind === 'personal').map((m) => m.address)

  // The latest plan, so quick successive changes build on each other; saving happens outside any state updater.
  const current = useRef(plan)
  // Saves are gathered for a moment and sent one at a time, so the server never ends with an older plan than this
  // screen shows. Non-admins can look but their changes aren't kept.
  const [saving, setSaving] = useState<'saved' | 'saving' | 'failed'>('saved')
  const [saveError, setSaveError] = useState('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef<Promise<unknown> | null>(null)
  const save = () => {
    saveTimer.current = null
    const plan = current.current
    const run = async () => {
      try {
        await migrationApi.savePlan(ctx.org.id, plan)
        if (current.current === plan) setSaving('saved')
      } catch (err) {
        setSaving('failed')
        setSaveError(errorMessage(err))
      }
    }
    inFlight.current = (inFlight.current ?? Promise.resolve()).then(run)
  }
  useEffect(
    () => () => {
      // Leaving the step: send what's pending now.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current)
        save()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const setPlan = (fn: (p: Plan) => Plan) => {
    if (!ctx.isAdmin) return
    const next = fn(current.current)
    current.current = next
    setPlanState(next)
    ctx.setMigration({ ...ctx.migration, plan: next })
    setSaving('saving')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(save, 400)
  }

  const setUser = (id: string, fn: (p: UserPlan) => UserPlan) => setPlan((p) => ({ ...p, users: { ...p.users, [id]: fn(p.users[id]!) } }))

  const users = discovery.users
  const counts = { all: users.length, suspended: users.filter((u) => u.suspended).length, large: users.filter((u) => u.mailBytes > 20 * sizes.GB).length }
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return users.filter(
      (u) =>
        (filter === 'all' || (filter === 'suspended' ? u.suspended : u.mailBytes > 20 * sizes.GB)) &&
        (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)),
    )
  }, [users, query, filter])
  const shown = showAll || query || filter !== 'all' ? visible : visible.slice(0, PREVIEW_ROWS)
  const allSelected = visible.length > 0 && visible.every((u) => selected.has(u.id))

  const select = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const bulkAction = (value: string) => {
    setPlan((p) => {
      const next = { ...p.users }
      for (const id of selected) next[id] = applyAction(next[id]!, value)
      return { ...p, users: next }
    })
  }

  const bulkInclude = (value: string) => {
    const [part, on] = value.split(':') as [Part, 'on' | 'off']
    setPlan((p) => {
      const next = { ...p.users }
      for (const id of selected) {
        const u = next[id]!
        if (u.action === 'skip' || (part === 'contacts' && u.action === 'shared')) continue
        next[id] = { ...u, [part]: on === 'on' }
      }
      return { ...p, users: next }
    })
  }

  const included = Object.values(plan.users).filter((p) => p.action !== 'skip').length

  return (
    <>
      <Title title="Plan the move" sub="Decide what each Google user, group and shared drive becomes in xstate. Defaults are set for the common case; change only what's different." />

      <section className="plan-users">
        <div className="table-tools">
          <h2>
            Users <span className="muted">{users.length}</span>
          </h2>
          <span className="input search">
            <Icon name="search" size={13} />
            <input placeholder="Search users" aria-label="Search users" value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
          <div className="segmented" role="group" aria-label="Filter users">
            {(['all', 'suspended', 'large'] as Filter[]).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'suspended' ? 'Suspended' : 'Large mailboxes'} <span className="muted">{counts[f]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="table plan-table">
          {/* The bulk bar takes the header row's place, so selecting doesn't move the rows under the pointer. */}
          {selected.size > 0 ? (
            <div className="bulk">
              <Checkbox
                checked={allSelected}
                indeterminate={!allSelected}
                label={allSelected ? 'Clear selection' : 'Select all users'}
                onChange={(on) => setSelected(on ? new Set(visible.map((u) => u.id)) : new Set())}
              />
              <span className="hi">{selected.size} selected</span>
              <Menu label="Set action" items={actionItems(null, mailboxes).filter((i) => !i.value.startsWith('existing:'))} onSelect={bulkAction} className="compact" />
              <Menu
                label="Include"
                className="compact"
                items={[
                  { value: 'mail:on', label: 'Include Mail' },
                  { value: 'mail:off', label: 'Leave out Mail' },
                  { value: 'contacts:on', label: 'Include Contacts' },
                  { value: 'contacts:off', label: 'Leave out Contacts' },
                  { value: 'drive:on', label: 'Include Drive' },
                  { value: 'drive:off', label: 'Leave out Drive' },
                ]}
                onSelect={bulkInclude}
              />
              <button className="text-btn end" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </div>
          ) : (
          <div className="tr th" role="row">
            <span>
              <Checkbox
                checked={allSelected}
                indeterminate={!allSelected && visible.some((u) => selected.has(u.id))}
                label="Select all users"
                onChange={(on) => setSelected(on ? new Set(visible.map((u) => u.id)) : new Set())}
              />
            </span>
            <span>User</span>
            <span className="num">Mail</span>
            <span className="num">Drive</span>
            <span>Include</span>
            <span>Action</span>
          </div>
          )}
          {shown.map((u) => {
            const p = plan.users[u.id]!
            const skip = p.action === 'skip'
            return (
              <div className={`tr${selected.has(u.id) ? ' is-selected' : ''}${skip ? ' is-skipped' : ''}`} role="row" key={u.id}>
                <span>
                  <Checkbox checked={selected.has(u.id)} label={`Select ${u.name}`} onChange={(on) => select(u.id, on)} />
                </span>
                <span className="who">
                  <span className="avatar">{initials(u.name)}</span>
                  <span className="who-text">
                    <span className="hi ellipsis">
                      {u.name}
                      {u.suspended && <span className="tag">Suspended</span>}
                    </span>
                    <span className="muted small ellipsis">{u.email}</span>
                  </span>
                </span>
                <span className={`num${u.mailBytes > 30 * sizes.GB ? ' hi strong' : ''}`}>{bytes(u.mailBytes)}</span>
                <span className="num">{bytes(u.driveBytes)}</span>
                <span className="include">
                  <Toggle on={p.mail} label="Mail" disabled={skip} onChange={(on) => setUser(u.id, (x) => ({ ...x, mail: on }))} />
                  <Toggle on={p.contacts} label="Contacts" disabled={skip || p.action === 'shared'} onChange={(on) => setUser(u.id, (x) => ({ ...x, contacts: on }))} />
                  <Toggle on={p.drive} label="Drive" disabled={skip} onChange={(on) => setUser(u.id, (x) => ({ ...x, drive: on }))} />
                </span>
                <Menu
                  label={actionLabel(p)}
                  buttonLabel={`Action for ${u.name}`}
                  value={actionValue(p)}
                  items={actionItems(u, mailboxes)}
                  onSelect={(value) => setUser(u.id, (x) => applyAction(x, value))}
                />
              </div>
            )
          })}
          {!shown.length && <div className="tr empty-row">No users match.</div>}
          <div className="tfoot">
            <span className="muted small">
              Showing {shown.length} of {visible.length}
              {filter !== 'all' || query ? ` (${users.length} in all)` : ''}
            </span>
            {!showAll && !query && filter === 'all' && visible.length > PREVIEW_ROWS && (
              <button className="text-btn" onClick={() => setShowAll(true)}>
                Show all
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="two-col">
        <Panel title="Groups" aside={<span className="muted small">Each group can become a shared mailbox. Its members get access.</span>}>
          <ul className="rows">
            {discovery.groups.map((g) => {
              const on = plan.groups[g.id]!
              return (
                <li key={g.id}>
                  <Checkbox checked={on} label={`Import ${g.email}`} onChange={(v) => setPlan((p) => ({ ...p, groups: { ...p.groups, [g.id]: v } }))} />
                  <span className="who-text">
                    <code className="hi">{g.email}</code>
                    <span className="muted small">{g.note ?? `${g.members} members`}</span>
                  </span>
                  <span className={`end small ${on ? 'hi' : 'dim'}`}>{on ? 'Shared mailbox' : 'Not imported'}</span>
                </li>
              )
            })}
          </ul>
        </Panel>
        <div className="stack">
          <Panel title="Shared drives" aside={<span className="muted small">Each becomes an organization team folder in Storage.</span>}>
            <ul className="rows">
              {discovery.drives.map((d) => {
                const on = plan.drives[d.id]!
                return (
                  <li key={d.id}>
                    <Checkbox checked={on} label={`Import ${d.name}`} onChange={(v) => setPlan((p) => ({ ...p, drives: { ...p.drives, [d.id]: v } }))} />
                    <Icon name="folder" size={14} />
                    <span className="who-text">
                      <span className="hi">{d.name}</span>
                      <span className="muted small">
                        {[d.bytes !== null && bytes(d.bytes), d.members !== null && plural(d.members, 'member')].filter(Boolean).join(' · ') || 'Size counted while copying'}
                      </span>
                    </span>
                    <span className={`end small ${on ? 'hi' : 'dim'}`}>{on ? `→ Team folder "${d.name}"` : 'Not imported'}</span>
                  </li>
                )
              })}
            </ul>
          </Panel>
          <Panel title="Mail date range">
            <div className="segmented" role="group" aria-label="Mail date range">
              {RANGES.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={plan.mailRange === value} onClick={() => setPlan((p) => ({ ...p, mailRange: value }))}>
                  {label}
                </button>
              ))}
            </div>
            <p className="muted small">Older mail stays in Google. Contacts and Drive are always copied in full.</p>
          </Panel>
        </div>
      </div>

      <div className="actions">
        <button className="btn btn-auto" onClick={() => void ctx.go('discover')}>
          Back
        </button>
        <button className="btn btn-primary btn-auto" disabled={!included || !ctx.isAdmin} onClick={() => void ctx.go('review')}>
          Continue to review
          <Icon name="chevron-right" size={14} />
        </button>
        <span className={saving === 'failed' ? 'small form-error' : 'muted small'}>
          {!ctx.isAdmin
            ? 'View only: owners and admins change the plan.'
            : saving === 'failed'
              ? `Couldn't save the plan: ${saveError}`
              : saving === 'saving'
                ? 'Saving…'
                : included
                  ? 'Your plan is saved.'
                  : 'Choose at least one user to move.'}
        </span>
      </div>
    </>
  )
}
