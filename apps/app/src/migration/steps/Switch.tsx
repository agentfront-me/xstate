// 6 · Ready to switch: a live checklist. Each item is checked automatically every few seconds, and "Check again"
// forces it. The records table shows each record's state, with one-click setup when the DNS host supports it.
// Run final sync unlocks once the records are detected.

import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { errorMessage } from '../../lib/core'
import * as migrationApi from '../api'
import type { Ctx } from '../main'
import type { SwitchStatus } from '../types'
import { CopyButton, day, Notice, num, time, Title, useTick } from '../ui'

export function SwitchStep({ ctx }: { ctx: Ctx }) {
  const orgId = ctx.org.id
  const [status, setStatus] = useState<SwitchStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  // The API says when every required record is found (optional ones, like DMARC, may still be missing).
  const detected = !!status && (status.detected ?? status.records.every((r) => r.found))
  const tick = useTick(5000, !detected)
  const totals = migrationApi.copiedTotals(orgId)

  useEffect(() => {
    let live = true
    void migrationApi.checkRecords(orgId).then((s) => live && setStatus(s))
    return () => {
      live = false
    }
  }, [orgId, tick])

  const act = async (name: string, work: () => Promise<SwitchStatus | void>) => {
    setBusy(name)
    setError('')
    try {
      const s = await work()
      if (s) setStatus(s)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  if (!status) return <div className="loading"><span className="spinner" /></div>

  const domain = ctx.migration.discovery!.domain
  const someFound = status.records.some((r) => r.found)

  return (
    <>
      <Title
        title="Ready to switch"
        sub={`Everything is copied. Point ${domain}'s mail at xstate by publishing ${status.records.length} DNS records. Until then, mail keeps arriving in Google and nothing is lost.`}
        aside={
          <button className="btn btn-auto btn-sm" disabled={!!busy} onClick={() => void act('check', () => migrationApi.checkRecords(orgId))}>
            {busy === 'check' ? <span className="spinner" /> : <Icon name="refresh-cw" size={13} />}
            Check again
          </button>
        }
      />
      <ol className="checklist-m">
        <Item done title="Everything copied">
          {num(totals.users)} users, {num(totals.messages)} messages, {num(totals.contacts)} contacts, {num(totals.files)} files.
        </Item>
        <Item
          done={status.ttlDone}
          title="Lower the MX TTL a day ahead"
          optional
          aside={
            !status.ttlDone &&
            ctx.isAdmin && (
              <button className="mini" onClick={() => void act('ttl', () => migrationApi.markTtlDone(orgId))}>
                Mark done
              </button>
            )
          }
        >
          Set the TTL on your current MX records to 300 seconds so the switch takes effect quickly. Skip it if you don't mind a few hours of overlap.
        </Item>
        <Item done={detected} active={!detected} title="Publish xstate's MX, SPF, DKIM and DMARC records">
          Add these at your DNS host. Replace Google's MX records; keep any other records as they are.
          <div className="table dns-table">
            <div className="tr th" role="row">
              <span>Type</span>
              <span>Name</span>
              <span>Value</span>
              <span>Status</span>
              <span />
            </div>
            {status.records.map((r) => (
              <div className="tr" role="row" key={`${r.type}-${r.name}`}>
                <span className="mono hi">{r.type}</span>
                <span className="mono ellipsis" title={r.name}>
                  {r.name}
                </span>
                <code className="ellipsis" title={r.value}>
                  {r.value}
                </code>
                <span className={`small ${r.found ? 'hi' : 'muted'}`}>
                  {r.found ? (
                    <>
                      <Icon name="check" size={12} /> Found
                    </>
                  ) : r.required === false ? (
                    <>
                      <Icon name="circle-dashed" size={12} /> Optional
                    </>
                  ) : (
                    <>
                      <Icon name="circle-dashed" size={12} /> Waiting
                    </>
                  )}
                </span>
                <CopyButton text={r.value} label={`Copy ${r.type} value`} />
              </div>
            ))}
          </div>
          {status.provider && (ctx.demo || status.applyUrl) && !detected && ctx.isAdmin && (
            <div className="auto-setup">
              <button className="btn btn-auto btn-sm" disabled={!!busy} aria-busy={busy === 'auto' || undefined} onClick={() => void act('auto', () => migrationApi.autoSetup(orgId, status.applyUrl))}>
                {busy === 'auto' ? <span className="spinner" /> : <Icon name="sparkles" size={13} />}
                Set up automatically with {status.provider}
              </button>
              <span className="muted small">
                Your DNS is hosted at {status.provider}. One click adds all {status.records.length} records.
              </span>
            </div>
          )}
        </Item>
        <Item done={detected} active={someFound && !detected} title="Records detected">
          {detected
            ? `xstate's records resolve${status.detectedAt ? ` as of ${time(status.detectedAt)} on ${day(status.detectedAt)}` : ''}. Mail now arrives here.`
            : 'We check every few seconds. DNS changes usually show up within minutes, sometimes up to an hour.'}
        </Item>
      </ol>
      {error && <Notice kind="error">{error}</Notice>}
      <div className="actions">
        <button
          className="btn btn-primary btn-auto"
          disabled={!detected || !!busy || !ctx.isAdmin}
          aria-busy={busy === 'final' || undefined}
          onClick={() =>
            void act('final', async () => {
              await migrationApi.startFinal(orgId)
              await ctx.go('final')
            })
          }
        >
          {busy === 'final' ? <span className="spinner spinner-on-primary" /> : <Icon name="refresh-cw" size={14} />}
          Run final sync
        </button>
        <span className="muted small">
          {detected ? 'Picks up mail and files that changed in Google since the copy. Takes about 30 minutes.' : 'Available once the records are detected.'}
        </span>
      </div>
    </>
  )
}

function Item({
  done,
  active,
  title,
  optional,
  aside,
  children,
}: {
  done: boolean
  active?: boolean
  title: string
  optional?: boolean
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <li className={`ck${done ? ' is-done' : active ? ' is-active' : ''}`}>
      <span className="ck-icon">{done ? <Icon name="circle-check" size={15} /> : active ? <span className="spinner" /> : <Icon name="circle" size={15} />}</span>
      <div className="ck-body">
        <div className="ck-title">
          <span className="hi">{title}</span>
          {optional && <span className="tag">Optional</span>}
          {aside && <span className="end">{aside}</span>}
        </div>
        <div className="ck-text">{children}</div>
      </div>
    </li>
  )
}
