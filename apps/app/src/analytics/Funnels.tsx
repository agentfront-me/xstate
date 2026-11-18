// Funnels: a funnel's result (bars per step and the step table, as in the design) and the Edit funnel dialog.
// The side list lives in AnalyticsPage.tsx. Results come from analytics_funnel_result, cached for a few minutes.

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { errorMessage } from '../lib/core'
import { Modal } from '../storage/dialogs'
import {
  EMAIL_STEPS,
  type Funnel,
  type FunnelInput,
  type FunnelRange,
  type FunnelStep,
  STEP_KIND,
  analyticsApi,
  analyticsKeys,
  duration,
  percent,
  stepLabel,
} from './api'

const RANGES: { days: FunnelRange; label: string }[] = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
]

export function FunnelView({
  orgId,
  funnelId,
  domain,
  range,
  canManage,
  onRange,
  onEdit,
  onDelete,
}: {
  orgId: string
  funnelId: string
  domain?: string
  range: FunnelRange
  canManage: boolean
  onRange: (r: FunnelRange) => void
  onEdit: (f: Funnel) => void
  onDelete: (f: Funnel) => void
}) {
  const q = useQuery({
    queryKey: [...analyticsKeys.all, 'funnel', funnelId, range, domain ?? null],
    queryFn: () => analyticsApi.funnelResult(orgId, funnelId, range, domain),
  })
  const funnel = q.data?.funnel
  const result = q.data?.result
  const first = result?.steps[0]?.people ?? 0
  const last = result?.steps.at(-1)?.people ?? 0

  return (
    <section className="s-main">
      <div className="col-head drag s-head">
        <div className="grow s-head-text">
          <span className="crumb" aria-current="page">{funnel?.name ?? 'Funnel'}</span>
          {funnel && (
            <span className="sub">
              {funnel.steps.length} steps · {funnel.windowDays} day conversion window
            </span>
          )}
        </div>
        <span className="spacer-grow" />
        <select className="select sm a-range" aria-label="Date range" value={range} onChange={(e) => onRange(Number(e.target.value) as FunnelRange)}>
          {RANGES.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
        </select>
        {canManage && funnel && (
          <>
            <button className="btn btn-sm" onClick={() => onEdit(funnel)}><Icon name="pencil" size={13} />Edit</button>
            <button className="ghost" aria-label="Delete funnel" title="Delete funnel" onClick={() => onDelete(funnel)}><Icon name="trash" size={15} /></button>
          </>
        )}
      </div>
      <div className="s-scroll">
        {q.isPending ? (
          <div className="loading"><span className="spinner" /></div>
        ) : q.isError ? (
          <div className="empty">
            <Icon name="circle-alert" size={24} />
            <strong>Couldn't load this funnel</strong>
            <span>{errorMessage(q.error)}</span>
            <button className="btn" onClick={() => void q.refetch()}>Try again</button>
          </div>
        ) : (
          <div className="a-funnel">
            <div className="a-overall">
              <span className="muted small">Overall conversion</span>
              <strong className="a-big">{percent(result!.conversion)}</strong>
              <span className="muted small">
                {last.toLocaleString()} of {first.toLocaleString()} {first === 1 ? 'person' : 'people'} completed every step
              </span>
            </div>

            <div className="a-bars" role="img" aria-label="People at each step">
              {result!.steps.map((s, i) => {
                const share = first ? s.people / first : 0
                return (
                  <div className="a-bar-col" key={i}>
                    <div className="a-bar-num">
                      <strong className="hi">{s.people.toLocaleString()}</strong>
                      <span className="muted small">{percent(share)}</span>
                    </div>
                    <div className="a-bar-track">
                      <div className="a-bar-fill" style={{ height: `${Math.max(share * 100, s.people ? 1 : 0)}%` }} />
                    </div>
                    <div className="a-bar-label small">
                      <span className="dim">{i + 1}</span> <span className="hi">{stepLabel(funnel!.steps[i]!)}</span>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="s-table a-steps" role="table" aria-label="Steps">
              <div className="s-row a-step-row s-row-head" role="row">
                <span role="columnheader">Step</span>
                <span role="columnheader" className="num">People</span>
                <span role="columnheader" className="num">From previous</span>
                <span role="columnheader" className="num">Dropped</span>
                <span role="columnheader" className="num">Median time</span>
              </div>
              {result!.steps.map((s, i) => {
                const step = funnel!.steps[i]!
                return (
                  <div className="s-row a-step-row" role="row" key={i}>
                    <span role="cell" className="a-step-name">
                      <span className="a-step-n">{i + 1}</span>
                      <span className="hi ellipsis">{stepLabel(step)}</span>
                      <span className="dim small">{STEP_KIND[step.type]}</span>
                    </span>
                    <span role="cell" className="num hi">{s.people.toLocaleString()}</span>
                    <span role="cell" className="num">{s.fromPrevious === null ? '—' : percent(s.fromPrevious)}</span>
                    <span role="cell" className="num">{s.dropped === null ? '—' : s.dropped.toLocaleString()}</span>
                    <span role="cell" className="num">{duration(s.medianSeconds)}</span>
                  </div>
                )
              })}
            </div>
            <p className="dim small">
              People who did step 1 in the {RANGES.find((r) => r.days === range)!.label.toLowerCase()}, then each next step in order within{' '}
              {funnel!.windowDays} {funnel!.windowDays === 1 ? 'day' : 'days'} of step 1.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// New funnel / Edit funnel

const blank = (type: FunnelStep['type']): FunnelStep => ({ type, match: type === 'email' ? EMAIL_STEPS[0]!.name : type === 'page' ? '/' : '' })

export function FunnelDialog({ orgId, funnel, onSave, onClose }: { orgId: string; funnel?: Funnel; onSave: (input: FunnelInput) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(funnel?.name ?? '')
  const [steps, setSteps] = useState<FunnelStep[]>(funnel?.steps ?? [blank('page'), blank('track')])
  const [windowDays, setWindowDays] = useState(funnel?.windowDays ?? 7)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null)
  useEffect(() => nameInput.current?.focus(), [])
  const options = useQuery({ queryKey: [...analyticsKeys.all, 'funnel-options'], queryFn: () => analyticsApi.funnelOptions(orgId) })

  const setStep = (i: number, s: FunnelStep) => {
    setError(null)
    setSteps((list) => list.map((x, j) => (j === i ? s : x)))
  }

  const save = async () => {
    const clean = steps.map((s) => ({ ...s, match: s.match.trim() }))
    if (!name.trim()) return setError('Name the funnel')
    if (clean.length < 2) return setError('A funnel needs at least two steps')
    if (clean.some((s) => !s.match)) return setError('Fill in every step, or remove the empty ones')
    if (clean.some((s) => s.type === 'page' && !s.match.startsWith('/'))) return setError('Page paths start with /, like /pricing or /products/*')
    if (!(windowDays >= 1 && windowDays <= 90)) return setError('The conversion window is 1 to 90 days')
    setBusy(true)
    try {
      await onSave({ name: name.trim(), steps: clean, windowDays })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={funnel ? 'Edit funnel' : 'New funnel'} onClose={onClose} wide>
      <form onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="modal-body seg-body">
          <label className="field">
            Name
            <input ref={nameInput} className="text-input" placeholder="e.g. Checkout" value={name} maxLength={60} onChange={(e) => { setName(e.target.value); setError(null) }} />
          </label>
          <div className="field">
            Steps, in order
            <div className="seg-rows">
              {steps.map((s, i) => (
                <div className="seg-row a-step-edit" key={i}>
                  <span className="a-step-n">{i + 1}</span>
                  <select className="select sm" aria-label={`Step ${i + 1} type`} value={s.type} onChange={(e) => setStep(i, blank(e.target.value as FunnelStep['type']))}>
                    <option value="page">Page</option>
                    <option value="track">Track</option>
                    <option value="email">Email</option>
                  </select>
                  {s.type === 'email' ? (
                    <select className="select sm grow" aria-label={`Step ${i + 1} email`} value={s.match} onChange={(e) => setStep(i, { ...s, match: e.target.value })}>
                      {EMAIL_STEPS.map((e) => <option key={e.name} value={e.name}>{e.label}</option>)}
                    </select>
                  ) : (
                    <input
                      className="text-input sm mono grow"
                      aria-label={`Step ${i + 1} ${s.type === 'page' ? 'path' : 'event'}`}
                      list={s.type === 'page' ? 'funnel-paths' : 'funnel-events'}
                      placeholder={s.type === 'page' ? '/products/*' : 'Order Completed'}
                      value={s.match}
                      onChange={(e) => setStep(i, { ...s, match: e.target.value })}
                    />
                  )}
                  <button type="button" className="ghost x-btn" aria-label={`Remove step ${i + 1}`} disabled={steps.length <= 2} onClick={() => setSteps((list) => list.filter((_, j) => j !== i))}>
                    <Icon name="x" size={14} />
                  </button>
                </div>
              ))}
            </div>
            <datalist id="funnel-paths">{(options.data?.paths ?? []).map((p) => <option key={p} value={p} />)}</datalist>
            <datalist id="funnel-events">{(options.data?.events ?? []).map((e) => <option key={e} value={e} />)}</datalist>
            {steps.length < 10 && (
              <div>
                <button type="button" className="btn btn-sm" onClick={() => setSteps((list) => [...list, blank('track')])}>
                  <Icon name="plus" size={13} />Add step
                </button>
              </div>
            )}
            <span className="dim small">Page paths can end in * to match a whole section, like /products/*.</span>
          </div>
          <label className="field a-window">
            Conversion window
            <span className="seg-days">
              <input className="text-input sm mono" type="number" min={1} max={90} value={windowDays || ''} onChange={(e) => { setWindowDays(Number(e.target.value)); setError(null) }} />
              <span className="muted small">days from step 1</span>
            </span>
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <span />
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy && <span className="spinner" />}Save funnel</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}
