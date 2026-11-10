// Memory tab (design: Memory): facts the agent saved with memory_remember, grouped by who or what they're about.
// People can search, add, edit and delete them. Memory is turned on, and its retention set, in the agent's Settings.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { errorMessage } from '../lib/core'
import { ConfirmDialog } from '../storage/dialogs'
import { agentKeys, memoryApi, type Agent, type Fact } from './api'

const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })

export function MemoryTab({ agent, onOpenRun, onOpenSettings }: { agent: Agent; onOpenRun: (runId: string) => void; onOpenSettings: () => void }) {
  const client = useQueryClient()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [clearing, setClearing] = useState(false)
  const facts = useQuery({ queryKey: agentKeys.memory(agent.id, query.trim()), queryFn: () => memoryApi.list(agent.id, query.trim()), placeholderData: (prev) => prev })
  const refresh = () => void client.invalidateQueries({ queryKey: ['agents', 'memory', agent.id] })
  const enabled = (agent.published ?? agent.draft).memory?.enabled ?? false
  const retention = (agent.published ?? agent.draft).memory?.retentionDays
  const groups = useMemo(() => {
    const m = new Map<string, Fact[]>()
    for (const f of facts.data?.facts ?? []) m.set(f.subject, [...(m.get(f.subject) ?? []), f])
    return [...m]
  }, [facts.data])

  return (
    <div className="a-body">
      {!enabled && (
        <div className="card a-note">
          <Icon name="info" size={15} />
          <span>
            Memory is off{agent.draft.memory?.enabled ? ' in the published version: publish the draft to turn it on' : ''}. With it on, the agent can save facts
            between runs, like a customer’s preferences, and recall them later.{' '}
            <button className="a-link" onClick={onOpenSettings}>Memory settings</button>
          </span>
        </div>
      )}
      <div className="a-filters">
        <input className="text-input a-search" type="search" placeholder="Search memory" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search memory" />
        <span className="grow" />
        {facts.data && (
          <span className="muted small">
            {facts.data.total} fact{facts.data.total === 1 ? '' : 's'}
            {retention ? ` · kept ${retention} days after their last update` : retention === null ? ' · kept until deleted' : ''}
          </span>
        )}
        <button className="btn" onClick={() => setAdding(true)}><Icon name="plus" size={13} />Add fact</button>
        {!!facts.data?.total && <button className="btn btn-quiet" onClick={() => setClearing(true)}>Clear all</button>}
      </div>
      {adding && <FactEditor agentId={agent.id} onDone={() => { setAdding(false); refresh() }} />}
      {facts.error && <p className="form-error">{errorMessage(facts.error)}</p>}
      {facts.data && !facts.data.facts.length && !adding && (
        <div className="a-empty card">
          <Icon name="sparkles" size={20} />
          <strong>{query.trim() ? 'Nothing matches' : 'Nothing remembered yet'}</strong>
          <span>{query.trim() ? 'Try other words.' : 'Facts the agent saves appear here, grouped by who or what they’re about. You can add your own too.'}</span>
        </div>
      )}
      {groups.map(([subject, list]) => (
        <section key={subject} className="card a-mem-group">
          <div className="card-row a-group-row">
            <span className="s-tile"><Icon name={subject.includes('@') ? 'user' : 'tag'} size={14} /></span>
            <div className="text"><span className="name">{subject}</span></div>
            <span className="dim small">{list.length}</span>
          </div>
          {list.map((f) => <FactRow key={f.id} agentId={agent.id} fact={f} onOpenRun={onOpenRun} onChanged={refresh} />)}
        </section>
      ))}
      {clearing && (
        <ConfirmDialog
          title="Clear memory"
          body={`This deletes all ${facts.data?.total ?? ''} facts ${agent.name} remembers. It can't be undone.`}
          action="Clear memory"
          onClose={() => setClearing(false)}
          onConfirm={async () => {
            try {
              const { deleted } = await memoryApi.clear(agent.id)
              toast(`Deleted ${deleted} fact${deleted === 1 ? '' : 's'}`)
              refresh()
            } catch (err) {
              toast(errorMessage(err))
            }
          }}
        />
      )}
    </div>
  )
}

function FactRow({ agentId, fact, onOpenRun, onChanged }: { agentId: string; fact: Fact; onOpenRun: (runId: string) => void; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  if (editing) return <FactEditor agentId={agentId} fact={fact} onDone={() => { setEditing(false); onChanged() }} />
  return (
    <div className="card-row a-fact">
      <div className="text">
        <span className="a-fact-text">{fact.fact}</span>
        <span className="sub">
          {fact.updatedAt !== fact.createdAt ? `Updated ${day(fact.updatedAt)}` : `Saved ${day(fact.createdAt)}`}
          {fact.sourceRun ? (
            <> · <button className="a-link" onClick={() => onOpenRun(fact.sourceRun!)}>from a run</button></>
          ) : (
            ' · added by a person'
          )}
        </span>
      </div>
      <button className="ghost" aria-label="Edit fact" title="Edit" onClick={() => setEditing(true)}><Icon name="pencil" size={13} /></button>
      <button
        className="ghost"
        aria-label="Delete fact"
        title="Delete"
        onClick={() =>
          void memoryApi.remove(agentId, fact.id).then(
            () => {
              toast('Fact deleted')
              onChanged()
            },
            (err: unknown) => toast(errorMessage(err)),
          )
        }
      >
        <Icon name="trash" size={13} />
      </button>
    </div>
  )
}

function FactEditor({ agentId, fact, onDone }: { agentId: string; fact?: Fact; onDone: () => void }) {
  const [subject, setSubject] = useState(fact?.subject ?? '')
  const [text, setText] = useState(fact?.fact ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!subject.trim() || !text.trim()) return setError('Give a subject and a fact.')
    setBusy(true)
    try {
      if (fact) await memoryApi.update(agentId, fact.id, { subject, fact: text })
      else await memoryApi.add(agentId, { subject, fact: text })
      toast(fact ? 'Fact saved' : 'Fact added')
      onDone()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <form className={fact ? 'card-row a-fact-edit' : 'card a-fact-edit'} onSubmit={(e) => void save(e)} noValidate>
      <label className="field">
        About
        <input className="text-input" autoFocus={!fact} maxLength={200} placeholder="jane@customer.com, or a topic like “pricing”" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="field">
        Fact
        <textarea className="text-input a-textarea" rows={2} maxLength={1000} placeholder="Prefers replies in German." value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="a-fact-foot">
        <span className="err" role="alert">{error}</span>
        <button type="button" className="btn btn-quiet" onClick={onDone}>Cancel</button>
        <button className="btn btn-primary" disabled={busy}>{fact ? 'Save' : 'Add fact'}</button>
      </div>
    </form>
  )
}
