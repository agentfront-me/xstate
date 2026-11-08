// Add user and Edit user: name, email, phone, custom attributes, and (when adding) the website domain.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { errorMessage, isEmail } from '../lib/core'
import { Modal } from '../storage/dialogs'
import type { Person, PersonFields } from './api'

type AttrRow = { key: string; value: string }

/** Attribute values typed in the dialog: numbers and true/false keep their type, everything else is text. */
function parseValue(v: string): string | number | boolean {
  const t = v.trim()
  if (t === 'true' || t === 'false') return t === 'true'
  if (t !== '' && /^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return t
}

export function PersonDialog({
  title,
  person,
  domains,
  onSubmit,
  onClose,
}: {
  title: string
  person?: Person
  /** When adding: the domains to offer. */
  domains?: string[]
  onSubmit: (fields: PersonFields & { domain?: string }) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(person?.name ?? '')
  const [email, setEmail] = useState(person?.email ?? '')
  const [phone, setPhone] = useState(person?.phone ?? '')
  const [domain, setDomain] = useState(domains?.[0] ?? '')
  const [attrs, setAttrs] = useState<AttrRow[]>(Object.entries(person?.attributes ?? {}).map(([key, v]) => ({ key, value: String(v) })))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])

  const submit = async () => {
    const e = email.trim().toLowerCase()
    if (e && !isEmail(e)) return setError('Enter a valid email')
    if (!person && !domain.trim()) return setError('Enter the website domain this person belongs to')
    const attributes: Record<string, string | number | boolean | null> = {}
    for (const row of attrs) {
      const k = row.key.trim()
      if (!k) continue
      if (!/^[A-Za-z0-9_ .-]{1,64}$/.test(k)) return setError(`"${k}": attribute names use letters, numbers, spaces, _ . -`)
      attributes[k] = parseValue(row.value)
    }
    // Attributes removed in the dialog are removed on the person.
    for (const k of Object.keys(person?.attributes ?? {})) if (!(k in attributes)) attributes[k] = null
    setBusy(true)
    try {
      await onSubmit({
        name: name.trim() || null,
        email: e || null,
        phone: phone.trim() || null,
        attributes,
        ...(!person && { domain: domain.trim().toLowerCase() }),
      })
      onClose()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      <form onSubmit={(ev) => { ev.preventDefault(); void submit() }}>
        <div className="modal-body seg-body">
          <div className="fields">
            <label className="field">Name<input ref={first} className="text-input" value={name} maxLength={200} onChange={(ev) => setName(ev.target.value)} /></label>
            <label className="field">Email<input className="text-input" type="email" value={email} maxLength={254} onChange={(ev) => { setEmail(ev.target.value); setError(null) }} /></label>
            <label className="field">Phone<input className="text-input" value={phone} maxLength={40} placeholder="+1 555 010 0100" onChange={(ev) => setPhone(ev.target.value)} /></label>
            {!person && (
              <label className="field">
                Domain
                <input className="text-input" list="person-domains" value={domain} placeholder="example.com" onChange={(ev) => { setDomain(ev.target.value); setError(null) }} />
                <datalist id="person-domains">{(domains ?? []).map((d) => <option key={d} value={d} />)}</datalist>
              </label>
            )}
          </div>
          <div className="u-label u-label-row">
            Attributes
            <button type="button" className="btn btn-sm" onClick={() => setAttrs((a) => [...a, { key: '', value: '' }])}><Icon name="plus" size={13} />Add</button>
          </div>
          {attrs.length === 0 && <p className="dim small">No attributes. Add things like plan, company or role.</p>}
          {attrs.map((row, i) => (
            <div className="seg-row" key={i}>
              <input className="text-input sm mono" placeholder="plan" aria-label="Attribute name" value={row.key} onChange={(ev) => setAttrs((a) => a.map((x, j) => (j === i ? { ...x, key: ev.target.value } : x)))} />
              <input className="text-input sm mono grow" placeholder="pro" aria-label="Attribute value" value={row.value} onChange={(ev) => setAttrs((a) => a.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)))} />
              <button type="button" className="x-btn" aria-label="Remove attribute" onClick={() => setAttrs((a) => a.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
            </div>
          ))}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <span />
          <span className="row-gap">
            <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy && <span className="spinner" />}{person ? 'Save' : 'Add user'}</button>
          </span>
        </div>
      </form>
    </Modal>
  )
}
