// One conversation: every message in it, oldest first, with pin, archive and reply.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { Archive, Paperclip, Pin, PinOff } from 'lucide-react-native'
import { useEffect } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useAccount } from '@/lib/account'
import { api, errorMessage } from '@/lib/api'
import { formatTime, initial, sender } from '@/lib/format'
import type { FolderRole, Message } from '@/lib/types'
import { Avatar, BackButton, Failed, Header, IconButton, Loading, Screen, useToast } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

type Patch = { seen?: boolean; pinned?: boolean; folder?: FolderRole }

export default function Thread() {
  const params = useLocalSearchParams<{ mailboxId: string; threadId: string; id: string; subject?: string }>()
  const { mailboxes } = useAccount()
  const client = useQueryClient()
  const toast = useToast()
  const mine = new Set(mailboxes.map((m) => m.address.toLowerCase()))

  const key = ['mail', 'thread', params.mailboxId, params.threadId]
  const thread = useQuery({
    queryKey: key,
    queryFn: async () =>
      (await api<{ messages: Message[] }>('GET', `/email/mailboxes/${params.mailboxId}/threads/${encodeURIComponent(params.threadId)}`)).messages,
  })
  const messages = thread.data ?? []
  const last = messages[messages.length - 1]
  const pinned = messages.some((m) => m.pinned)
  const archived = messages.length > 0 && messages.every((m) => m.folder === 'archive')

  /** Read state and folder moves apply to the whole conversation; pinning to the one message. */
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Patch }) =>
      api('PATCH', `/email/mailboxes/${params.mailboxId}/messages/${encodeURIComponent(id)}`, { ...patch, thread: patch.seen !== undefined || patch.folder !== undefined }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['mail', 'list'] })
      void client.invalidateQueries({ queryKey: ['mail', 'folders'] })
    },
    onError: (err) => toast(errorMessage(err)),
  })

  // Opening a conversation marks it read.
  const unseen = messages.find((m) => !m.seen)?.id
  const { mutate } = update
  useEffect(() => {
    if (unseen) mutate({ id: unseen, patch: { seen: true } })
  }, [unseen, mutate])

  function togglePin() {
    const target = messages.find((m) => m.pinned) ?? messages.find((m) => m.id === params.id) ?? last
    if (!target) return
    update.mutate({ id: target.id, patch: { pinned: !pinned } }, { onSuccess: () => (void thread.refetch(), toast(pinned ? 'Unpinned' : 'Pinned')) })
  }

  function archive() {
    if (!last) return
    update.mutate(
      { id: last.id, patch: { folder: archived ? 'inbox' : 'archive' } },
      { onSuccess: () => (toast(archived ? 'Moved to inbox' : 'Archived'), router.back()) },
    )
  }

  function reply() {
    if (!last) return
    // Answer the latest message from someone else; if every message is yours, write to the same people again.
    const theirs = [...messages].reverse().find((m) => !mine.has(m.from[0]?.email.toLowerCase() ?? ''))
    const to = theirs ? (theirs.replyTo?.length ? theirs.replyTo : theirs.from) : last.to
    const subject = last.subject || params.subject || ''
    router.push({
      pathname: '/compose',
      params: {
        mailboxId: params.mailboxId,
        inReplyTo: (theirs ?? last).id,
        to: to.map((a) => a.email).join(', '),
        toName: to[0]?.name ?? '',
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
      },
    })
  }

  const subject = messages[0]?.subject || params.subject || '(no subject)'
  const replyName = sender(last?.from ?? []).split(' ')[0]

  return (
    <Screen>
      <Header
        left={<BackButton />}
        right={
          <>
            <IconButton icon={pinned ? PinOff : Pin} label={pinned ? 'Unpin' : 'Pin'} onPress={togglePin} />
            <IconButton icon={Archive} label={archived ? 'Move to inbox' : 'Archive'} onPress={archive} />
          </>
        }
      />
      {thread.isPending ? (
        <Loading />
      ) : thread.isError ? (
        <Failed message={errorMessage(thread.error)} onRetry={() => void thread.refetch()} />
      ) : (
        <>
          <ScrollView contentContainerStyle={{ paddingHorizontal: pad, paddingBottom: 24 }}>
            <Text style={s.subject}>{subject}</Text>
            {messages.map((m) => (
              <View key={m.id} style={s.message}>
                <View style={s.messageHead}>
                  <Avatar text={initial(sender(m.from))} />
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={s.from}>
                      {sender(m.from)}
                    </Text>
                    <Text numberOfLines={1} style={s.to}>
                      to {m.to.map((a) => a.name || a.email).join(', ') || 'no one'}
                    </Text>
                  </View>
                  <Text style={s.time}>{formatTime(m.receivedAt)}</Text>
                </View>
                <Text selectable style={s.body}>
                  {m.text.trim() || m.preview}
                </Text>
                {m.attachments.filter((a) => !a.inline).length ? (
                  <View style={s.attachments}>
                    {m.attachments
                      .filter((a) => !a.inline)
                      .map((a) => (
                        <View key={a.blobId} style={s.attachment}>
                          <Paperclip color={c.muted} size={14} strokeWidth={1.75} />
                          <Text numberOfLines={1} style={{ color: c.soft, fontSize: 14, flexShrink: 1 }}>
                            {a.name}
                          </Text>
                        </View>
                      ))}
                  </View>
                ) : null}
              </View>
            ))}
          </ScrollView>
          <View style={s.replyBar}>
            <Pressable onPress={reply} style={s.replyInput}>
              <Text style={{ color: c.dim, fontSize: 16 }}>Reply to {replyName}…</Text>
            </Pressable>
          </View>
        </>
      )}
    </Screen>
  )
}

const s = StyleSheet.create({
  subject: { color: c.text, fontSize: 22, fontWeight: '500', lineHeight: 28, paddingTop: 4, paddingBottom: 16 },
  message: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingVertical: 16 },
  messageHead: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  from: { color: c.text, fontSize: 16 },
  to: { color: c.dim, fontSize: 13, marginTop: 1 },
  time: { color: c.dim, fontSize: 13 },
  body: { color: c.soft, fontSize: 16, lineHeight: 24 },
  attachments: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  attachment: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, borderRadius: 17, backgroundColor: c.card, maxWidth: '100%' },
  replyBar: { paddingHorizontal: pad, paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  replyInput: { height: 44, borderRadius: 22, backgroundColor: c.card, justifyContent: 'center', paddingHorizontal: 16 },
})
