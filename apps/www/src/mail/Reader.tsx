// The open conversation: toolbar, messages, an agent's draft, and the reply box.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { errorMessage } from '../lib/core'
import type { Message, MessageSummary } from '../lib/types'
import { reloadFolders } from './data'
import { FileChips, readyAttachments, type PickedFile, useUploads } from './Files'
import { MessageView } from './Message'
import type { MailSource, Patch } from './source'

type Props = {
  row: MessageSummary
  source: MailSource
  ownAddress: string
  narrow: boolean
  onClose: () => void
  onChange: (row: MessageSummary, patch: Patch, message: string, leavesList?: boolean) => void
  onSeen: (row: MessageSummary, seen: boolean) => void
  onForward: (original: Message) => void
}

export const threadKey = (row: MessageSummary) => ['mail', 'thread', row.mailboxId, row.threadId] as const

/** Reply text and attachments per conversation, so switching conversations doesn't lose what was typed. */
const replies = new Map<string, { text: string; files: PickedFile[] }>()

/** Which messages start open: the newest, and any not read yet. */
const initialExpanded = (messages: Message[]) =>
  new Set(messages.flatMap((m, i) => (i === messages.length - 1 || !m.seen ? [i] : [])))

export function Reader({ row, source, ownAddress, narrow, onClose, onChange, onSeen, onForward }: Props) {
  const client = useQueryClient()
  const thread = useQuery({ queryKey: threadKey(row), queryFn: () => source.thread(row), staleTime: 30_000 })
  const messages = thread.data ?? []
  const [expanded, setExpanded] = useState<Set<number> | null>(null)
  const [showImages, setShowImages] = useState(false)
  const open = expanded ?? initialExpanded(messages)
  const latest = messages[messages.length - 1]
  const archived = row.folder === 'archive'
  const ready = thread.isSuccess

  const toggle = (i: number) => {
    const next = new Set(open)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setExpanded(next)
  }

  /** Replies to the latest message, from the conversation's own mailbox. */
  const sendReply = async (text: string, attachments: { blobId: string; name: string; type: string }[] = []) => {
    const to = replyTarget(latest, ownAddress)
    if (!to.length) throw new Error('No one to reply to.')
    const subject = /^re:/i.test(row.subject) ? row.subject : `Re: ${row.subject}`
    await source.send({ mailboxId: row.mailboxId, to, subject, text, inReplyTo: latest?.id, attachments })
    await client.invalidateQueries({ queryKey: threadKey(row) })
    void reloadFolders(client)
  }

  const clearDraft = () => {
    source.clearDraft(row)
    client.setQueryData<Message[]>(threadKey(row), (list) => list?.map((m, i) => (i === list.length - 1 ? { ...m, draft: null } : m)))
  }

  const replyBox = useRef<{ setText: (text: string) => void } | null>(null)

  return (
    <>
      <div className="col-head reader-tools drag">
        <button className="ghost" onClick={onClose} aria-label="Back to list" style={{ display: narrow ? 'flex' : 'none' }}>
          <Icon name="chevron-left" size={16} />
        </button>
        <button className="btn-tool" aria-pressed={row.pinned} onClick={() => onChange(row, { pinned: !row.pinned }, row.pinned ? 'Unpinned' : 'Pinned')}>
          <Icon name={row.pinned ? 'pin-off' : 'pin'} size={15} />
          {row.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button
          className="btn-tool"
          onClick={() => onChange(row, { folder: archived ? 'inbox' : 'archive' }, archived ? 'Moved to inbox' : 'Archived', true)}
        >
          <Icon name={archived ? 'inbox' : 'archive'} size={15} />
          {archived ? 'Move to inbox' : 'Archive'}
        </button>
        <button className="btn-tool" onClick={() => onSeen(row, !row.seen)}>
          <Icon name="circle" size={15} />
          {row.seen ? 'Mark unread' : 'Mark read'}
        </button>
        <span style={{ flex: 1 }} />
        {source.canSend && ready && latest && (
          <button className="btn-tool" onClick={() => onForward(latest)}>
            <Icon name="forward" size={15} />
            Forward
          </button>
        )}
      </div>
      <div className="reader-scroll">
        <article className="reader-body">
          <h1>{row.subject || '(no subject)'}</h1>
          {thread.isPending ? (
            <div className="empty">
              <span className="spinner" />
            </div>
          ) : thread.isError ? (
            <div className="empty">
              <Icon name="circle-alert" size={22} />
              <strong>Couldn't open this conversation</strong>
              <span className="small">{thread.error.message}</span>
            </div>
          ) : (
            messages.map((m, i) => (
              <MessageView
                key={m.id}
                message={m}
                source={source}
                open={open.has(i)}
                last={i === messages.length - 1}
                showImages={showImages}
                onToggle={() => toggle(i)}
                onShowImages={() => setShowImages(true)}
              />
            ))
          )}
          {latest?.draft && (
            <div className="draft">
              <div className="draft-head">
                <span className="by">
                  <Icon name="sparkles" size={14} />
                  Drafted by {latest.draft.agent}
                </span>
                <span className="from">From {latest.draft.from}</span>
              </div>
              <p>{latest.draft.body}</p>
              <div className="actions">
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    const body = latest.draft!.body
                    clearDraft()
                    sendReply(body)
                      .then(() => toast('Draft sent'))
                      .catch((err: unknown) => toast(errorMessage(err)))
                  }}
                >
                  <Icon name="send" size={14} />
                  Send draft
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    const body = latest.draft!.body
                    clearDraft()
                    replyBox.current?.setText(body)
                  }}
                >
                  Edit
                </button>
              </div>
            </div>
          )}
        </article>
      </div>
      {row.folder !== 'sent' && ready && (
        <ReplyBox key={`${row.mailboxId}/${row.threadId}`} row={row} source={source} from={ownAddress} send={sendReply} handle={replyBox} />
      )}
    </>
  )
}

