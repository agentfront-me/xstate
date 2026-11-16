// The New mail window, also used to forward and to edit a saved draft. A forward keeps the original's attachments and
// is sent from the conversation's own mailbox; a draft is sent or saved from the mailbox it is in, and either one
// replaces it.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { useAccount } from '../lib/account'
import { errorMessage, isEmail } from '../lib/core'
import type { MailboxFolders, Message } from '../lib/types'
import { parseRecipients } from './format'
import { FileChips, type PickedFile, readyAttachments, useUploads } from './Files'
import { RecipientInput } from './RecipientInput'
import type { MailSource } from './source'

type Props = {
  source: MailSource
  mailboxes: MailboxFolders[]
  /** The message to forward (the newest in its conversation), or none for a new message. */
  forward: Message | null
  /** A saved draft to edit (its folder is Drafts). */
  draft?: Message | null
  onClose: () => void
  onSent: () => void
  onSaved: () => void
}

function forwardBody(m: Message) {
  const who = m.from.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')
  return (
    `\n\n---------- Forwarded message ----------\nFrom: ${who}\n` +
    `Date: ${new Date(m.receivedAt).toLocaleString()}\nSubject: ${m.subject}\nTo: ${m.to.map((a) => a.email).join(', ')}\n\n${m.text}`
  )
}

const joined = (list?: { email: string }[]) => (list ?? []).map((a) => a.email).join(', ')

/** A draft's own attachments, shown like files picked here so they can be removed before sending. */
const draftFiles = (draft: Message | null | undefined): PickedFile[] =>
  (draft?.attachments ?? [])
    .filter((a) => !a.inline)
    .map((a) => ({ id: a.blobId, name: a.name, size: a.size, status: 'ready', attachment: { blobId: a.blobId, name: a.name, type: a.type, size: a.size } }))

export function Composer({ source, mailboxes, forward, draft = null, onClose, onSent, onSaved }: Props) {
  const fixed = forward ?? draft
  const choices = fixed ? mailboxes.filter((mb) => mb.mailboxId === fixed.mailboxId) : mailboxes
  const [from, setFrom] = useState(choices[0]?.mailboxId ?? '')
  const account = useAccount()
  // Contact suggestions come from the API, so none in demo mode.
  const orgId = account.mode === 'live' ? account.org.id : null
  const [initial] = useState(() => ({
    to: joined(draft?.to),
    cc: joined(draft?.cc),
    bcc: joined(draft?.bcc),
    subject: draft ? draft.subject : forward ? (/^fwd?:/i.test(forward.subject) ? forward.subject : `Fwd: ${forward.subject}`) : '',
    body: draft ? draft.text : forward ? forwardBody(forward) : '',
    files: draftFiles(draft),
  }))
  const [to, setTo] = useState(initial.to)
  const [cc, setCc] = useState(initial.cc)
  const [bcc, setBcc] = useState(initial.bcc)
  const [showCc, setShowCc] = useState(!!(initial.cc || initial.bcc))
  const [subject, setSubject] = useState(initial.subject)
  const [body, setBody] = useState(initial.body)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'send' | 'save' | null>(null)
  const uploads = useUploads(source, initial.files)
  const toInput = useRef<HTMLInputElement>(null)
  const ccInput = useRef<HTMLInputElement>(null)
  const kept = forward?.attachments.filter((a) => !a.inline) ?? []

  const changed =
    to !== initial.to ||
    cc !== initial.cc ||
    bcc !== initial.bcc ||
    subject !== initial.subject ||
    body !== initial.body ||
    uploads.files.map((f) => f.id).join() !== initial.files.map((f) => f.id).join()

  /** Closing an edited draft asks whether to keep the changes; anything else just closes. */
  const close = () => {
    if (busy) return
    if (draft && changed && window.confirm('Save your changes to this draft?')) void save()
    else onClose()
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    toInput.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

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
    setBusy('send')
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
        draftId: draft?.id,
      })
      onSent()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  /** Saves to Drafts, replacing the draft being edited. Recipients may be empty, but must be valid if given. */
  const save = async () => {
    setError('')
    if (!from) return setError('Add an address first.')
    const t = parseRecipients(to, isEmail)
    const c = parseRecipients(cc, isEmail)
    const b = parseRecipients(bcc, isEmail)
    const invalid = [...t.invalid, ...c.invalid, ...b.invalid]
    if (invalid.length) return setError(`Not a valid address: ${invalid.join(', ')}`)
    const ready = readyAttachments(uploads.files, kept.reduce((sum, a) => sum + a.size, 0))
    if (ready.error !== undefined) return setError(ready.error)
    setBusy('save')
    try {
      await source.saveDraft({
        mailboxId: from,
        to: t.valid,
        cc: c.valid,
        bcc: b.valid,
        subject: subject.trim(),
        text: body,
        forwardOf: forward?.id,
        attachments: ready.attachments,
        draftId: draft?.id,
      })
      onSaved()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(null)
    }
  }

  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="compose-title" noValidate onSubmit={(e) => void submit(e)}>
        <div className="modal-head">
          <span id="compose-title">{forward ? 'Forward' : draft ? 'Draft' : 'New mail'}</span>
          <button type="button" className="x-btn" onClick={close} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-row">
          <label htmlFor="c-from">From</label>
          <select
            id="c-from"
            disabled={!!fixed}
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
          <button type="button" className="btn" disabled={!!busy} aria-busy={busy === 'save' || undefined} onClick={() => void save()}>
            {busy === 'save' && <span className="spinner" />}
            Save draft
          </button>
          <button className="btn btn-primary" type="submit" disabled={!!busy} aria-busy={busy === 'send' || undefined}>
            <Icon name="send" size={14} />
            Send
          </button>
        </div>
      </form>
    </div>
  )
}
