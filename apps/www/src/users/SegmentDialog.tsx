// The "New segment" dialog from the design: a name, Match all / any, condition rows, Add condition, and a live
// count of the people who match in the footer. Also edits a saved segment.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { errorMessage } from '../lib/core'
import { Modal } from '../storage/dialogs'
import { type AttrOp, type Condition, type Filter, type Schema, type Segment, audienceApi, audienceKeys } from './api'

const DATE_FIELDS = { last_seen: 'Last seen', first_seen: 'First seen', created: 'Created' } as const
const TEXT_FIELDS = { name: 'Name', email: 'Email', phone: 'Phone', source: 'Source', domain: 'Domain' } as const
const TEXT_OPS = { is: 'is', is_not: 'is not', contains: 'contains', is_set: 'is set', not_set: 'is not set' } as const
const ATTR_OPS: Record<string, Partial<Record<AttrOp, string>>> = {
  string: { is: 'is', is_not: 'is not', contains: 'contains', is_set: 'is set', not_set: 'is not set' },
  number: { is: 'is', gt: 'more than', lt: 'less than', is_set: 'is set', not_set: 'is not set' },
  boolean: { is_true: 'is true', is_false: 'is false', is_set: 'is set', not_set: 'is not set' },
}
const NO_VALUE = new Set(['is_set', 'not_set', 'is_true', 'is_false'])

/** The first select of a row: which kind of thing the condition looks at. */
const fieldOf = (c: Condition): string =>
  c.kind === 'date' ? `date:${c.field}` : c.kind === 'text' ? `text:${c.field}` : c.kind === 'attribute' ? `attr:${c.key}` : c.kind

function fresh(field: string, schema: Schema | undefined): Condition {
  const [kind, name = ''] = field.split(':') as [string, string?]
  if (kind === 'date') return { kind: 'date', field: name as keyof typeof DATE_FIELDS, op: 'within', days: 7 }
  if (kind === 'type') return { kind: 'type', op: 'is', value: 'user' }
  if (kind === 'text') return { kind: 'text', field: name as keyof typeof TEXT_FIELDS, op: 'is', value: '' }
  if (kind === 'event') return { kind: 'event', name: schema?.events.find((e) => !e.name.startsWith('$'))?.name ?? '', op: 'at_least', count: 1, days: 30 }
  const type = schema?.attributes.find((a) => a.key === name)?.type ?? 'string'
  return { kind: 'attribute', key: name, op: type === 'boolean' ? 'is_true' : 'is', value: '' }
}

/** Rows that can't be sent yet (an empty value) are left out of the count and block Save. */
function complete(c: Condition): boolean {
  if (c.kind === 'text') return NO_VALUE.has(c.op) || c.value.trim() !== ''
  if (c.kind === 'attribute') return !!c.key && (NO_VALUE.has(c.op) || String(c.value).trim() !== '')
  if (c.kind === 'event') return c.name.trim() !== '' && c.days >= 1 && c.days <= 90 && c.count >= 1
  if (c.kind === 'date') return c.days >= 1
  return true
}