/**
 * Who a reply goes to: the latest message's Reply-To or sender. If the latest message is one we sent, reply to
 * its recipients instead.
 */
function replyTarget(latest: Message | undefined, ownAddress: string): string[] {
  if (!latest) return []
  const fromSelf = latest.from[0]?.email?.toLowerCase() === ownAddress.toLowerCase()
  const list = fromSelf ? latest.to : latest.replyTo?.length ? latest.replyTo : latest.from
  return list.map((a) => a.email)
}

type ReplyProps = {
  row: MessageSummary
  source: MailSource
  from: string
  send: (text: string, attachments: { blobId: string; name: string; type: string }[]) => Promise<void>
  handle: React.RefObject<{ setText: (text: string) => void } | null>
}

function ReplyBox({ row, source, from, send, handle }: ReplyProps) {
  const id = `${row.mailboxId}/${row.threadId}`
  const saved = replies.get(id)
  const [text, setText] = useState(saved?.text ?? '')
  const uploads = useUploads(source, saved?.files)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    replies.set(id, { text, files: uploads.files })
  }, [id, text, uploads.files])

  useEffect(() => {
    handle.current = {
      setText: (t) => {
        setText(t)
        area.current?.focus()
      },
    }
    return () => {
      handle.current = null
    }
  }, [handle])

  // Grow with the text, up to a limit.
  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const body = text.trim()
    if (!body) return area.current?.focus()
    const ready = readyAttachments(uploads.files)
    if (ready.error !== undefined) return setError(ready.error)
    setSending(true)
    setError('')
    try {
      await send(body, ready.attachments)
      setText('')
      uploads.clear()
      replies.delete(id)
      toast('Reply sent')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="reply-wrap">
      <form className="reply" id="reply" onSubmit={(e) => void submit(e)}>
        <div className="reply-from">
          From <span className="select-chip">{from}</span>
        </div>
        <textarea
          ref={area}
          id="reply-text"
          rows={2}
          placeholder={source.canSend ? 'Write a reply…' : 'Replying from xstate is coming soon'}
          aria-label="Reply"
          disabled={!source.canSend}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit()
          }}
        />
        <FileChips files={uploads.files} onRemove={uploads.remove} />
        <div className="reply-foot">
          <label className="attach" title="Attach files" hidden={!source.canSend}>
            <Icon name="paperclip" size={15} />
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) uploads.add(row.mailboxId, [...e.target.files])
                e.target.value = ''
              }}
            />
          </label>
          <span className="reply-err" role="alert">
            {error}
          </span>
          <button className="btn btn-primary" type="submit" disabled={!source.canSend || sending}>
            {sending && <span className="spinner" />}
            Send
          </button>
        </div>
      </form>
    </div>
  )
}
