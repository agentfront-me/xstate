// 4 · Create your addresses.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { api, errorMessage } from '../lib/core'
import type { Mailbox, MailboxKind } from '../lib/types'
import { domainName, LOCAL_PART_RE, type Data } from './state'
import { Back, Head, Help, usePending, type Message } from './ui'

const SHARED_SUGGESTIONS = ['hello', 'support', 'sales']

type Row = { key: number; local: string; kind: MailboxKind; existing?: boolean; removable?: boolean }

let nextKey = 0

/** 'Asif Khan' → 'asif'. Falls back to the sign-in email's local part. */
export function suggestedLocalPart(data: Data): string {
  const fromName = (data.user.name ?? '').trim().split(/\s+/)[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, '')
  if (LOCAL_PART_RE.test(fromName)) return fromName
  return data.user.email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'me'
}

export function AddressesStep({
  data,
  update,
  back,
  next,
}: {
  data: Data
  update: (patch: Partial<Data>) => void
  back: () => void
  next: () => void
}) {
  const domain = domainName(data)
  // What already existed when the step opened decides the button label.
  const [hadExisting] = useState(() => data.mailboxes.length > 0)
  const [rows, setRows] = useState<Row[]>(() =>
    data.mailboxes.length
      ? data.mailboxes.map((m) => ({ key: nextKey++, local: m.address.split('@')[0]!, kind: m.kind, existing: true }))
      : // New rows: the person's own address, plus hello@ pre-selected.
        [
          { key: nextKey++, local: suggestedLocalPart(data), kind: 'personal' },
          { key: nextKey++, local: 'hello', kind: 'shared', removable: true },
        ],
  )
  const [help, setHelp] = useState<Message>(null)
  const [pending, run] = usePending()
  const [focusKey, setFocusKey] = useState<number | null>(null)
  const inputs = useRef(new Map<number, HTMLInputElement>())

  useEffect(() => {
    if (focusKey === null) return
    inputs.current.get(focusKey)?.focus()
    setFocusKey(null)
  }, [focusKey])

  const toggleChip = (local: string) => {
    const at = rows.findIndex((r) => r.local === local)
    if (at === -1) setRows([...rows, { key: nextKey++, local, kind: 'shared', removable: true }])
    else if (!rows[at]!.existing) setRows(rows.filter((_, i) => i !== at))
  }

  const addCustom = () => {
    const key = nextKey++
    setRows([...rows, { key, local: '', kind: 'shared', removable: true }])
    setFocusKey(key)
  }

  const create = () =>
    run(async () => {
      let list = rows.filter((r) => r.existing || r.local.trim()).map((r) => ({ ...r, local: r.local.trim().toLowerCase() }))
      setRows(list)
      const fresh = list.filter((r) => !r.existing)
      const bad = fresh.find((r) => !LOCAL_PART_RE.test(r.local) || r.local.includes('..'))
      if (bad) return setHelp({ text: `${bad.local}@ can only use letters, numbers, dots, dashes and underscores.` })
      const dup = list.find((r, i) => list.findIndex((other) => other.local === r.local) !== i)
      if (dup) return setHelp({ text: `${dup.local}@ is in the list twice.` })
      if (!list.some((r) => r.kind === 'personal')) fresh.unshift({ key: nextKey++, local: suggestedLocalPart(data), kind: 'personal' })
      setHelp(null)

      const mailboxes = [...data.mailboxes]
      for (const r of fresh) {
        try {
          const { mailbox } = await api<{ mailbox: Mailbox }>('POST', `/email/domains/${data.domain!.id}/mailboxes`, {
            kind: r.kind,
            localPart: r.local,
            ...(r.kind === 'personal' && { ownerMemberId: data.org.memberId, displayName: data.user.name }),
          })
          mailboxes.push(mailbox)
          update({ mailboxes: [...mailboxes] })
          list = list.map((x) => (x.key === r.key ? { ...x, existing: true } : x))
          setRows(list)
        } catch (err) {
          const address = `${r.local}@${domain}`
          const message = errorMessage(err)
          return setHelp({ text: message.includes(address) ? message : `${address}: ${message}` })
        }
      }
      next()
    })

  const pendingRows = rows.some((r) => !r.existing)

  return (
    <>
      <Back onClick={back} />
      <Head title="Create your email addresses" sub="Start with yours. Add shared ones for your team if you like." />
      <div className="stack-8">
        <div className="stack-8" id="rows">
          {rows.map((r, i) => (
            <div className="addr" key={r.key}>
              <input
                ref={(el) => {
                  if (el) inputs.current.set(r.key, el)
                  else inputs.current.delete(r.key)
                }}
                value={r.local}
                aria-label="Address name"
                autoCapitalize="off"
                spellCheck={false}
                readOnly={r.existing}
                onChange={(event) => setRows(rows.map((x, j) => (j === i ? { ...x, local: event.target.value } : x)))}
              />
              <span className="at">@{domain}</span>
              {r.existing && (
                <span className="done" title="Created">
                  <Icon name="check" size={14} />
                </span>
              )}
              {r.removable && !r.existing && (
                <button type="button" className="remove" aria-label={`Remove ${r.local}@`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" className="addr-add" id="custom" onClick={addCustom}>
          <Icon name="plus" size={14} />
          Custom address
        </button>
      </div>
      <div className="chips" id="chips">
        {SHARED_SUGGESTIONS.map((local) => {
          const on = rows.some((r) => r.local === local)
          return (
            <button type="button" className="chip" key={local} aria-pressed={on} onClick={() => toggleChip(local)}>
              <Icon name={on ? 'check' : 'plus'} size={12} />
              {local}@
            </button>
          )
        })}
      </div>
      <Help id="addr-help" message={help} />
      <div className="small dim">You can add more anytime.</div>
      <button className="btn btn-primary" id="create" disabled={pending} aria-busy={pending || undefined} onClick={() => void create()}>
        {pendingRows || !hadExisting ? 'Create inbox' : 'Continue'}
      </button>
    </>
  )
}
