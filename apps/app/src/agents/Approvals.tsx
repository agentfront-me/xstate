// Approvals tab (design: Approvals): tool calls waiting for a person. Approve as proposed, edit and approve (an email's
// recipients, subject and text, or any call's input as JSON), or reject with a note the agent reads and acts on.
// Below: the latest decisions.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { errorMessage } from '../lib/core'
import { agentKeys, approvalKeys, approvalsApi, type Agent, type Approval } from './api'

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h ago` : new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
const left = (iso: string) => {
  const m = Math.round((Date.parse(iso) - Date.now()) / 60_000)
  if (m <= 0) return 'any moment'
  return m < 60 ? `${m} min` : `${Math.round(m / 60)}h`
}

const isEmail = (tool: string) => tool === 'email_send' || tool === 'email_create_draft'
type Address = { email: string; name?: string | null }
const list = (v: unknown) => (Array.isArray(v) ? (v as Address[]).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ') : '')
const parseList = (text: string): Address[] =>
  text
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const m = /^(.*?)\s*<([^>]+)>$/.exec(t)
      return m ? { name: m[1]!.replace(/^"|"$/g, '') || null, email: m[2]!.trim() } : { email: t }
    })

export function ApprovalsTab({ agent, onOpenRun }: { agent: Agent; onOpenRun: (runId: string) => void }) {
  const pending = useQuery({ queryKey: approvalKeys.list(agent.id, 'pending'), queryFn: () => approvalsApi.list(agent.id, 'pending'), refetchInterval: 15_000 })
  const decided = useQuery({ queryKey: approvalKeys.list(agent.id, 'decided'), queryFn: () => approvalsApi.list(agent.id, 'decided') })
  const items = pending.data?.approvals ?? []
  const canDecide = pending.data?.canDecide ?? false

  return (
    <div className="a-body narrow">
      <section className="a-section">
        <div className="a-section-head">
          <div>
            <h2>Waiting for a person</h2>
            <p>
              {agent.published?.approvals.onTimeout === 'wait'
                ? 'Each request waits up to 7 days.'
                : `Requests are refused if nobody decides within ${agent.published?.approvals.timeoutHours ?? agent.draft.approvals.timeoutHours} hours.`}
              {!canDecide && pending.data && ' You can see these, but only this agent’s approvers can decide.'}
            </p>
          </div>
        </div>
        {pending.error && <p className="form-error">{errorMessage(pending.error)}</p>}
        {pending.data && !items.length && (
          <div className="card a-note">
            <Icon name="circle-check" size={15} />
            <span>Nothing is waiting. Tools set to “Needs approval” in Setup stop here before they run.</span>
          </div>
        )}
        {items.map((a) => <PendingCard key={a.id} agent={agent} approval={a} canDecide={canDecide} onOpenRun={onOpenRun} />)}
      </section>
      <section className="a-section">
        <div className="a-section-head"><div><h2>History</h2></div></div>
        {decided.data && !decided.data.approvals.length && <p className="dim small">No decisions yet.</p>}
        {!!decided.data?.approvals.length && (
          <div className="card">
            {decided.data.approvals.map((a) => (
              <div className="card-row" key={a.id}>
                <div className="text">
                  <span className="name ellipsis">{summary(a)}</span>
                  <span className="sub">
                    {a.decidedBy ?? (a.status === 'expired' ? 'Nobody' : '—')} · {a.decidedAt ? ago(a.decidedAt) : ''}
                    {a.note && ` · “${a.note}”`}
                    {a.editedInput && ' · edited before approving'}
                  </span>
                </div>
                <span className={`a-decision ${a.status}`}>{a.status === 'approved' ? (a.editedInput ? 'Approved with edits' : 'Approved') : a.status === 'rejected' ? 'Rejected' : 'Ran out of time'}</span>
                <button className="a-link" onClick={() => onOpenRun(a.runId)}>Run</button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function summary(a: Approval): string {
  const i = a.input
  if (a.tool === 'email_send') return `${i.inReplyTo ? 'Reply' : i.forwardOf ? 'Forward' : 'Email'} to ${list(i.to) || 'nobody'}${i.subject ? `: ${String(i.subject)}` : ''}`
  if (a.tool === 'email_create_draft') return `Draft${i.subject ? `: ${String(i.subject)}` : ''}`
  if (a.tool === 'calendar_create_event') return `Event: ${String(i.title ?? '')}`
  return a.toolLabel
}

function PendingCard({ agent, approval: a, canDecide, onOpenRun }: { agent: Agent; approval: Approval; canDecide: boolean; onOpenRun: (runId: string) => void }) {
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const email = isEmail(a.tool)
  const [to, setTo] = useState(list(a.input.to))
  const [cc, setCc] = useState(list(a.input.cc))
  const [subject, setSubject] = useState(String(a.input.subject ?? ''))
  const [text, setText] = useState(String(a.input.text ?? ''))
  const [json, setJson] = useState(JSON.stringify(a.input, null, 2))

  const decide = async (decision: 'approve' | 'reject') => {
    let input: Record<string, unknown> | undefined
    if (decision === 'approve' && editing) {
      if (email) input = { ...a.input, to: parseList(to), ...(cc.trim() ? { cc: parseList(cc) } : {}), subject, text }
      else {
        try {
          input = JSON.parse(json) as Record<string, unknown>
        } catch {
          return toast('The input isn’t valid JSON')
        }
      }
    }
    setBusy(true)
    try {
      await approvalsApi.decide(agent.id, a.id, { decision, note: note.trim() || undefined, input })
      toast(decision === 'approve' ? 'Approved. The agent carries on.' : 'Rejected. The agent gets your note.')
      void client.invalidateQueries({ queryKey: approvalKeys.all(agent.id) })
      void client.invalidateQueries({ queryKey: agentKeys.all })
    } catch (err) {
      toast(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <div className="card a-approval">
      <div className="a-approval-head">
        <span className="s-tile"><Icon name={email ? 'mail' : a.tool.startsWith('calendar') ? 'calendar' : 'wrench'} size={15} /></span>
        <div className="text">
          <span className="name">{summary(a)}</span>
          <span className="sub">
            {a.toolLabel} · asked {ago(a.createdAt)} · {a.status === 'pending' ? `refused in ${left(a.expiresAt)} if nobody decides` : a.status}
          </span>
        </div>
        <button className="a-link" onClick={() => onOpenRun(a.runId)}>Open run</button>
      </div>
      {a.reason && <p className="a-approval-reason">“{a.reason}”</p>}
      {email && !editing && (
        <div className="a-mail-preview">
          <div><span className="dim">To</span> {list(a.input.to) || '—'}</div>
          {!!list(a.input.cc) && <div><span className="dim">Cc</span> {list(a.input.cc)}</div>}
          <div><span className="dim">Subject</span> {String(a.input.subject ?? '')}</div>
          <pre className="a-pre">{String(a.input.text ?? '')}</pre>
        </div>
      )}
      {email && editing && (
        <div className="a-form a-mail-edit">
          <label className="field">To<input className="text-input" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="field">Cc<input className="text-input" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="None" /></label>
          <label className="field">Subject<input className="text-input" value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
          <label className="field">Message<textarea className="text-input a-textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)} /></label>
        </div>
      )}
      {!email && !editing && <pre className="a-pre">{JSON.stringify(a.input, null, 2)}</pre>}
      {!email && editing && <textarea className="text-input a-textarea mono small" rows={10} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />}
      {canDecide && (
        <div className="a-approval-foot">
          <input className="text-input" placeholder="Note (sent back to the agent if you reject)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn a-danger" disabled={busy} onClick={() => void decide('reject')}>Reject</button>
          {editing ? (
            <button className="btn btn-quiet" disabled={busy} onClick={() => setEditing(false)}>Cancel edits</button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => setEditing(true)}><Icon name="pencil" size={13} />Edit</button>
          )}
          <button className="btn btn-primary" disabled={busy} onClick={() => void decide('approve')}>{editing ? 'Approve with edits' : 'Approve'}</button>
        </div>
      )}
    </div>
  )
}
