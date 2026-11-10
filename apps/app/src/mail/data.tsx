// Mail in the React Query cache:
//   ['mail', 'folders']                         folders and counts per mailbox (rail badge, folder list)
//   ['mail', 'list', ListKey]                   pages of conversations for one view
//   ['mail', 'thread', mailboxId, threadId]     every message of a conversation
//   ['mail', 'state']                           a token that changes whenever any mail changes (polled)

import { type InfiniteData, type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { useAccount } from '../lib/account'
import { desktop } from '../lib/core'
import { inDomain, useDomainScope } from '../lib/scope'
import type { MailboxFolders, MessageSummary } from '../lib/types'
import { type ListPage, mailSource, type MailSource, type Patch } from './source'

const POLL_MS = 30_000

export function useMailSource(): MailSource {
  const account = useAccount()
  return useMemo(() => mailSource(account), [account.mode, account.org.id, account.mailboxes])
}

/** Message ids are only unique within one mailbox (JMAP account), so lists key messages by both. */
export const keyOf = (m: { mailboxId: string; id: string }) => `${m.mailboxId}/${m.id}`

export function useFolders() {
  const source = useMailSource()
  return useQuery({ queryKey: ['mail', 'folders'], queryFn: () => source.folders(), staleTime: POLL_MS })
}

const inboxUnread = (mailboxes: MailboxFolders[] = []) =>
  mailboxes.reduce((n, mb) => n + (mb.folders.find((f) => f.role === 'inbox')?.unread ?? 0), 0)

/** Unread messages across every inbox, for the desktop app's badge. */
export function useUnreadCount(): number {
  return inboxUnread(useFolders().data)
}

/** Unread messages in the inboxes on the domain picked in the rail (every inbox when none is). */
export function useScopedUnreadCount(): number {
  const scope = useDomainScope()
  return inboxUnread(useFolders().data?.filter((mb) => inDomain(mb.address, scope)))
}

/**
 * Watches for new mail from anywhere in the dashboard: polls the state token while the window is visible and
 * reloads folders and lists when it changes. Shows a desktop notification for new unread mail.
 */
export function MailSync() {
  const source = useMailSource()
  const client = useQueryClient()
  const folders = useFolders()
  const state = useQuery({
    queryKey: ['mail', 'state'],
    queryFn: () => source.state(),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
  const last = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!state.data) return
    const changed = last.current !== undefined && last.current !== state.data
    last.current = state.data
    if (!changed) return
    const before = inboxUnread(folders.data)
    void client.invalidateQueries({ queryKey: ['mail'], predicate: (q) => q.queryKey[1] !== 'state' }).then(() => {
      const after = inboxUnread(client.getQueryData<MailboxFolders[]>(['mail', 'folders']))
      if (after > before) void notifyNewMail(after - before)
    })
  }, [state.data])

  return null
}

async function notifyNewMail(count: number) {
  if (!desktop || !('Notification' in window)) return
  const settings = await desktop.getSettings().catch(() => ({}) as Record<string, boolean>)
  if (!settings.notifications || document.hasFocus()) return
  new Notification('xstate', { body: count === 1 ? 'You have a new message.' : `You have ${count} new messages.` })
}

// ---------------------------------------------------------------------------------------------------------------
// Optimistic changes: applied to the cache right away, rolled back by reloading if the server says no.

/** Applies `patch` to the conversation's row in every cached list. */
export function patchRow(client: QueryClient, row: MessageSummary, patch: Patch) {
  const key = keyOf(row)
  client.setQueriesData<InfiniteData<ListPage>>({ queryKey: ['mail', 'list'] }, (data) =>
    data && {
      ...data,
      pages: data.pages.map((p) => ({ ...p, messages: p.messages.map((m) => (keyOf(m) === key ? { ...m, ...patch } : m)) })),
    },
  )
}

/** Changes a mailbox's inbox unread count by `delta` (for marking a row read or unread). */
export function adjustUnread(client: QueryClient, row: MessageSummary, delta: number) {
  if (row.folder !== 'inbox') return
  client.setQueryData<MailboxFolders[]>(['mail', 'folders'], (list) =>
    list?.map((mb) =>
      mb.mailboxId !== row.mailboxId
        ? mb
        : { ...mb, folders: mb.folders.map((f) => (f.role === 'inbox' ? { ...f, unread: Math.max(0, f.unread + delta) } : f)) },
    ),
  )
}

export const reloadFolders = (client: QueryClient) => client.invalidateQueries({ queryKey: ['mail', 'folders'] })
export const reloadLists = (client: QueryClient) => client.invalidateQueries({ queryKey: ['mail', 'list'] })
