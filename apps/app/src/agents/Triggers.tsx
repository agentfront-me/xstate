// Setup → Triggers (design: "When should this agent run?"): webhook, schedule and email triggers. Triggers take effect
// as soon as they're saved (they aren't part of the draft) and fire only while the agent is on; runs use the
// published version. Each trigger shows what it received lately and can send a test event (a dry run of the draft).

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Icon, type IconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { copyText, errorMessage } from '../lib/core'
import type { Mailbox } from '../lib/types'
import { ConfirmDialog, Menu, Modal, type MenuItem } from '../storage/dialogs'
import {
  triggerKeys,
  triggersApi,
  type Agent,
  type EmailConfig,
  type Frequency,
  type ScheduleConfig,
  type Trigger,
  type TriggerEvent,
  type TriggerKind,
  type WebhookConfig,
} from './api'

const KIND: Record<TriggerKind, { label: string; icon: IconName; sub: string }> = {
  email: { label: 'Email', icon: 'mail', sub: 'When mail arrives in a mailbox' },
  webhook: { label: 'Webhook', icon: 'webhook', sub: 'When another app sends a request' },
  schedule: { label: 'Schedule', icon: 'clock', sub: 'Once, on an interval, or at set times' },
}

const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return `today ${time}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}
const when = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function TriggersSection({ agent, mailboxes, onOpenRun }: { agent: Agent; mailboxes: Mailbox[]; onOpenRun: (runId: string) => void }) {
  const client = useQueryClient()
  const query = useQuery({ queryKey: triggerKeys.list(agent.id), queryFn: () => triggersApi.list(agent.id) })
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [editing, setEditing] = useState<{ kind: TriggerKind; trigger?: Trigger } | null>(null)
  const [removing, setRemoving] = useState<Trigger | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const refresh = () => void client.invalidateQueries({ queryKey: triggerKeys.list(agent.id) })
  const triggers = query.data?.triggers ?? []

  const toggle = async (t: Trigger) => {
    try {
      await triggersApi.update(agent.id, t.id, { enabled: !t.enabled })
      refresh()
    } catch (err) {
      toast(errorMessage(err))
    }
  }

  return (
    <section className="a-section">
      <div className="a-section-head">
        <div>
          <h2>Triggers</h2>
          <p>When should this agent run? Triggers work while the agent is on, and runs use the published version.</p>
        </div>
        <button
          className="btn"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu({
              x: r.right - 220,
              y: r.bottom + 4,
              items: (['email', 'webhook', 'schedule'] as const).map((k) => ({ icon: KIND[k].icon, label: KIND[k].label, run: () => setEditing({ kind: k }) })),
            })
          }}
        >
          <Icon name="plus" size={13} />Add trigger
        </button>
      </div>
      {agent.status !== 'active' && triggers.length > 0 && (
        <div className="card a-note">
          <Icon name="info" size={15} />
          <span>The agent is off, so these triggers won't start runs. Turn it on with the switch at the top.</span>
        </div>
      )}
      {query.error && <p className="form-error">{errorMessage(query.error)}</p>}
      {query.data && !triggers.length ? (
        <div className="card a-note">
          <Icon name="clock" size={15} />
          <span>No triggers yet. Add one, or run the agent yourself with <strong>Test</strong>.</span>
        </div>
      ) : (
        <div className="card">
          {triggers.map((t) => (
            <div key={t.id} className={`a-trigger-item${t.enabled ? '' : ' off'}`}>
              <div className="card-row a-trigger-row">
                <button className="a-expand" aria-expanded={open === t.id} aria-label={open === t.id ? 'Hide details' : 'Show details'} onClick={() => setOpen(open === t.id ? null : t.id)}>
                  <Icon name={open === t.id ? 'chevron-down' : 'chevron-right'} size={14} />
                </button>
                <span className="s-tile"><Icon name={KIND[t.kind].icon} size={15} /></span>
                <div className="text">
                  <span className="name">{t.kind === 'webhook' ? (t.config as WebhookConfig).name : KIND[t.kind].label}</span>
                  <span className="sub ellipsis">{t.summary}</span>
                </div>
                <span className="a-trigger-meta">
                  {t.kind === 'schedule' && t.enabled && (t.nextRunAt ? `Next ${when(t.nextRunAt)}` : 'Done')}
                  {t.kind !== 'schedule' && (t.lastFiredAt ? `Last fired ${ago(t.lastFiredAt)}` : 'Not fired yet')}
                </span>
                <button className="switch" role="switch" aria-checked={t.enabled} aria-label={t.enabled ? 'Turn trigger off' : 'Turn trigger on'} onClick={() => void toggle(t)} />
                <button
                  className="ghost"
                  aria-label="Trigger options"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    setMenu({
                      x: r.right - 220,
                      y: r.bottom + 4,
                      items: [
                        { icon: 'pencil', label: 'Edit', run: () => setEditing({ kind: t.kind, trigger: t }) },
                        { icon: 'trash', label: 'Delete', run: () => setRemoving(t) },
                      ],
                    })
                  }}
                >
                  <Icon name="ellipsis" size={15} />
                </button>
              </div>
              {open === t.id && <TriggerDetails agent={agent} trigger={t} onOpenRun={onOpenRun} onEdit={() => setEditing({ kind: t.kind, trigger: t })} />}
            </div>
          ))}
        </div>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {editing && (
        <TriggerDialog
          agentId={agent.id}
          kind={editing.kind}
          trigger={editing.trigger}
          mailboxes={mailboxes}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            refresh()
            setOpen(t.id)
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title="Delete trigger"
          body={removing.kind === 'webhook' ? 'Requests to this webhook URL will stop working. This can’t be undone.' : 'The agent will no longer run from this trigger.'}
          action="Delete trigger"
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await triggersApi.remove(agent.id, removing.id)
              refresh()
              toast('Trigger deleted')
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Details: what the trigger needs from outside, recent events, test

function TriggerDetails({ agent, trigger, onOpenRun, onEdit }: { agent: Agent; trigger: Trigger; onOpenRun: (runId: string) => void; onEdit: () => void }) {
  const client = useQueryClient()
  const events = useQuery({ queryKey: triggerKeys.events(agent.id, trigger.id), queryFn: () => triggersApi.events(agent.id, trigger.id) })
  const [payload, setPayload] = useState('{\n  "question": "Who handles refunds?"\n}')
  const [busy, setBusy] = useState(false)

  const test = async () => {
    setBusy(true)
    try {
      const { runId } = await triggersApi.test(agent.id, trigger.id, trigger.kind === 'webhook' ? payload : undefined)
      void client.invalidateQueries({ queryKey: triggerKeys.events(agent.id, trigger.id) })
      onOpenRun(runId)
    } catch (err) {
      toast(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="a-trigger-details">
      {trigger.kind === 'webhook' && <WebhookDetails agent={agent} trigger={trigger} />}
      {trigger.kind === 'schedule' && <ScheduleDetails trigger={trigger} />}
      {trigger.kind === 'email' && <EmailDetails trigger={trigger} onEdit={onEdit} />}

      <div className="a-detail-block">
        <div className="a-label">Test</div>
        {trigger.kind === 'webhook' && (
          <textarea className="text-input a-textarea mono small" rows={4} aria-label="Test payload" value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} />
        )}
        <div className="row-gap">
          <button className="btn" disabled={busy} onClick={() => void test()}>
            {busy ? <span className="spinner" /> : <Icon name="flask-conical" size={13} />}
            {trigger.kind === 'webhook' ? 'Send test event' : trigger.kind === 'email' ? 'Test with the newest email' : 'Run test now'}
          </button>
          <span className="dim small">A dry run of the draft, as you. Works while the agent is off.</span>
        </div>
      </div>

      <div className="a-detail-block">
        <div className="a-label">Recent events</div>
        {events.isLoading && <span className="spinner" />}
        {events.data && !events.data.events.length && <span className="dim small">Nothing yet.</span>}
        {events.data?.events.map((e, i) => <EventRow key={i} event={e} onOpenRun={onOpenRun} />)}
      </div>
    </div>
  )
}

function EventRow({ event, onOpenRun }: { event: TriggerEvent; onOpenRun: (runId: string) => void }) {
  const [open, setOpen] = useState(false)
  const d = event.detail
  const what =
    typeof d.subject === 'string' ? `${String(d.from ?? '')} · ${d.subject}` : typeof d.payload === 'string' ? d.payload.slice(0, 120) : typeof d.due === 'string' ? `Due ${when(d.due)}` : typeof d.task === 'string' ? d.task.slice(0, 120) : ''
  return (
    <div className="a-event">
      <button className="a-event-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`a-event-outcome ${event.outcome}`}>{event.outcome === 'started' ? 'Started a run' : event.outcome === 'test' ? 'Test' : 'Skipped'}</span>
        <span className="ellipsis dim small">{typeof d.reason === 'string' ? d.reason : what}</span>
        <span className="a-tl-at">{ago(event.at)}</span>
      </button>
      {open && (
        <div className="a-event-body">
          <pre className="a-pre">{typeof d.payload === 'string' ? d.payload : JSON.stringify(d, null, 2)}</pre>
          {event.runId && <button className="a-link" onClick={() => onOpenRun(event.runId!)}>Open run</button>}
        </div>
      )}
    </div>
  )
}

function WebhookDetails({ agent, trigger }: { agent: Agent; trigger: Trigger }) {
  const c = trigger.config as WebhookConfig
  const [revealed, setRevealed] = useState<{ secret: string; url: string } | null>(null)
  const [rotating, setRotating] = useState(false)
  const copy = async (text: string) => toast((await copyText(text)) ? 'Copied' : "Couldn't copy")
  const reveal = async () => {
    try {
      setRevealed(revealed ? null : await triggersApi.reveal(agent.id, trigger.id))
    } catch (err) {
      toast(errorMessage(err))
    }
  }
  const url = c.auth === 'url' ? (revealed?.url ?? `${trigger.webhook!.url}/••••••`) : trigger.webhook!.url
  return (
    <>
      <div className="a-detail-block">
        <div className="a-label">URL</div>
        <div className="key-line">
          <input className="text-input mono small" readOnly value={url} aria-label="Webhook URL" onFocus={(e) => e.target.select()} />
          <button className="btn" disabled={c.auth === 'url' && !revealed} onClick={() => void copy(url)}><Icon name="copy" size={13} />Copy</button>
        </div>
        <span className="dim small">
          {c.auth === 'url'
            ? 'The secret is part of this URL: anyone with the URL can start the agent. Use it for services that can’t add headers.'
            : 'POST JSON (up to 256 KB). Sign the body with the secret as X-Xstate-Signature: sha256=<hex HMAC-SHA256>, or send Authorization: Bearer <secret>.'}
        </span>
      </div>
      <div className="a-detail-block">
        <div className="a-label">Secret</div>
        <div className="key-line">
          <input className="text-input mono small" readOnly value={revealed?.secret ?? trigger.webhook!.secretHint} aria-label="Webhook secret" />
          <button className="btn icon-only" aria-label={revealed ? 'Hide secret' : 'Reveal secret'} onClick={() => void reveal()}><Icon name={revealed ? 'eye-off' : 'eye'} size={14} /></button>
          {revealed && <button className="btn" onClick={() => void copy(revealed.secret)}><Icon name="copy" size={13} />Copy</button>}
          <button className="btn" onClick={() => setRotating(true)}><Icon name="refresh-cw" size={13} />Rotate</button>
        </div>
      </div>
      <div className="a-detail-block">
        <div className="a-label">What the agent sees</div>
        <pre className="a-pre">{c.template.trim() || `Webhook "${c.name}" received this payload:\n\n{{payload}}`}</pre>
      </div>
      {rotating && (
        <ConfirmDialog
          title="Rotate secret"
          body="Make a new secret? The current one stops working right away, so update the app that calls this webhook."
          action="Rotate secret"
          onClose={() => setRotating(false)}
          onConfirm={async () => {
            try {
              setRevealed(await triggersApi.rotate(agent.id, trigger.id))
              toast('New secret created')
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </>
  )
}

function ScheduleDetails({ trigger }: { trigger: Trigger }) {
  const c = trigger.config as ScheduleConfig
  return (
    <div className="a-detail-block">
      <div className="a-label">Task each time</div>
      <pre className="a-pre">{c.task}</pre>
      <span className="dim small">
        {trigger.nextRunAt ? `Next run ${when(trigger.nextRunAt)} (your time)` : 'Won’t run again'}
        {trigger.lastFiredAt && ` · Last ran ${ago(trigger.lastFiredAt)}`}
      </span>
    </div>
  )
}

function EmailDetails({ trigger, onEdit }: { trigger: Trigger; onEdit: () => void }) {
  const c = trigger.config as EmailConfig
  const rules = [
    c.rules.from && `From contains “${c.rules.from}”`,
    c.rules.subjectContains && `Subject contains “${c.rules.subjectContains}”`,
    c.rules.hasAttachment === true && 'Has attachments',
    c.rules.hasAttachment === false && 'No attachments',
  ].filter(Boolean) as string[]
  return (
    <div className="a-detail-block">
      <div className="a-label">Rules</div>
      <span className="small">{rules.length ? rules.join(' · ') : 'Every new email in the inbox'}</span>
      {c.aiFilter && (
        <>
          <div className="a-label">AI filter <span className="dim">· one model call per email</span></div>
          <span className="small">{c.aiFilter}</span>
        </>
      )}
      <span className="dim small">
        {c.skipAutomated ? 'Skips auto-replies, bounces, mailing lists and no-reply senders.' : 'Loop guard off: automated mail starts runs too.'}{' '}
        <button className="a-link" onClick={onEdit}>Edit</button>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Create / edit

const ZONES = (() => {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return ['UTC']
  }
})()
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function defaults(kind: TriggerKind, mailboxes: Mailbox[]): WebhookConfig | ScheduleConfig | EmailConfig {
  if (kind === 'webhook') return { name: 'Webhook', auth: 'signature', template: '' }
  if (kind === 'schedule') return { frequency: 'weekly', time: '09:00', weekdays: [1], timezone: HERE, task: '' }
  return { mailboxId: mailboxes[0]?.id ?? '', rules: { from: '', subjectContains: '', hasAttachment: null }, aiFilter: '', skipAutomated: true }
}

function TriggerDialog({
  agentId,
  kind,
  trigger,
  mailboxes,
  onClose,
  onSaved,
}: {
  agentId: string
  kind: TriggerKind
  trigger?: Trigger
  mailboxes: Mailbox[]
  onClose: () => void
  onSaved: (t: Trigger) => void
}) {
  const [config, setConfig] = useState(trigger?.config ?? defaults(kind, mailboxes))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { trigger: saved } = trigger ? await triggersApi.update(agentId, trigger.id, { config }) : await triggersApi.create(agentId, kind, config)
      toast(trigger ? 'Trigger saved' : `${KIND[kind].label} trigger added`)
      onSaved(saved)
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={`${trigger ? 'Edit' : 'Add'} ${KIND[kind].label.toLowerCase()} trigger`} onClose={onClose} wide>
      <form onSubmit={(e) => void save(e)} noValidate>
        <div className="modal-body a-form">
          {kind === 'webhook' && <WebhookForm config={config as WebhookConfig} onChange={setConfig} />}
          {kind === 'schedule' && <ScheduleForm config={config as ScheduleConfig} onChange={setConfig} />}
          {kind === 'email' && <EmailForm config={config as EmailConfig} mailboxes={mailboxes} onChange={setConfig} />}
        </div>
        <div className="modal-foot">
          <span className="err" role="alert">{error}</span>
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={busy}>{trigger ? 'Save' : 'Add trigger'}</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      {label}
      {children}
      {hint && <span className="dim small">{hint}</span>}
    </label>
  )
}

function WebhookForm({ config, onChange }: { config: WebhookConfig; onChange: (c: WebhookConfig) => void }) {
  return (
    <>
      <Field label="Name">
        <input className="text-input" maxLength={80} value={config.name} onChange={(e) => onChange({ ...config, name: e.target.value })} />
      </Field>
      <Field label="How callers prove it's them">
        <select className="select" value={config.auth} onChange={(e) => onChange({ ...config, auth: e.target.value as WebhookConfig['auth'] })}>
          <option value="signature">Signature or bearer header (recommended)</option>
          <option value="url">Secret in the URL (for apps that can't add headers)</option>
        </select>
      </Field>
      <Field label="What the agent sees" hint={<>Leave empty to pass the whole payload. Use {'{{payload}}'} for all of it, or {'{{order.id}}'} for one field.</>}>
        <textarea
          className="text-input a-textarea"
          rows={5}
          placeholder={'New order {{order.id}} from {{customer.email}}. Check the stock and reply to the customer.'}
          value={config.template}
          onChange={(e) => onChange({ ...config, template: e.target.value })}
        />
      </Field>
    </>
  )
}

function ScheduleForm({ config, onChange }: { config: ScheduleConfig; onChange: (c: ScheduleConfig) => void }) {
  const set = (patch: Partial<ScheduleConfig>) => onChange({ ...config, ...patch })
  const frequency = (f: Frequency) => {
    const base = { frequency: f, timezone: config.timezone, task: config.task }
    if (f === 'once') {
      const t = new Date(Date.now() + 3_600_000)
      const local = new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
      onChange({ ...base, at: local })
    } else if (f === 'interval') onChange({ ...base, everyMinutes: 60 })
    else if (f === 'daily') onChange({ ...base, time: config.time ?? '09:00' })
    else if (f === 'weekly') onChange({ ...base, time: config.time ?? '09:00', weekdays: config.weekdays ?? [1] })
    else onChange({ ...base, cron: '0 9 * * 1-5' })
  }
  return (
    <>
      <div className="a-form-row">
        <Field label="Repeat">
          <select className="select" value={config.frequency} onChange={(e) => frequency(e.target.value as Frequency)}>
            <option value="once">Once</option>
            <option value="interval">Every few minutes or hours</option>
            <option value="daily">Every day</option>
            <option value="weekly">On some weekdays</option>
            <option value="cron">Custom (cron)</option>
          </select>
        </Field>
        <Field label="Time zone">
          <select className="select" value={config.timezone} onChange={(e) => set({ timezone: e.target.value })}>
            {!ZONES.includes(config.timezone) && <option value={config.timezone}>{config.timezone}</option>}
            {ZONES.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
          </select>
        </Field>
      </div>
      {config.frequency === 'once' && (
        <Field label="Date and time">
          <input className="text-input" type="datetime-local" value={config.at ?? ''} onChange={(e) => set({ at: e.target.value })} />
        </Field>
      )}
      {config.frequency === 'interval' && (
        <Field label="Every" hint="5 minutes to 7 days.">
          <select className="select" value={config.everyMinutes ?? 60} onChange={(e) => set({ everyMinutes: Number(e.target.value) })}>
            {[5, 10, 15, 30, 60, 120, 240, 360, 720, 1440, 4320, 10080].map((m) => (
              <option key={m} value={m}>{m < 60 ? `${m} minutes` : m < 1440 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m / 1440} day${m === 1440 ? '' : 's'}`}</option>
            ))}
          </select>
        </Field>
      )}
      {(config.frequency === 'daily' || config.frequency === 'weekly') && (
        <div className="a-form-row">
          <Field label="At">
            <input className="text-input" type="time" value={config.time ?? '09:00'} onChange={(e) => set({ time: e.target.value })} />
          </Field>
          {config.frequency === 'weekly' && (
            <div className="field">
              On
              <div className="seg a-days">
                {DAYS.map((d, i) => {
                  const on = config.weekdays?.includes(i) ?? false
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set({ weekdays: on ? (config.weekdays ?? []).filter((x) => x !== i) : [...(config.weekdays ?? []), i].sort() })}
                    >
                      {d}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
      {config.frequency === 'cron' && (
        <Field label="Cron expression" hint="Five fields: minute hour day month weekday, in the time zone above. 0 9 * * 1-5 is weekdays at 09:00.">
          <input className="text-input mono" value={config.cron ?? ''} onChange={(e) => set({ cron: e.target.value })} spellCheck={false} />
        </Field>
      )}
      <Field label="What should the agent do each time?">
        <textarea
          className="text-input a-textarea"
          rows={4}
          placeholder="Email me a summary of last week's support conversations."
          value={config.task}
          onChange={(e) => set({ task: e.target.value })}
        />
      </Field>
    </>
  )
}

function EmailForm({ config, mailboxes, onChange }: { config: EmailConfig; mailboxes: Mailbox[]; onChange: (c: EmailConfig) => void }) {
  const rules = (patch: Partial<EmailConfig['rules']>) => onChange({ ...config, rules: { ...config.rules, ...patch } })
  return (
    <>
      <Field label="Mailbox" hint="New mail in its inbox starts the agent. Mail already there doesn't.">
        {mailboxes.length ? (
          <select className="select" value={config.mailboxId} onChange={(e) => onChange({ ...config, mailboxId: e.target.value })}>
            {!mailboxes.some((m) => m.id === config.mailboxId) && <option value={config.mailboxId}>Pick a mailbox…</option>}
            {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
          </select>
        ) : (
          <span className="small">You don't have a mailbox to watch yet. Add one in Settings → Domains.</span>
        )}
      </Field>
      <div className="a-form-row">
        <Field label="From contains">
          <input className="text-input" placeholder="Any sender" value={config.rules.from} onChange={(e) => rules({ from: e.target.value })} />
        </Field>
        <Field label="Subject contains">
          <input className="text-input" placeholder="Any subject" value={config.rules.subjectContains} onChange={(e) => rules({ subjectContains: e.target.value })} />
        </Field>
        <Field label="Attachments">
          <select
            className="select"
            value={config.rules.hasAttachment === null ? 'any' : config.rules.hasAttachment ? 'yes' : 'no'}
            onChange={(e) => rules({ hasAttachment: e.target.value === 'any' ? null : e.target.value === 'yes' })}
          >
            <option value="any">Either</option>
            <option value="yes">With attachments</option>
            <option value="no">Without</option>
          </select>
        </Field>
      </div>
      <Field label="AI filter (optional)" hint="Checked by one model call per email before the agent runs. Emails that don't match show as Skipped.">
        <input
          className="text-input"
          placeholder="Only refund, return or exchange requests"
          maxLength={1000}
          value={config.aiFilter}
          onChange={(e) => onChange({ ...config, aiFilter: e.target.value })}
        />
      </Field>
      <label className="a-check">
        <input type="checkbox" checked={config.skipAutomated} onChange={(e) => onChange({ ...config, skipAutomated: e.target.checked })} />
        <span>
          Skip auto-replies, bounces, mailing lists and no-reply senders
          <span className="dim small"> · stops two automated mailboxes from replying to each other forever</span>
        </span>
      </label>
    </>
  )
}
