// Agents (design: "xstate App", Agents page; docs/agents-plan.md): agents are set up here with no code, tested on a
// task, published as versions, and their runs are inspected step by step. Tabs: Runs, Setup (triggers, instructions,
// tools), Approvals, Memory and Settings. A banner on top says what's wrong with the agent and how to fix it.
//
// Edits go to the agent's draft (saved as you type) and only take effect when published. Tests run the draft as you;
// "Run now" runs the published version as the person who published it.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { isDemo, isOrgAdmin, useAccount } from '../lib/account'
import { copyText, errorMessage, initials } from '../lib/core'
import { useDomainScope } from '../lib/scope'
import type { Mailbox } from '../lib/types'
import { useMembers } from '../settings/members'
import { ConfirmDialog, Menu, Modal, type MenuItem } from '../storage/dialogs'
import '../styles/storage.css'
import '../styles/agents.css'
import {
  agentKeys,
  agentsApi,
  formatUsd,
  PROVIDER_LABEL,
  RUN_STATUS,
  type Agent,
  type AgentConfig,
  type AgentSummary,
  type ModelChoice,
  type Run,
  type RunStep,
  type ToolInfo,
} from './api'
import { ApprovalsTab } from './Approvals'
import { ConnectorTools } from './ConnectorTools'
import { IssueBanner, issueShort } from './Health'
import { MemoryTab } from './Memory'
import { NewAgentDialog, pendingTest } from './NewAgent'
import { TriggersSection } from './Triggers'

export type AgentsTab = 'runs' | 'setup' | 'approvals' | 'memory' | 'settings'
export type AgentsSearch = { agent?: string; tab?: AgentsTab; run?: string }

export function AgentsPage({ search }: { search: AgentsSearch }) {
  const account = useAccount()
  if (account.mode !== 'live' || isDemo()) {
    return (
      <section className="soon">
        <div className="col-head drag"><span className="title">Agents</span></div>
        <div className="empty">
          <Icon name="bot" size={28} />
          <strong>Agents needs a signed-in account</strong>
          <span>Sign in to set up agents that work on your email, contacts and files.</span>
        </div>
      </section>
    )
  }
  return <Agents orgId={account.org.id} admin={isOrgAdmin(account.org)} mailboxes={account.mailboxes} search={search} />
}

// ---------------------------------------------------------------------------------------------------------------
// Page