export function SegmentDialog({
  orgId,
  segment,
  onSave,
  onClose,
}: {
  orgId: string
  segment?: Segment
  onSave: (input: { name: string; filter: Filter }) => Promise<void>
  onClose: () => void
}) {
  const schema = useQuery({ queryKey: [...audienceKeys.all, 'schema'], queryFn: () => audienceApi.schema(orgId) }).data
  const [name, setName] = useState(segment?.name ?? '')
  const [match, setMatch] = useState<Filter['match']>(segment?.filter.match ?? 'all')
  const [rows, setRows] = useState<Condition[]>(segment?.filter.conditions ?? [{ kind: 'date', field: 'last_seen', op: 'within', days: 7 }])
  const [newAttr, setNewAttr] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  useEffect(() => nameInput.current?.focus(), [])

  const filter: Filter = { match, conditions: rows.filter(complete) }
  const ready = rows.every(complete)
  const key = JSON.stringify(filter)
  const [debounced, setDebounced] = useState(key)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(key), 300)
    return () => clearTimeout(t)
  }, [key])
  const count = useQuery({
    queryKey: [...audienceKeys.all, 'count', debounced],
    queryFn: () => audienceApi.count(orgId, JSON.parse(debounced) as Filter),
    placeholderData: (prev) => prev,
  })

  const setRow = (i: number, c: Condition) => setRows((r) => r.map((x, j) => (j === i ? c : x)))

  const save = async () => {
    if (!name.trim()) return setError('Name the segment')
    if (!ready) return setError('Fill in every condition, or remove the empty ones')
    setBusy(true)
    try {
      await onSave({ name: name.trim(), filter })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const attrs = schema?.attributes ?? []
  const n = count.data?.count

  return (
    <Modal title={segment ? 'Edit segment' : 'New segment'} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="modal-body seg-body">
          <label className="field">
            Name
            <input ref={nameInput} className="text-input" placeholder="e.g. Hot leads" value={name} maxLength={60} onChange={(e) => { setName(e.target.value); setError(null) }} />
          </label>
          <div className="seg-match">
            <span className="muted">Match</span>
            <div className="seg" role="group" aria-label="Match">
              {(['all', 'any'] as const).map((m) => (
                <button key={m} type="button" aria-pressed={match === m} onClick={() => setMatch(m)}>{m}</button>
              ))}
            </div>
            <span className="muted">of the following</span>
          </div>
          <div className="seg-rows">
            {rows.map((c, i) => (
              <div className="seg-row" key={i}>
                <select
                  className="select sm"
                  aria-label="Field"
                  value={newAttr === i ? 'attr:__new' : fieldOf(c)}
                  onChange={(e) => {
                    setError(null)
                    if (e.target.value === 'attr:__new') {
                      setNewAttr(i)
                      setRow(i, { kind: 'attribute', key: '', op: 'is', value: '' })
                    } else {
                      setNewAttr(null)
                      setRow(i, fresh(e.target.value, schema))
                    }
                  }}
                >
                  <optgroup label="Person">
                    {Object.entries(DATE_FIELDS).map(([k, v]) => <option key={k} value={`date:${k}`}>{v}</option>)}
                    <option value="type">Type</option>
                    {Object.entries(TEXT_FIELDS).map(([k, v]) => <option key={k} value={`text:${k}`}>{v}</option>)}
                  </optgroup>
                  <optgroup label="Attributes">
                    {attrs.map((a) => <option key={a.key} value={`attr:${a.key}`}>{a.key}</option>)}
                    {c.kind === 'attribute' && c.key && !attrs.some((a) => a.key === c.key) && newAttr !== i && <option value={`attr:${c.key}`}>{c.key}</option>}
                    <option value="attr:__new">Other attribute…</option>
                  </optgroup>
                  <optgroup label="Activity">
                    <option value="event">did event</option>
                  </optgroup>
                </select>
                <ConditionInputs
                  c={c}
                  schema={schema}
                  naming={newAttr === i}
                  onChange={(next) => { setError(null); setRow(i, next) }}
                />
                <button type="button" className="x-btn" aria-label="Remove condition" onClick={() => { setRows((r) => r.filter((_, j) => j !== i)); if (newAttr === i) setNewAttr(null) }}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </div>
          <div>
            <button type="button" className="btn btn-sm" onClick={() => setRows((r) => [...r, fresh('date:last_seen', schema)])}>
              <Icon name="plus" size={13} />Add condition
            </button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <span className="hi small seg-count">
            {count.isError ? <span className="muted">Couldn't count</span> : n === undefined ? <span className="spinner" /> : `${n.toLocaleString()} ${n === 1 ? 'user matches' : 'users match'}`}
          </span>
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy && <span className="spinner" />}Save segment</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}

function ConditionInputs({ c, schema, naming, onChange }: { c: Condition; schema?: Schema; naming: boolean; onChange: (c: Condition) => void }) {
  switch (c.kind) {
    case 'date':
      return (
        <>
          <select className="select sm" aria-label="Operator" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}>
            <option value="within">within</option>
            <option value="not_within">more than</option>
          </select>
          <span className="seg-days">
            <input className="text-input sm mono" type="number" min={1} max={3650} aria-label="Days" value={c.days || ''} onChange={(e) => onChange({ ...c, days: Number(e.target.value) })} />
            <span className="muted small">{c.op === 'within' ? 'days' : 'days ago'}</span>
          </span>
        </>
      )
    case 'type':
      return (
        <>
          <select className="select sm" aria-label="Operator" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}>
            <option value="is">is</option>
            <option value="is_not">is not</option>
          </select>
          <select className="select sm grow" aria-label="Type" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value as typeof c.value })}>
            <option value="user">User</option>
            <option value="lead">Lead</option>
          </select>
        </>
      )
    case 'text':
      return (
        <>
          <select className="select sm" aria-label="Operator" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}>
            {Object.entries(TEXT_OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {!NO_VALUE.has(c.op) ? <input className="text-input sm grow" aria-label="Value" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value })} /> : <span className="grow" />}
        </>
      )
    case 'attribute': {
      const type = schema?.attributes.find((a) => a.key === c.key)?.type ?? 'string'
      const ops = ATTR_OPS[type] ?? ATTR_OPS.string!
      return (
        <>
          {naming && (
            <input className="text-input sm mono" placeholder="attribute" aria-label="Attribute name" value={c.key} onChange={(e) => onChange({ ...c, key: e.target.value.replace(/[^A-Za-z0-9_ .-]/g, '') })} />
          )}
          <select className="select sm" aria-label="Operator" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as AttrOp })}>
            {Object.entries(ops).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          {!NO_VALUE.has(c.op) ? (
            <input
              className="text-input sm mono grow"
              aria-label="Value"
              type={type === 'number' ? 'number' : 'text'}
              value={c.value}
              onChange={(e) => onChange({ ...c, value: type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })}
            />
          ) : <span className="grow" />}
        </>
      )
    }
    case 'event':
      return (
        <>
          <select className="select sm" aria-label="Operator" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as typeof c.op })}>
            <option value="at_least">at least</option>
            <option value="did_not">did not</option>
          </select>
          <input className="text-input sm mono grow" list="seg-events" placeholder="event_name" aria-label="Event name" value={c.name} onChange={(e) => onChange({ ...c, name: e.target.value })} />
          <datalist id="seg-events">
            {(schema?.events ?? []).map((e) => <option key={e.name} value={e.name} />)}
          </datalist>
          <span className="seg-days seg-times">
            {c.op === 'at_least' && (
              <>
                <input className="text-input sm mono" type="number" min={1} aria-label="Times" value={c.count || ''} onChange={(e) => onChange({ ...c, count: Number(e.target.value) })} />
                <span className="muted small">times in</span>
              </>
            )}
            {c.op === 'did_not' && <span className="muted small">in</span>}
            <input className="text-input sm mono" type="number" min={1} max={90} aria-label="Days" value={c.days || ''} onChange={(e) => onChange({ ...c, days: Number(e.target.value) })} />
            <span className="muted small">days</span>
          </span>
        </>
      )
  }
}
