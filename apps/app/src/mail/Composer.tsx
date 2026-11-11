// The New mail window, also used to forward: a forward keeps the original's attachments and is sent from the
// conversation's own mailbox.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { useAccount } from '../lib/account'
import { errorMessage, isEmail } from '../lib/core'
import type { MailboxFolders, Message } from '../lib/types'
import { parseRecipients } from './format'
import { FileChips, readyAttachments, useUploads } from './Files'
import { RecipientInput } from './RecipientInput'
import type { MailSource } from './source'

type Props = {
  source: MailSource
  mailboxes: MailboxFolders[]
  /** The message to forward (the newest in its conversation), or none for a new message. */
  forward: Message | null
  onClose: () => void
  onSent: () => void
}

function forwardBody(m: Message) {
  const who = m.from.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')
  return (
    `\n\n---------- Forwarded message ----------\nFrom: ${who}\n` +
    `Date: ${new Date(m.receivedAt).toLocaleString()}\nSubject: ${m.subject}\nTo: ${m.to.map((a) => a.email).join(', ')}\n\n${m.text}`
  )
}

export function Composer({ source, mailboxes, forward, onClose, onSent }: Props) {
  const choices = forward ? mailboxes.filter((mb) => mb.mailboxId === forward.mailboxId) : mailboxes
  const [from, setFrom] = useState(choices[0]?.mailboxId ?? '')
  const account = useAccount()
  // Contact suggestions come from the API, so none in demo mode.
  const orgId = account.mode === 'live' ? account.org.id : null
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState(forward ? (/^fwd?:/i.test(forward.subject) ? forward.subject : `Fwd: ${forward.subject}`) : '')
  const [body, setBody] = useState(forward ? forwardBody(forward) : '')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const uploads = useUploads(source)
  const toInput = useRef<HTMLInputElement>(null)
  const ccInput = useRef<HTMLInputElement>(null)
  const kept = forward?.attachments.filter((a) => !a.inline) ?? []

  useEffect(() => {
    toInput.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (showCc) ccInput.current?.focus()
  }, [showCc])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (!from) return setError('Add an address first.')
    if (!source.canSend) return setError("Sending from xstate isn't available yet.")
    const t = parseRecipients(to, isEmail)
    const c = parseRecipients(cc, isEmail)
    const b = parseRecipients(bcc, isEmail)
    const invalid = [...t.invalid, ...c.invalid, ...b.invalid]
    if (invalid.length) return setError(`Not a valid address: ${invalid.join(', ')}`)
    if (!t.valid.length && !c.valid.length && !b.valid.length) {
      setError('Add at least one recipient.')
      return toInput.current?.focus()
    }
    const ready = readyAttachments(uploads.files, kept.reduce((sum, a) => sum + a.size, 0))
    if (ready.error !== undefined) return setError(ready.error)
    setSending(true)
    try {
      await source.send({
        mailboxId: from,
        to: t.valid,
        cc: c.valid,
        bcc: b.valid,
        subject: subject.trim(),
        text: body,
        forwardOf: forward?.id,
        attachments: ready.attachments,
      })
      onSent()
    } catch (err) {
      setError(errorMessage(err))
      setSending(false)
    }
  }

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="compose-title" noValidate onSubmit={(e) => void submit(e)}>
        <div className="modal-head">
          <span id="compose-title">{forward ? 'Forward' : 'New mail'}</span>
          <button type="button" className="x-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-row">
          <label htmlFor="c-from">From</label>
          <select
            id="c-from"
            disabled={!!forward}
            value={from}
            onChange={(e) => {
              setFrom(e.target.value)
              // Uploads belong to the mailbox they were made for; switching From starts the attachments over.
              if (uploads.files.length) {
                uploads.clear()
                setError('Attachments were removed because you changed the From address. Attach them again.')
              }
            }}
          >
            {choices.length ? (
              choices.map((mb) => (
                <option key={mb.mailboxId} value={mb.mailboxId}>
                  {mb.address}
                </option>
              ))
            ) : (
              <option value="">Add an address in Settings first</option>
            )}
          </select>
        </div>
        <div className="modal-row">
          <label htmlFor="c-to">To</label>
          <RecipientInput inputRef={toInput} id="c-to" placeholder="name@example.com, …" orgId={orgId} value={to} onChange={setTo} />
          {!showCc && (
            <button type="button" className="btn-quiet small" onClick={() => setShowCc(true)}>
              Cc / Bcc
            </button>
          )}
        </div>
        {showCc && (
          <>
            <div className="modal-row">
              <label htmlFor="c-cc">Cc</label>
              <RecipientInput inputRef={ccInput} id="c-cc" orgId={orgId} value={cc} onChange={setCc} />
            </div>
            <div className="modal-row">
              <label htmlFor="c-bcc">Bcc</label>
              <RecipientInput id="c-bcc" orgId={orgId} value={bcc} onChange={setBcc} />
            </div>
          </>
        )}
        <div className="modal-row">
          <label htmlFor="c-subject">Subject</label>
          <input id="c-subject" autoComplete="off" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </div>
        <textarea id="c-body" placeholder="Write your message…" aria-label="Message" value={body} onChange={(e) => setBody(e.target.value)} />
        {kept.length > 0 && (
          <div className="modal-note">
            <Icon name="paperclip" size={13} />
            {kept.length} {kept.length === 1 ? 'attachment' : 'attachments'} from the original will be included.
          </div>
        )}
        <div style={{ padding: '0 16px' }}>
          <FileChips files={uploads.files} onRemove={uploads.remove} />
        </div>
        <div className="modal-foot">
          <label className="btn" title="Attach files">
            <Icon name="paperclip" size={14} />
            Attach
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files && from) uploads.add(from, [...e.target.files])
                e.target.value = ''
              }}
            />
          </label>
          <span className="err" role="alert">
            {error}
          </span>
          <button className="btn btn-primary" type="submit" disabled={sending} aria-busy={sending || undefined}>
            <Icon name="send" size={14} />
            Send
          </button>
        </div>
      </form>
    </div>
  )
}