/** True on phone-sized windows, where the page shows the agent list or one agent, not both (like mail). */
function useNarrow(): boolean {
  const query = '(max-width: 680px)'
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

function Agents({ orgId, admin, mailboxes, search }: { orgId: string; admin: boolean; mailboxes: Mailbox[]; search: AgentsSearch }) {
  const navigate = useNavigate()
  const narrow = useNarrow()
  const go = (next: AgentsSearch, replace = false) => void navigate({ to: '/agents', search: next, replace })
  const [creating, setCreating] = useState(false)
  // Refreshed every 30 s so "needs approval" badges appear without a reload.
  const list = useQuery({ queryKey: agentKeys.list(orgId), queryFn: () => agentsApi.list(orgId), refetchInterval: 30_000 })
  // The domain picked in the rail: agents on its mailboxes, and agents tied to no mailbox (they belong to no domain).
  const scope = useDomainScope()
  const agents = useMemo(() => {
    const all = list.data?.agents ?? []
    if (!scope) return all
    const onDomain = new Set(mailboxes.filter((m) => m.domainId === scope.id).map((m) => m.id))
    return all.filter((a) => !a.mailboxes?.length || a.mailboxes.some((id) => onDomain.has(id)))
  }, [list.data, scope, mailboxes])
  // On a phone the list is the starting point, so nothing is picked for you.
  const selected = agents.find((a) => a.id === search.agent) ?? (narrow ? undefined : agents[0])

  // An open agent that's not on the newly picked domain closes.
  const outOfScope = !!search.agent && !agents.some((a) => a.id === search.agent) && !!list.data?.agents.some((a) => a.id === search.agent)

  useEffect(() => {
    if (outOfScope) go(agents[0] && !narrow ? { agent: agents[0].id, tab: search.tab } : {}, true)
    else if (!narrow && !search.agent && agents[0]) go({ agent: agents[0].id, tab: search.tab }, true)
  }, [search.agent, agents[0]?.id, narrow, outOfScope])

  return (
    // With no agents yet, the main pane (its "New agent" invitation) is what a phone shows.
    <div className={`storage agents${selected || (list.data && !agents.length) ? ' has-open' : ''}`}>
      <aside className="s-side" aria-label="Agents">
        <div className="col-head drag s-side-head">
          <span className="title grow">Agents</span>
          <button className="ghost" title="New agent" aria-label="New agent" onClick={() => setCreating(true)}><Icon name="plus" size={16} /></button>
        </div>
        <nav className="s-sections">
          {list.isLoading && <div className="loading"><span className="spinner" /></div>}
          {list.error && <p className="form-error a-pad">{errorMessage(list.error)}</p>}
          {agents.map((a) => (
            <button key={a.id} className="s-section a-item" aria-current={selected?.id === a.id ? 'true' : undefined} onClick={() => go({ agent: a.id, tab: search.tab })}>
              <span className="s-tile a-avatar">{initials(a.name)}</span>
              <span className="a-item-text">
                <span className="s-section-name">{a.name}</span>
                <AgentLine agent={a} />
              </span>
            </button>
          ))}
        </nav>
      </aside>
      <main className="a-main">
        {selected ? (
          <AgentView key={selected.id} orgId={orgId} admin={admin} mailboxes={mailboxes} summary={selected} search={search} go={go} onBack={narrow ? () => go({}) : undefined} />
        ) : (
          list.data &&
          !agents.length && (
            <div className="empty">
              <Icon name="bot" size={28} />
              <strong>{scope && list.data.agents.length ? `No agents on ${scope.name}` : 'No agents yet'}</strong>
              <span>An agent follows your instructions and uses tools like email, contacts and storage search.</span>
              <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={14} />New agent</button>
            </div>
          )
        )}
      </main>
      {creating && <NewAgentDialog orgId={orgId} mailboxes={scope ? mailboxes.filter((m) => m.domainId === scope.id) : mailboxes} onClose={() => setCreating(false)} onCreated={(id) => go({ agent: id, tab: 'setup' })} />}
    </div>
  )
}

function AgentLine({ agent }: { agent: AgentSummary }) {
  if (agent.pendingApprovals) return <span className="a-item-sub a-need">{agent.pendingApprovals} need approval</span>
  if (agent.issue) return <span className={`a-item-sub ${agent.issue.kind === 'failures' ? 'a-need' : 'a-err'}`}>{issueShort(agent.issue)}</span>
  const text = agent.status === 'active' ? 'Active' : agent.publishedVersion ? 'Paused' : 'Draft · not published'
  return <span className={`a-item-sub ${agent.status}`}>{agent.hasDraftChanges && agent.publishedVersion ? `${text} · draft changes` : text}</span>
}

// ---------------------------------------------------------------------------------------------------------------
// One agent: header and tabs

function AgentView({
  orgId,
  admin,
  mailboxes,
  summary,
  search,
  go,
  onBack,
}: {
  orgId: string
  admin: boolean
  mailboxes: Mailbox[]
  summary: AgentSummary
  search: AgentsSearch
  go: (s: AgentsSearch, replace?: boolean) => void
  /** Phones: back to the agent list. */
  onBack?: () => void
}) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: agentKeys.one(summary.id), queryFn: () => agentsApi.get(summary.id) })
  // A just-created agent opens with the Test drawer on its sample task (New agent → test and activate).
  const [testing, setTesting] = useState(() => pendingTest.agentId === summary.id)
  const [testTask] = useState(() => {
    if (pendingTest.agentId !== summary.id) return ''
    const task = 'task' in pendingTest ? pendingTest.task : ''
    Object.assign(pendingTest, { agentId: null, task: undefined })
    return task
  })
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [dialog, setDialog] = useState<'versions' | 'delete' | 'rename' | null>(null)
  const [busy, setBusy] = useState(false)
  const tab: AgentsTab = search.tab ?? 'runs'
  const agent = query.data?.agent

  const setAgent = (next: Agent) => {
    client.setQueryData(agentKeys.one(next.id), { agent: next })
    void client.invalidateQueries({ queryKey: agentKeys.list(orgId) })
  }

  if (query.error) return <p className="form-error a-pad">{errorMessage(query.error)}</p>
  if (!agent) return <div className="loading"><span className="spinner" /></div>

  const act = async (label: string, fn: () => Promise<{ agent: Agent }>) => {
    setBusy(true)
    try {
      setAgent((await fn()).agent)
      toast(label)
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMenu({
      x: r.right - 220,
      y: r.bottom + 4,
      items: [
        { icon: 'pencil', label: 'Rename', run: () => setDialog('rename') },
        { icon: 'history', label: 'Version history', run: () => setDialog('versions') },
        {
          icon: 'copy',
          label: 'Duplicate',
          run: () =>
            void agentsApi.duplicate(agent.id).then(
              ({ agent: copy }) => {
                void client.invalidateQueries({ queryKey: agentKeys.list(orgId) })
                go({ agent: copy.id, tab: 'setup' })
                toast(`Created ${copy.name}`)
              },
              (err: unknown) => toast(errorMessage(err)),
            ),
        },
        { icon: 'trash', label: 'Delete agent', run: () => setDialog('delete') },
      ],
    })
  }

  const draftDirty = agent.hasDraftChanges
  return (
    <>
      <header className="a-head drag">
        {onBack && (
          <button className="ghost a-back" aria-label="All agents" onClick={onBack}><Icon name="chevron-left" size={18} /></button>
        )}
        <span className="s-tile a-avatar lg">{initials(agent.name)}</span>
        <div className="a-title">
          <div className="a-name ellipsis">{agent.name}</div>
          <div className="a-desc ellipsis">{agent.description || 'No description'}</div>
        </div>
        <div className="a-actions">
          {draftDirty && <span className="a-pill" title="The draft differs from what's published">Draft changes</span>}
          <button className="btn" onClick={() => setTesting(true)}><Icon name="flask-conical" size={13} /><span className="a-btn-label">Test</span></button>
          <button className="btn btn-primary" disabled={busy || !draftDirty} onClick={() => void act('Published', () => agentsApi.publish(agent.id))}>
            {agent.publishedVersion ? 'Publish' : 'Publish v1'}
          </button>
          <button
            className="switch"
            role="switch"
            aria-checked={agent.status === 'active'}
            aria-label={agent.status === 'active' ? 'Turn agent off' : 'Turn agent on'}
            title={agent.status === 'active' ? 'Active' : 'Paused'}
            disabled={busy}
            onClick={() => void act(agent.status === 'active' ? 'Agent paused' : 'Agent turned on', () => agentsApi.setStatus(agent.id, agent.status === 'active' ? 'paused' : 'active'))}
          />
          <button className="ghost" aria-label="More" onClick={openMenu}><Icon name="ellipsis" size={16} /></button>
        </div>
      </header>
      <IssueBanner orgId={orgId} agent={agent} admin={admin} onOpenSettings={() => go({ agent: agent.id, tab: 'settings' })} />
      <nav className="tabs a-tabs" role="tablist">
        {(['runs', 'setup', 'approvals', 'memory', 'settings'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => go({ agent: agent.id, tab: t })}>
            {TAB_LABEL[t]}
            {t === 'approvals' && !!summary.pendingApprovals && <span className="a-count">{summary.pendingApprovals}</span>}
          </button>
        ))}
      </nav>
      <div className="a-scroll">
        {tab === 'runs' && <RunsTab agent={agent} search={search} go={go} onTest={() => setTesting(true)} />}
        {tab === 'setup' && (
          <SetupTab
            orgId={orgId}
            admin={admin}
            agent={agent}
            mailboxes={mailboxes}
            onSaved={setAgent}
            openVersions={() => setDialog('versions')}
            onOpenRun={(runId) => go({ agent: agent.id, tab: 'setup', run: runId })}
          />
        )}
        {tab === 'approvals' && <ApprovalsTab agent={agent} onOpenRun={(runId) => go({ agent: agent.id, tab: 'approvals', run: runId })} />}
        {tab === 'memory' && (
          <MemoryTab agent={agent} onOpenRun={(runId) => go({ agent: agent.id, tab: 'memory', run: runId })} onOpenSettings={() => go({ agent: agent.id, tab: 'settings' })} />
        )}
        {tab === 'settings' && (
          <SettingsTab orgId={orgId} admin={admin} agent={agent} mailboxes={mailboxes} onSaved={setAgent} onDelete={() => setDialog('delete')} />
        )}
      </div>
      {testing && (
        <TestDrawer
          agent={agent}
          initialTask={testTask}
          onClose={() => setTesting(false)}
          onOpenRun={(runId) => go({ agent: agent.id, tab: 'runs', run: runId })}
          onActivate={() =>
            act('Published and turned on', async () => {
              await agentsApi.publish(agent.id)
              return agentsApi.setStatus(agent.id, 'active')
            })
          }
        />
      )}
      {search.run && <RunDrawer agent={agent} runId={search.run} onClose={() => go({ agent: agent.id, tab })} />}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {dialog === 'versions' && <VersionsDialog agent={agent} onClose={() => setDialog(null)} onRestored={setAgent} />}
      {dialog === 'rename' && <RenameDialog agent={agent} onClose={() => setDialog(null)} onSaved={setAgent} />}
      {dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete ${agent.name}`}
          body="This deletes the agent with its versions and run history. It can't be undone."
          action="Delete agent"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await agentsApi.remove(agent.id)
              client.removeQueries({ queryKey: agentKeys.one(agent.id) })
              await client.invalidateQueries({ queryKey: agentKeys.list(orgId) })
              go({})
              toast(`${agent.name} deleted`)
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </>
  )
}

const TAB_LABEL: Record<AgentsTab, string> = { runs: 'Runs', setup: 'Setup', approvals: 'Approvals', memory: 'Memory', settings: 'Settings' }

// ---------------------------------------------------------------------------------------------------------------
// Runs tab

const when = (iso: string) => {
  const d = new Date(iso)
  const today = new Date()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Today ${time}`
  const y = new Date(today.getTime() - 86_400_000)
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}
const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
const TRIGGER_ICON: Record<string, IconName> = { test: 'flask-conical', manual: 'play', webhook: 'webhook', schedule: 'clock', email: 'mail' }

function RunsTab({ agent, search, go, onTest }: { agent: Agent; search: AgentsSearch; go: (s: AgentsSearch) => void; onTest: () => void }) {
  const [trigger, setTrigger] = useState('')
  const [status, setStatus] = useState('')
  const [days, setDays] = useState(7)
  const runs = useQuery({
    queryKey: [...agentKeys.runs(agent.id), trigger, status, days],
    queryFn: () => agentsApi.runs(agent.id, { trigger, status, days }),
    refetchInterval: (q) => (q.state.data?.runs.some((r) => r.status === 'running' || r.status === 'waiting_for_approval') ? 3000 : false),
  })
  const stats = useQuery({ queryKey: agentKeys.stats(agent.id), queryFn: () => agentsApi.stats(agent.id) })
  const s = stats.data

  return (
    <div className="a-body">
      <div className="a-stats">
        <Stat label="Runs · 7d" value={s ? s.runs7d.toLocaleString() : '–'} sub="Published runs" />
        <Stat label="Success rate" value={s?.successRate == null ? '–' : `${Math.round(s.successRate * 1000) / 10}%`} sub="Finished without errors" />
        <Stat
          label="Spend · this month"
          value={s ? formatUsd(s.monthSpend) : '–'}
          sub={
            agent.published?.spend.monthlyCapUsd
              ? `of ${formatUsd(agent.published.spend.monthlyCapUsd)} cap · estimated`
              : s?.avgCost
                ? `${formatUsd(s.avgCost)} per run · estimated`
                : 'Estimated from tokens'
          }
        />
        <Stat label="Model" value={agent.published?.model?.id ?? agent.draft.model?.id ?? 'None'} sub={agent.published?.model ? PROVIDER_LABEL[agent.published.model.provider] : 'Pick one in Settings'} />
      </div>
      <div className="a-filters">
        <select className="select sm" value={trigger} onChange={(e) => setTrigger(e.target.value)} aria-label="Trigger">
          <option value="">All triggers</option>
          <option value="test">Tests</option>
          <option value="manual">Run now</option>
          <option value="email">Email</option>
          <option value="webhook">Webhook</option>
          <option value="schedule">Schedule</option>
        </select>
        <select className="select sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Outcome">
          <option value="">All outcomes</option>
          {Object.entries(RUN_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="select sm" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
        <span className="grow" />
        {runs.data && <span className="muted small">{runs.data.runs.length}{runs.data.nextCursor ? '+' : ''} runs</span>}
      </div>
      {runs.error && <p className="form-error">{errorMessage(runs.error)}</p>}
      {runs.data && !runs.data.runs.length ? (
        <div className="a-empty card">
          <Icon name="flask-conical" size={20} />
          <strong>No runs {trigger || status ? 'match' : 'yet'}</strong>
          <span>Give the agent a task with Test to see what it does, step by step.</span>
          <button className="btn" onClick={onTest}><Icon name="flask-conical" size={13} />Test the agent</button>
        </div>
      ) : (
        <div className="card a-table" role="table">
          <div className="a-tr a-th" role="row">
            <span role="columnheader">Time</span><span role="columnheader">Trigger</span><span role="columnheader">Outcome</span>
            <span role="columnheader" className="num">Steps</span><span role="columnheader" className="num">Tokens</span><span role="columnheader" className="num">Cost</span>
          </div>
          {runs.data?.runs.map((r) => (
            <button key={r.id} className="a-tr" role="row" aria-current={search.run === r.id ? 'true' : undefined} onClick={() => go({ agent: agent.id, tab: 'runs', run: r.id })}>
              <span role="cell">{when(r.startedAt)}</span>
              <span role="cell" className="ellipsis a-trigger">
                <Icon name={TRIGGER_ICON[r.trigger.kind] ?? 'play'} size={13} />
                <span className="ellipsis">{r.trigger.label}{r.version ? ` · v${r.version}` : ' · draft'}{r.dryRun ? ' · dry run' : ''} — {r.task}</span>
              </span>
              <span role="cell"><Outcome run={r} /></span>
              <span role="cell" className="num">{r.steps}</span>
              <span role="cell" className="num">{tokens(r.tokens.input + r.tokens.output)}</span>
              <span role="cell" className="num">{r.status === 'skipped' && !r.cost ? '–' : formatUsd(r.cost)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="a-stat">
      <span className="a-stat-label">{label}</span>
      <span className="a-stat-value ellipsis" title={value}>{value}</span>
      <span className="a-stat-sub ellipsis">{sub}</span>
    </div>
  )
}

function Outcome({ run }: { run: Run }) {
  const s = RUN_STATUS[run.status]
  return (
    <span className={`a-outcome ${run.status}`}>
      {run.status === 'running' ? <span className="spinner" /> : <Icon name={s.icon} size={13} />}
      <span className="a-outcome-label">{s.label}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Run detail (drawer) and timeline

function RunDrawer({ agent, runId, onClose }: { agent: Agent; runId: string; onClose: () => void }) {
  const client = useQueryClient()
  const query = useQuery({
    queryKey: agentKeys.run(agent.id, runId),
    queryFn: () => agentsApi.run(agent.id, runId),
    refetchInterval: (q) => (q.state.data && q.state.data.run.status !== 'running' ? false : 1500),
  })
  const run = query.data?.run
  useEffect(() => {
    if (run && run.status !== 'running') {
      void client.invalidateQueries({ queryKey: agentKeys.runs(agent.id) })
      void client.invalidateQueries({ queryKey: agentKeys.stats(agent.id) })
    }
  }, [run?.status])

  const again = async () => {
    if (!run) return
    try {
      await agentsApi.startRun(agent.id, { task: run.task, draft: run.version === null, dryRun: run.dryRun })
      void client.invalidateQueries({ queryKey: agentKeys.runs(agent.id) })
      toast('Started again')
      onClose()
    } catch (err) {
      toast(errorMessage(err))
    }
  }

  return (
    <Drawer
      onClose={onClose}
      head={
        run ? (
          <>
            <Outcome run={run} />
            <span className="dim small ellipsis">{when(run.startedAt)} · {run.model.split(':')[1] ?? run.model} · {run.steps} steps · {tokens(run.tokens.input + run.tokens.output)} tokens · {formatUsd(run.cost)}</span>
          </>
        ) : (
          <span className="spinner" />
        )
      }
      foot={
        run &&
        run.status !== 'running' && (
          <button className="btn" onClick={() => void again()}><Icon name="rotate-ccw" size={13} />Run again</button>
        )
      }
    >
      {query.error && <p className="form-error">{errorMessage(query.error)}</p>}
      {query.data && <Timeline run={query.data.run} steps={query.data.steps} />}
    </Drawer>
  )
}

function Timeline({ run, steps }: { run: Run; steps: RunStep[] }) {
  return (
    <ol className="a-timeline">
      <TimelineItem icon={TRIGGER_ICON[run.trigger.kind] ?? 'play'} title={`${run.trigger.label}${run.version ? ` · v${run.version}` : ' · draft'}${run.dryRun ? ' · dry run' : ''}`} at={run.startedAt}>
        <pre className="a-pre">{run.task}</pre>
      </TimelineItem>
      {steps.map((s) => <StepItem key={s.seq} step={s} />)}
      {run.status === 'running' && <TimelineItem icon="circle-dashed" title="Working…" spinner />}
      {run.finishedAt && (
        <TimelineItem icon={RUN_STATUS[run.status].icon} title={RUN_STATUS[run.status].label} at={run.finishedAt}>
          {run.error && <p className="a-error">{run.error}</p>}
          {run.retriedAs && <p className="muted small">Retried as another run.</p>}
          {run.status === 'max_steps' && <p className="muted small">The agent used all its steps. Raise the limit in Settings or simplify the task.</p>}
        </TimelineItem>
      )}
    </ol>
  )
}

function StepItem({ step }: { step: RunStep }) {
  const [open, setOpen] = useState(false)
  if (step.kind === 'model') {
    const d = step.detail as Extract<RunStep, { kind: 'model' }>['detail'] & { cost?: number }
    const title = d.calls.length ? `Decided to use ${d.calls.map((c) => c.toolName).join(', ')}` : 'Answered'
    return (
      <TimelineItem icon="sparkles" title={title} at={step.at} meta={`${tokens(d.tokens.input + d.tokens.output)} tokens${d.cost ? ` · ${formatUsd(d.cost)}` : ''}`}>
        {d.text && <div className="a-answer">{d.text}</div>}
      </TimelineItem>
    )
  }
  if (step.kind === 'tool') {
    const d = step.detail as Extract<RunStep, { kind: 'tool' }>['detail']
    const failed = !!d.output && typeof d.output === 'object' && 'error' in (d.output as object)
    return (
      <TimelineItem icon="wrench" title={d.tool} at={step.at} meta={failed ? 'error' : undefined} onToggle={() => setOpen(!open)} open={open}>
        <div className="a-sub">{summarize(d.input)}</div>
        {open && (
          <>
            <div className="a-label">Input</div>
            <pre className="a-pre">{JSON.stringify(d.input, null, 2)}</pre>
            <div className="a-label">Result</div>
            <pre className="a-pre">{JSON.stringify(d.output, null, 2)}</pre>
          </>
        )}
      </TimelineItem>
    )
  }
  if (step.kind === 'approval_requested') {
    const d = step.detail as { label?: string; input?: unknown; waitHours?: number }
    return (
      <TimelineItem icon="clock" title={`Waiting for approval: ${d.label ?? ''}`} at={step.at} meta={d.waitHours ? `up to ${d.waitHours}h` : undefined}>
        <pre className="a-pre">{JSON.stringify(d.input, null, 2)}</pre>
      </TimelineItem>
    )
  }
  if (step.kind === 'memory') {
    const d = step.detail as { subject?: string; facts?: string[] }
    return (
      <TimelineItem icon="sparkles" title={`Remembered ${d.facts?.length ?? 0} fact${d.facts?.length === 1 ? '' : 's'} about ${d.subject ?? 'the sender'}`} at={step.at}>
        <ul className="a-facts">{d.facts?.map((f, i) => <li key={i}>{f}</li>)}</ul>
      </TimelineItem>
    )
  }
  if (step.kind === 'approval_reminder') {
    const d = step.detail as { waitedHours?: number; leftHours?: number }
    return <TimelineItem icon="clock" title="Reminded the approvers" at={step.at} meta={d.leftHours ? `waits ${d.leftHours}h more` : undefined} />
  }
  if (step.kind === 'approved' || step.kind === 'rejected') {
    const d = step.detail as { note?: string | null; edited?: boolean }
    return (
      <TimelineItem icon={step.kind === 'approved' ? 'circle-check' : 'circle-x'} title={step.kind === 'approved' ? (d.edited ? 'Approved with edits' : 'Approved') : 'Not approved'} at={step.at}>
        {d.note && <div className="a-sub">“{d.note}”</div>}
      </TimelineItem>
    )
  }
  if (step.kind === 'filter') {
    const d = step.detail as { condition?: string; answer?: string; pass?: boolean }
    return (
      <TimelineItem icon="sparkles" title={d.pass ? 'AI filter: matches' : 'AI filter: no match'} at={step.at}>
        <div className="a-sub">{d.answer}</div>
      </TimelineItem>
    )
  }
  return <TimelineItem icon="info" title={step.kind} at={step.at}><pre className="a-pre">{JSON.stringify(step.detail, null, 2)}</pre></TimelineItem>
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const parts = Object.entries(input as Record<string, unknown>).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
  return parts.join(' · ').slice(0, 160) || 'No input'
}

function TimelineItem({ icon, title, at, meta, children, spinner, onToggle, open }: { icon: IconName; title: string; at?: string; meta?: string; children?: ReactNode; spinner?: boolean; onToggle?: () => void; open?: boolean }) {
  const head = (
    <>
      <span className="a-tl-title">{title}</span>
      {meta && <span className={`a-tl-meta${meta === 'error' ? ' err' : ''}`}>{meta}</span>}
      {at && <span className="a-tl-at">{new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
      {onToggle && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />}
    </>
  )
  return (
    <li className="a-tl">
      <span className="a-tl-dot">{spinner ? <span className="spinner" /> : <Icon name={icon} size={13} />}</span>
      <div className="a-tl-body">
        {onToggle ? <button className="a-tl-head" onClick={onToggle} aria-expanded={open}>{head}</button> : <div className="a-tl-head">{head}</div>}
        {children}
      </div>
    </li>
  )
}

function Drawer({ head, foot, children, onClose }: { head: ReactNode; foot?: ReactNode; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <aside className="a-drawer" role="dialog" aria-modal="false">
      <div className="a-drawer-head">
        {head}
        <span className="grow" />
        <button className="x-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
      </div>
      <div className="a-drawer-body">{children}</div>
      {foot && <div className="a-drawer-foot">{foot}</div>}
    </aside>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Test drawer

function TestDrawer({
  agent,
  initialTask = '',
  onClose,
  onOpenRun,
  onActivate,
}: {
  agent: Agent
  initialTask?: string
  onClose: () => void
  onOpenRun: (runId: string) => void
  onActivate: () => Promise<void>
}) {
  const client = useQueryClient()
  const [task, setTask] = useState(initialTask)
  const [activating, setActivating] = useState(false)
  const [draft, setDraft] = useState(true)
  const [dryRun, setDryRun] = useState(true)
  const [runId, setRunId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = useQuery({
    queryKey: agentKeys.run(agent.id, runId ?? ''),
    queryFn: () => agentsApi.run(agent.id, runId!),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && q.state.data.run.status !== 'running' ? false : 1500),
  })

  const start = async () => {
    if (!task.trim()) return setError('Write a task for the agent, like an email it received or a question.')
    setBusy(true)
    setError('')
    try {
      const { runId: id } = await agentsApi.startRun(agent.id, { task, draft, dryRun })
      setRunId(id)
      void client.invalidateQueries({ queryKey: agentKeys.runs(agent.id) })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const done = run.data && run.data.run.status !== 'running'
  return (
    <Drawer
      onClose={onClose}
      head={
        <span className="a-drawer-title">
          <Icon name="flask-conical" size={14} />Test {agent.name}
        </span>
      }
      foot={
        runId ? (
          <>
            <button className="btn btn-quiet" onClick={() => setRunId(null)}>New test</button>
            {done && <button className="btn" onClick={() => onOpenRun(runId)}>Open in Runs</button>}
            {done && (agent.status !== 'active' || agent.hasDraftChanges) && (
              <button
                className="btn btn-primary"
                disabled={activating}
                title="Publish the draft and turn the agent on, so its triggers start runs"
                onClick={() => {
                  setActivating(true)
                  void onActivate().finally(() => setActivating(false))
                }}
              >
                {activating && <span className="spinner" />}
                {agent.status === 'active' ? 'Publish' : 'Publish and turn on'}
              </button>
            )}
          </>
        ) : (
          <>
            <span className="err" role="alert">{error}</span>
            <button className="btn btn-primary" disabled={busy} onClick={() => void start()}>
              {busy ? <span className="spinner" /> : <Icon name="play" size={13} />}Run test
            </button>
          </>
        )
      }
    >
      {!runId ? (
        <div className="a-test">
          <label className="field">
            What should the agent work on?
            <textarea
              className="text-input a-textarea"
              autoFocus
              rows={7}
              placeholder="Paste an email the agent received, or ask it something: “Who in the team handles refunds?”"
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
          </label>
          <label className="a-check">
            <input type="checkbox" checked={draft} disabled={!agent.publishedVersion} onChange={(e) => setDraft(e.target.checked)} />
            <span>
              Use the draft
              <span className="dim small"> · {agent.publishedVersion ? (draft ? 'runs as you' : `runs v${agent.publishedVersion} as its publisher`) : 'not published yet'}</span>
            </span>
          </label>
          <label className="a-check">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
            <span>
              Dry run<span className="dim small"> · tools that change anything, or save to memory, are skipped</span>
            </span>
          </label>
        </div>
      ) : run.data ? (
        <>
          <div className="a-test-status"><Outcome run={run.data.run} /></div>
          <Timeline run={run.data.run} steps={run.data.steps} />
        </>
      ) : (
        <div className="loading"><span className="spinner" /></div>
      )}
    </Drawer>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Setup tab: instructions and tools. Saved to the draft as you edit.

function useDraftSaver(agent: Agent, onSaved: (a: Agent) => void) {
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pending = useRef<AgentConfig | null>(null)
  const flush = async () => {
    const config = pending.current
    if (!config) return
    pending.current = null
    setState('saving')
    try {
      onSaved((await agentsApi.update(agent.id, { config })).agent)
      setState('idle')
    } catch (err) {
      setState('error')
      toast(errorMessage(err))
    }
  }
  useEffect(() => () => {
    clearTimeout(timer.current)
    void flush()
  }, [])
  const save = (config: AgentConfig, delay = 700) => {
    pending.current = config
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), delay)
  }
  return { save, state }
}

function SetupTab({
  orgId,
  admin,
  agent,
  mailboxes,
  onSaved,
  openVersions,
  onOpenRun,
}: {
  orgId: string
  admin: boolean
  agent: Agent
  mailboxes: Mailbox[]
  onSaved: (a: Agent) => void
  openVersions: () => void
  onOpenRun: (runId: string) => void
}) {
  const [config, setConfig] = useState(agent.draft)
  const { save, state } = useDraftSaver(agent, onSaved)
  const catalog = useQuery({ queryKey: agentKeys.tools(orgId), queryFn: () => agentsApi.tools(orgId), staleTime: Infinity })
  const update = (next: AgentConfig, delay?: number) => {
    setConfig(next)
    save(next, delay)
  }
  const groups = useMemo(() => {
    const m = new Map<string, ToolInfo[]>()
    for (const t of catalog.data?.tools ?? []) m.set(t.group, [...(m.get(t.group) ?? []), t])
    return [...m]
  }, [catalog.data])

  return (
    <div className="a-body">
      <TriggersSection agent={agent} mailboxes={mailboxes} onOpenRun={onOpenRun} />
      <section className="a-section">
        <SectionHead title="Instructions" sub="What the agent follows every time it runs." />
        <div className="card a-editor">
          <textarea
            className="a-instructions"
            rows={10}
            placeholder={'You are the support agent for our store. Answer product and order questions in the customer’s language.\n\nLook up the customer before answering. Keep replies under 80 words.'}
            value={config.instructions}
            onChange={(e) => update({ ...config, instructions: e.target.value })}
            onBlur={() => save(config, 0)}
          />
          <div className="a-editor-foot">
            <span className={agent.hasDraftChanges ? 'a-unpub' : 'dim'}>
              {state === 'saving' ? 'Saving…' : state === 'error' ? "Couldn't save" : agent.hasDraftChanges ? 'Unpublished changes' : agent.publishedVersion ? 'Published' : 'Not published yet'}
            </span>
            <span className="dim">~{Math.ceil(config.instructions.length / 4)} tokens</span>
            {agent.publishedVersion && <button className="a-link" onClick={openVersions}>Version history</button>}
          </div>
        </div>
      </section>
      <section className="a-section">
        <SectionHead title="Tools" sub="What can this agent use? Each tool works with the access of the person the run acts for." />
        <div className="card">
          <div className="card-row a-group-row">
            <span className="s-tile a-avatar">x</span>
            <div className="text">
              <span className="name">xstate</span>
              <span className="sub">Built in. Works on this organization's mail, contacts, storage and calendar, in the mailboxes set in Settings.</span>
            </div>
          </div>
          {groups.map(([group, tools]) =>
            tools.map((t) => {
              const on = config.tools.builtin.includes(t.name)
              const asks = !t.readOnly && (config.tools.approval[t.name] ?? t.defaultApproval) === 'always'
              return (
                <div className="card-row a-tool-row" key={t.name}>
                  <div className="text">
                    <span className="name">{t.label} <span className="dim small">· {group}{t.readOnly ? '' : ' · changes things'}</span></span>
                    <span className="sub ellipsis" title={t.description}>{t.description}</span>
                  </div>
                  {!t.readOnly && (
                    <label className={`a-needs${on ? '' : ' off'}`} title={on ? undefined : 'Turn the tool on first'}>
                      <input
                        type="checkbox"
                        checked={asks}
                        disabled={!on}
                        onChange={(e) => update({ ...config, tools: { ...config.tools, approval: { ...config.tools.approval, [t.name]: e.target.checked ? 'always' : 'never' } } }, 0)}
                      />
                      Needs approval
                    </label>
                  )}
                  <button
                    className="switch"
                    role="switch"
                    aria-checked={on}
                    aria-label={`${on ? 'Turn off' : 'Turn on'} ${t.label}`}
                    onClick={() =>
                      update({ ...config, tools: { ...config.tools, builtin: on ? config.tools.builtin.filter((n) => n !== t.name) : [...config.tools.builtin, t.name] } }, 0)
                    }
                  />
                </div>
              )
            }),
          )}
        </div>
        <ConnectorTools orgId={orgId} admin={admin} config={config} update={update} />
      </section>
    </div>
  )
}

function SectionHead({ title, sub, aside }: { title: string; sub?: string; aside?: ReactNode }) {
  return (
    <div className="a-section-head">
      <div>
        <h2>{title}</h2>
        {sub && <p>{sub}</p>}
      </div>
      {aside}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Settings tab: model, limits, developer, danger zone

function SettingsTab({
  orgId,
  admin,
  agent,
  mailboxes,
  onSaved,
  onDelete,
}: {
  orgId: string
  admin: boolean
  agent: Agent
  mailboxes: Mailbox[]
  onSaved: (a: Agent) => void
  onDelete: () => void
}) {
  const navigate = useNavigate()
  const members = useMembers(orgId, true).data ?? []
  // A config saved before Phase 5 has no spend or memory settings yet.
  const [config, setConfig] = useState<AgentConfig>(() => ({
    ...agent.draft,
    spend: agent.draft.spend ?? { monthlyCapUsd: null, whenReached: 'pause' },
    memory: agent.draft.memory ?? { enabled: false, retentionDays: 90 },
  }))
  const { save, state } = useDraftSaver(agent, onSaved)
  const models = useQuery({ queryKey: agentKeys.models(orgId), queryFn: () => agentsApi.models(orgId) })
  const update = (next: AgentConfig, delay?: number) => {
    setConfig(next)
    save(next, delay)
  }
  const providers: ModelChoice[] = models.data?.providers ?? []
  const value = config.model ? `${config.model.provider}:${config.model.id}` : ''
  const known = providers.some((p) => p.provider === config.model?.provider && p.models.includes(config.model.id))

  return (
    <div className="a-body narrow">
      <section className="a-section">
        <SectionHead title="Model" sub={state === 'saving' ? 'Saving…' : 'Changes go to the draft. Publish to use them in real runs.'} />
        <div className="card">
          <div className="card-row a-field-row">
            <div className="text">
              <span className="name">Model</span>
              <span className="sub">From your organization's AI keys.</span>
            </div>
            {providers.length ? (
              <select
                className="select a-select"
                value={value}
                onChange={(e) => {
                  const [provider, ...id] = e.target.value.split(':')
                  update({ ...config, model: e.target.value ? { provider: provider as 'anthropic' | 'openai', id: id.join(':') } : null }, 0)
                }}
              >
                <option value="">Pick a model…</option>
                {config.model && !known && <option value={value}>{config.model.id} (not available)</option>}
                {providers.map((p) => (
                  <optgroup key={p.provider} label={`${PROVIDER_LABEL[p.provider]}${p.status !== 'valid' ? ` · ${p.statusDetail ?? p.status}` : ''}`}>
                    {p.models.map((m) => <option key={m} value={`${p.provider}:${m}`}>{m}</option>)}
                  </optgroup>
                ))}
              </select>
            ) : models.isLoading ? (
              <span className="spinner" />
            ) : (
              <button className="btn" disabled={!admin} title={admin ? undefined : 'Ask an owner or admin to add one'} onClick={() => void navigate({ to: '/settings/$section', params: { section: 'ai-providers' } })}>
                Connect an AI provider
              </button>
            )}
          </div>
        </div>
      </section>
      <section className="a-section">
        <SectionHead title="Mailboxes" sub="Where the agent may read and act. Mailboxes its email triggers watch are always included." />
        <div className="card">
          {mailboxes.length ? (
            mailboxes.map((m) => {
              const on = config.mailboxes.includes(m.id)
              return (
                <label className="card-row a-check-row" key={m.id}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => update({ ...config, mailboxes: on ? config.mailboxes.filter((x) => x !== m.id) : [...config.mailboxes, m.id] }, 0)}
                  />
                  <div className="text">
                    <span className="name">{m.address}</span>
                    <span className="sub">{m.kind === 'personal' ? 'Personal mailbox' : m.kind === 'shared' ? 'Shared mailbox' : 'Agent mailbox'}</span>
                  </div>
                </label>
              )
            })
          ) : (
            <div className="card-row"><div className="text"><span className="sub">You don't have access to any mailboxes yet.</span></div></div>
          )}
        </div>
      </section>
      <section className="a-section">
        <SectionHead title="Approvals" sub="For tools set to “Needs approval” in Setup." />
        <div className="card">
          <NumberRow
            label="Wait for a decision"
            sub="Hours before the request runs out (1 to 168)."
            value={config.approvals.timeoutHours}
            min={1}
            max={168}
            onChange={(n) => update({ ...config, approvals: { ...config.approvals, timeoutHours: n } })}
          />
          <div className="card-row a-field-row">
            <div className="text">
              <span className="name">When nobody decides</span>
              <span className="sub">Refuse the call, or remind the approvers and keep waiting (up to 7 days in all).</span>
            </div>
            <div className="seg">
              {(['reject', 'wait'] as const).map((v) => (
                <button key={v} aria-pressed={config.approvals.onTimeout === v} onClick={() => update({ ...config, approvals: { ...config.approvals, onTimeout: v } }, 0)}>
                  {v === 'reject' ? 'Refuse it' : 'Keep waiting'}
                </button>
              ))}
            </div>
          </div>
          <div className="card-row a-field-row a-approvers">
            <div className="text">
              <span className="name">Approvers</span>
              <span className="sub">{config.approvals.approvers.length ? 'Only these people (and owners and admins).' : 'Anyone who can manage agents.'}</span>
            </div>
            <div className="a-chips">
              {members
                .filter((m) => m.status === 'active')
                .map((m) => {
                  const on = config.approvals.approvers.includes(m.userId)
                  return (
                    <button
                      key={m.userId}
                      className="a-chip"
                      aria-pressed={on}
                      onClick={() =>
                        update(
                          {
                            ...config,
                            approvals: {
                              ...config.approvals,
                              approvers: on ? config.approvals.approvers.filter((x) => x !== m.userId) : [...config.approvals.approvers, m.userId],
                            },
                          },
                          0,
                        )
                      }
                    >
                      {on && <Icon name="check" size={12} />}
                      {m.name || m.email}
                    </button>
                  )
                })}
            </div>
          </div>
          <label className="card-row a-check-row">
            <input
              type="checkbox"
              checked={config.approvals.notifyEmail}
              onChange={(e) => update({ ...config, approvals: { ...config.approvals, notifyEmail: e.target.checked } }, 0)}
            />
            <div className="text">
              <span className="name">Email approvers</span>
              <span className="sub">Send each approver an email when something is waiting.</span>
            </div>
          </label>
        </div>
      </section>
      <section className="a-section">
        <SectionHead title="Limits" />
        <div className="card">
          <NumberRow
            label="Max steps per run"
            sub="Model and tool calls both count. The run stops after this many."
            value={config.limits.maxSteps}
            min={1}
            max={30}
            onChange={(n) => update({ ...config, limits: { ...config.limits, maxSteps: n } })}
          />
          <NumberRow
            label="Max runs per day"
            sub="Real runs only; tests don't count. Stops a busy trigger from using up your AI credit."
            value={config.limits.maxRunsPerDay}
            min={1}
            max={10000}
            onChange={(n) => update({ ...config, limits: { ...config.limits, maxRunsPerDay: n } })}
          />
          <NumberRow
            label="Max runs per sender per hour"
            sub="For email triggers. Stops one sender from using up your AI credit."
            value={config.limits.perSenderPerHour}
            min={1}
            max={1000}
            onChange={(n) => update({ ...config, limits: { ...config.limits, perSenderPerHour: n } })}
          />
        </div>
      </section>
      <section className="a-section">
        <SectionHead title="Spend" sub="Estimated from token counts and list prices. Your AI provider’s bill is the final word." />
        <div className="card">
          <div className="card-row a-field-row">
            <div className="text">
              <span className="name">Monthly cap</span>
              <span className="sub">{config.spend.monthlyCapUsd === null ? 'No cap: the runs-per-day limit still applies.' : 'Per calendar month (UTC), tests included.'}</span>
            </div>
            <span className="a-money">
              <span className="dim">$</span>
              <MoneyInput
                value={config.spend.monthlyCapUsd}
                onChange={(n) => update({ ...config, spend: { ...config.spend, monthlyCapUsd: n } })}
              />
            </span>
          </div>
          <div className="card-row a-field-row">
            <div className="text">
              <span className="name">When the cap is reached</span>
              <span className="sub">Owners and admins get an email either way, once a month.</span>
            </div>
            <div className="seg">
              {(['pause', 'notify'] as const).map((v) => (
                <button
                  key={v}
                  aria-pressed={config.spend.whenReached === v}
                  disabled={config.spend.monthlyCapUsd === null}
                  onClick={() => update({ ...config, spend: { ...config.spend, whenReached: v } }, 0)}
                >
                  {v === 'pause' ? 'Skip runs' : 'Only notify'}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
      <section className="a-section">
        <SectionHead title="Memory" sub="Facts the agent saves between runs. See and edit them in the Memory tab." />
        <div className="card">
          <label className="card-row a-check-row">
            <input type="checkbox" checked={config.memory.enabled} onChange={(e) => update({ ...config, memory: { ...config.memory, enabled: e.target.checked } }, 0)} />
            <div className="text">
              <span className="name">Remember between runs</span>
              <span className="sub">Gives the agent tools to save, look up and delete facts, and shows it what it knows about the sender of an email.</span>
            </div>
          </label>
          <div className="card-row a-field-row">
            <div className="text">
              <span className="name">Keep facts for</span>
              <span className="sub">A fact not updated for this long is deleted.</span>
            </div>
            <select
              className="select sm"
              value={config.memory.retentionDays ?? 'never'}
              disabled={!config.memory.enabled}
              onChange={(e) => update({ ...config, memory: { ...config.memory, retentionDays: e.target.value === 'never' ? null : Number(e.target.value) } }, 0)}
            >
              {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
              {config.memory.retentionDays !== null && ![30, 90, 180, 365].includes(config.memory.retentionDays) && (
                <option value={config.memory.retentionDays}>{config.memory.retentionDays} days</option>
              )}
              <option value="never">Until deleted</option>
            </select>
          </div>
        </div>
      </section>
      <section className="a-section">
        <SectionHead title="Developer" />
        <div className="card">
          <div className="card-row">
            <div className="text">
              <span className="name">Agent ID</span>
              <span className="sub mono">{agent.id}</span>
            </div>
            <button className="btn" onClick={() => void copyText(agent.id).then((ok) => toast(ok ? 'Copied' : "Couldn't copy"))}><Icon name="copy" size={13} />Copy</button>
          </div>
        </div>
      </section>
      <section className="a-section">
        <SectionHead title="Danger zone" />
        <div className="card">
          <div className="card-row">
            <div className="text">
              <span className="name">Delete agent</span>
              <span className="sub">Removes the agent with its versions and run history.</span>
            </div>
            <button className="btn a-danger" onClick={onDelete}>Delete agent</button>
          </div>
        </div>
      </section>
    </div>
  )
}

function NumberRow({ label, sub, value, min, max, onChange }: { label: string; sub: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value))
  return (
    <div className="card-row a-field-row">
      <div className="text">
        <span className="name">{label}</span>
        <span className="sub">{sub}</span>
      </div>
      <input
        className="text-input a-number"
        inputMode="numeric"
        value={text}
        aria-label={label}
        onChange={(e) => {
          setText(e.target.value.replace(/\D/g, ''))
          const n = Number(e.target.value)
          if (Number.isInteger(n) && n >= min && n <= max) onChange(n)
        }}
        onBlur={() => setText(String(value))}
      />
    </div>
  )
}

/** A dollar amount, or empty for none. Applies once the text is a valid amount (1 to 100,000). */
function MoneyInput({ value, onChange }: { value: number | null; onChange: (n: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value))
  return (
    <input
      className="text-input a-number"
      inputMode="decimal"
      placeholder="No cap"
      aria-label="Monthly cap in US dollars"
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d.]/g, '')
        setText(t)
        if (t === '') return onChange(null)
        const n = Number(t)
        if (Number.isFinite(n) && n >= 1 && n <= 100_000) onChange(Math.round(n * 100) / 100)
      }}
      onBlur={() => setText(value === null ? '' : String(value))}
    />
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Dialogs

function RenameDialog({ agent, onClose, onSaved }: { agent: Agent; onClose: () => void; onSaved: (a: Agent) => void }) {
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description)
  const [error, setError] = useState('')
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      onSaved((await agentsApi.update(agent.id, { name, description })).agent)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
    }
  }
  return (
    <Modal title="Rename agent" onClose={onClose}>
      <form onSubmit={(e) => void save(e)} noValidate>
        <div className="modal-body">
          <label className="field">Name<input className="text-input" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">What does it do?<input className="text-input" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        </div>
        <div className="modal-foot">
          <span className="err" role="alert">{error}</span>
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary">Save</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

function VersionsDialog({ agent, onClose, onRestored }: { agent: Agent; onClose: () => void; onRestored: (a: Agent) => void }) {
  const versions = useQuery({ queryKey: [...agentKeys.one(agent.id), 'versions'], queryFn: () => agentsApi.versions(agent.id) })
  return (
    <Modal title="Version history" onClose={onClose}>
      <div className="modal-body">
        {versions.error && <p className="form-error">{errorMessage(versions.error)}</p>}
        {!versions.data && !versions.error && <div className="loading"><span className="spinner" /></div>}
        {versions.data && !versions.data.versions.length && <p className="muted">Nothing published yet.</p>}
        {versions.data?.versions.map((v) => (
          <div key={v.version} className="a-version">
            <div className="text">
              <span className="hi">
                v{v.version}
                {v.version === agent.publishedVersion && <span className="tag a-live">Live</span>}
              </span>
              <span className="dim small">
                {new Date(v.publishedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                {v.publishedBy && ` · ${v.publishedBy}`} · {v.config.model?.id ?? 'no model'} · {v.config.tools.builtin.length} tools
              </span>
            </div>
            <button
              className="btn"
              onClick={() =>
                void agentsApi.restore(agent.id, v.version).then(
                  ({ agent: next }) => {
                    onRestored(next)
                    toast(`v${v.version} copied to the draft. Publish to make it live.`)
                    onClose()
                  },
                  (err: unknown) => toast(errorMessage(err)),
                )
              }
            >
              Restore to draft
            </button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
