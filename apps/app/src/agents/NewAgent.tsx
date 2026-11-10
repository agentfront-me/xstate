// New agent (design: New agent → template → review → test and activate). Start from a template, describe the agent
// in a sentence (drafted with the organization's own AI key), or start blank. The draft is reviewed and edited here,
// then created paused and unpublished with its trigger, and the agent opens with the Test drawer on a sample task.
// Publishing and turning on happen from there.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { errorMessage } from '../lib/core'
import type { Mailbox } from '../lib/types'
import { Modal } from '../storage/dialogs'
import { agentKeys, agentsApi, formatUsd, PROVIDER_LABEL, triggersApi, type AgentConfig, type AgentDraft, type ModelChoice, type ToolInfo } from './api'

/** Set when an agent was just created, so its page opens the Test drawer on this task. */
export const pendingTest: { agentId: string; task: string } | { agentId: null } = { agentId: null }

const PREFERRED = ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'gpt-6.1-sol', 'gpt-5.4', 'gpt-5.4-mini']

function defaultModel(providers: ModelChoice[]): AgentConfig['model'] {
  const usable = providers.filter((p) => p.status === 'valid' || p.status === 'rate_limited')
  for (const id of PREFERRED) {
    const p = usable.find((x) => x.models.includes(id))
    if (p) return { provider: p.provider, id }
  }
  const p = usable.find((x) => x.models.length)
  return p ? { provider: p.provider, id: p.models[0]! } : null
}

const BLANK = (model: AgentConfig['model']): AgentDraft => ({
  template: null,
  name: '',
  description: '',
  config: {
    instructions: '',
    model,
    tools: { builtin: [], approval: {}, connectors: {}, conditions: {} },
    mailboxes: [],
    approvals: { timeoutHours: 24, onTimeout: 'reject', approvers: [], notifyEmail: true },
    limits: { maxSteps: 12, maxRunsPerDay: 500, perSenderPerHour: 10 },
    spend: { monthlyCapUsd: null, whenReached: 'pause' },
    memory: { enabled: false, retentionDays: 90 },
  },
  trigger: null,
  sampleTask: '',
  todo: [],
})

export function NewAgentDialog({ orgId, mailboxes, onClose, onCreated }: { orgId: string; mailboxes: Mailbox[]; onClose: () => void; onCreated: (id: string) => void }) {
  const templates = useQuery({ queryKey: [...agentKeys.all, 'templates', orgId], queryFn: () => agentsApi.templates(orgId), staleTime: Infinity })
  const models = useQuery({ queryKey: agentKeys.models(orgId), queryFn: () => agentsApi.models(orgId) })
  const providers = models.data?.providers ?? []
  const [model, setModel] = useState<AgentConfig['model']>(null)
  const chosenModel = model ?? defaultModel(providers)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [prompt, setPrompt] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState('')
  const [cost, setCost] = useState<number | null>(null)

  const describe = async () => {
    if (prompt.trim().length < 10) return setError('Describe what the agent should do in a sentence or two.')
    if (!chosenModel) return setError('Add an AI provider key first: the draft is written with your own key.')
    setDrafting(true)
    setError('')
    try {
      const { draft: d } = await agentsApi.draft(orgId, { prompt, model: chosenModel })
      setCost(d.cost)
      setDraft(d)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setDrafting(false)
    }
  }

  return (
    <Modal title={draft ? 'Review the new agent' : 'New agent'} onClose={onClose} wide>
      {draft ? (
        <Review
          orgId={orgId}
          mailboxes={mailboxes}
          providers={providers}
          draft={draft}
          cost={cost}
          onBack={() => setDraft(null)}
          onClose={onClose}
          onCreated={onCreated}
        />
      ) : (
        <>
          <div className="modal-body a-new">
            <section className="a-new-describe">
              <label className="field">
                Describe it
                <textarea
                  className="text-input a-textarea"
                  rows={3}
                  autoFocus
                  placeholder="Answer refund questions in support@. Anything that promises money back needs my approval."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void describe()
                  }}
                />
              </label>
              <div className="a-new-describe-foot">
                <ModelSelect providers={providers} value={chosenModel} onChange={setModel} loading={models.isLoading} />
                <span className="grow" />
                <button className="btn btn-primary" disabled={drafting || !providers.length} onClick={() => void describe()}>
                  {drafting ? <span className="spinner" /> : <Icon name="sparkles" size={13} />}
                  {drafting ? 'Drafting…' : 'Draft it'}
                </button>
              </div>
              {error && <p className="form-error">{error}</p>}
              {!models.isLoading && !providers.length && <p className="dim small">Drafting uses your organization’s AI key. Add one in Settings → AI providers, or pick a template.</p>}
            </section>
            <div className="a-new-or"><span>or start from a template</span></div>
            <div className="a-templates">
              {templates.data?.templates.map((t) => (
                <button key={t.id} className="a-template" onClick={() => setDraft({ ...t, config: { ...t.config, model: chosenModel } })}>
                  <span className="s-tile"><Icon name={t.icon as IconName} size={15} /></span>
                  <span className="a-template-text">
                    <span className="name">{t.name}</span>
                    <span className="sub">{t.blurb}</span>
                  </span>
                </button>
              ))}
              <button className="a-template" onClick={() => setDraft(BLANK(chosenModel))}>
                <span className="s-tile"><Icon name="plus" size={15} /></span>
                <span className="a-template-text">
                  <span className="name">Start blank</span>
                  <span className="sub">Write the instructions and pick tools yourself.</span>
                </span>
              </button>
            </div>
            {templates.error && <p className="form-error">{errorMessage(templates.error)}</p>}
          </div>
          <div className="modal-foot">
            <span className="dim small">The agent starts paused. You test it, then publish and turn it on.</span>
            <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </Modal>
  )
}

function ModelSelect({ providers, value, onChange, loading }: { providers: ModelChoice[]; value: AgentConfig['model']; onChange: (m: AgentConfig['model']) => void; loading?: boolean }) {
  if (loading) return <span className="spinner" />
  if (!providers.length) return <span className="dim small">No AI provider yet</span>
  return (
    <select
      className="select sm a-select"
      aria-label="Model"
      value={value ? `${value.provider}:${value.id}` : ''}
      onChange={(e) => {
        const [provider, ...id] = e.target.value.split(':')
        onChange(e.target.value ? { provider: provider as 'anthropic' | 'openai', id: id.join(':') } : null)
      }}
    >
      {!value && <option value="">Pick a model…</option>}
      {providers.map((p) => (
        <optgroup key={p.provider} label={PROVIDER_LABEL[p.provider]}>
          {p.models.map((m) => <option key={m} value={`${p.provider}:${m}`}>{m}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function triggerText(t: AgentDraft['trigger']): string {
  if (!t) return 'None: you run it by hand, or add a trigger later in Setup.'
  if (t.kind === 'email') {
    const rules = [t.config.rules.from && `from ${t.config.rules.from}`, t.config.rules.subjectContains && `subject has “${t.config.rules.subjectContains}”`, t.config.rules.hasAttachment && 'with attachments']
      .filter(Boolean)
      .join(', ')
    return `New email in the mailbox below${rules ? `, ${rules}` : ''}.${t.config.aiFilter ? ` Only when: ${t.config.aiFilter}` : ''}`
  }
  if (t.kind === 'schedule') {
    const days = t.config.frequency === 'weekly' ? `every ${(t.config.weekdays ?? [1]).map((d) => DAYS[d]).join(', ')}` : 'every day'
    return `${days.charAt(0).toUpperCase()}${days.slice(1)} at ${t.config.time} (your time zone): ${t.config.task}`
  }
  return 'A webhook: other systems post events to a URL you get after creating it.'
}

function Review({
  orgId,
  mailboxes,
  providers,
  draft: initial,
  cost,
  onBack,
  onClose,
  onCreated,
}: {
  orgId: string
  mailboxes: Mailbox[]
  providers: ModelChoice[]
  draft: AgentDraft
  cost: number | null
  onBack: () => void
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const client = useQueryClient()
  const catalog = useQuery({ queryKey: agentKeys.tools(orgId), queryFn: () => agentsApi.tools(orgId), staleTime: Infinity })
  const [d, setD] = useState(initial)
  const [withTrigger, setWithTrigger] = useState(!!initial.trigger)
  const usesMail = d.trigger?.kind === 'email' || d.config.tools.builtin.some((n) => n.startsWith('email_'))
  const [mailboxId, setMailboxId] = useState(mailboxes.length === 1 ? mailboxes[0]!.id : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const config = d.config
  const setConfig = (c: Partial<AgentConfig>) => setD({ ...d, config: { ...config, ...c } })
  const tools: ToolInfo[] = catalog.data?.tools ?? []

  const create = async () => {
    if (!d.name.trim()) return setError('Give the agent a name.')
    if (withTrigger && d.trigger?.kind === 'email' && !mailboxId) return setError('Pick the mailbox the agent watches.')
    setBusy(true)
    setError('')
    try {
      // Without an email trigger, the mailbox picked here is the one the agent may use (Settings → Mailboxes).
      const mailboxesForConfig = mailboxId && !(withTrigger && d.trigger?.kind === 'email') ? [mailboxId] : []
      const { agent } = await agentsApi.create(orgId, { name: d.name, description: d.description, config: { ...config, mailboxes: mailboxesForConfig } })
      if (withTrigger && d.trigger) {
        const t = d.trigger
        const triggerConfig =
          t.kind === 'email'
            ? { ...t.config, mailboxId }
            : t.kind === 'schedule'
              ? { ...t.config, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
              : t.config
        // The agent exists either way; a trigger that fails can be added in Setup.
        await triggersApi.create(agent.id, t.kind, triggerConfig).catch((err: unknown) => toast(`Created, but the trigger wasn’t added: ${errorMessage(err)}`))
      }
      await client.invalidateQueries({ queryKey: agentKeys.list(orgId) })
      if (d.sampleTask && config.model) Object.assign(pendingTest, { agentId: agent.id, task: d.sampleTask })
      onCreated(agent.id)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="modal-body a-new a-review">
        {cost !== null && <p className="dim small">Drafted with your {config.model ? PROVIDER_LABEL[config.model.provider] : ''} key for about {formatUsd(cost)}. Check it before you create it.</p>}
        {!!d.todo.length && (
          <div className="card a-note a-todo">
            <Icon name="info" size={15} />
            <div>
              <strong>Before you turn it on</strong>
              <ul>{d.todo.map((t, i) => <li key={i}>{t}</li>)}</ul>
            </div>
          </div>
        )}
        <div className="a-form-row">
          <label className="field">Name<input className="text-input" maxLength={80} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Support Ninja" /></label>
          <label className="field">What does it do?<input className="text-input" maxLength={300} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} /></label>
        </div>
        <label className="field">
          Instructions
          <textarea className="text-input a-textarea a-review-instructions" rows={9} value={config.instructions} onChange={(e) => setConfig({ instructions: e.target.value })} placeholder="What the agent follows every time it runs." />
        </label>
        <div className="field">
          Tools
          <div className="a-chips">
            {config.tools.builtin.length ? (
              config.tools.builtin.map((name) => {
                const t = tools.find((x) => x.name === name)
                const asks = t && !t.readOnly && (config.tools.approval[name] ?? t.defaultApproval) === 'always'
                return (
                  <span key={name} className="a-chip static" title={t?.description}>
                    {t?.label ?? name}
                    {asks && <span className="a-chip-tag">needs approval</span>}
                  </span>
                )
              })
            ) : (
              <span className="dim small">None yet: pick them in Setup.</span>
            )}
          </div>
        </div>
        <div className="field">
          Trigger
          <label className="a-check">
            <input type="checkbox" checked={withTrigger} disabled={!d.trigger} onChange={(e) => setWithTrigger(e.target.checked)} />
            <span>{triggerText(d.trigger)}</span>
          </label>
        </div>
        {usesMail && (
          <label className="field">
            {withTrigger && d.trigger?.kind === 'email' ? 'Mailbox it watches' : 'Mailbox it works in'}
            <select className="select" value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
              <option value="">{mailboxes.length ? 'Pick a mailbox…' : 'No mailboxes you can use'}</option>
              {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
            </select>
          </label>
        )}
        <div className="a-form-row">
          <div className="field">
            Model
            <ModelSelect providers={providers} value={config.model} onChange={(m) => setConfig({ model: m })} />
          </div>
          <label className="a-check a-review-memory">
            <input type="checkbox" checked={config.memory.enabled} onChange={(e) => setConfig({ memory: { ...config.memory, enabled: e.target.checked } })} />
            <span>Remember facts between runs</span>
          </label>
        </div>
      </div>
      <div className="modal-foot">
        <span className="err" role="alert">{error}</span>
        <span className="row-gap">
          <button className="btn btn-quiet" onClick={onBack}>Back</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => void create()}>
            {busy && <span className="spinner" />}Create and test
          </button>
        </span>
      </div>
    </>
  )
}
