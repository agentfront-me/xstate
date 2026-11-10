// The inbox: search, a filter, and one row per conversation.

import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { router } from 'expo-router'
import { Menu, PenLine, Pin, Search } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAccount } from '@/lib/account'
import { api, errorMessage, qs } from '@/lib/api'
import { formatTime, sender } from '@/lib/format'
import { usePickedDomain } from '@/lib/prefs'
import type { FolderView, MessageSummary } from '@/lib/types'
import { Empty, Failed, Header, IconButton, Loading } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

type Filter = 'all' | 'unread' | 'pinned' | 'archived'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'archived', label: 'Archived' },
]

type Page = { messages: MessageSummary[]; nextCursor: string | null }

export function Email({ onMenu }: { onMenu: () => void }) {
  const { org } = useAccount()
  const picked = usePickedDomain()
  const insets = useSafeAreaInsets()
  const client = useQueryClient()
  const [filter, setFilter] = useState<Filter>('all')
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 300)
    return () => clearTimeout(t)
  }, [text])

  const folder: FolderView = filter === 'pinned' ? 'pinned' : filter === 'archived' ? 'archive' : 'inbox'
  // The API lists one mailbox or all of them. A domain with one mailbox asks for just that one; with several, the
  // list is narrowed here to the domain's mailboxes.
  const boxes = picked.mailboxes
  const only = boxes?.length === 1 ? boxes[0]?.id : undefined
  const list = useInfiniteQuery({
    queryKey: ['mail', 'list', org.id, filter, query, only ?? 'all'],
    enabled: boxes?.length !== 0,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<Page>('GET', `/email/orgs/${org.id}/messages${qs({ folder, mailboxId: only, limit: 50, unreadOnly: filter === 'unread', query, cursor: pageParam })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const inDomain = boxes && !only ? new Set(boxes.map((m) => m.id)) : null
  const messages = (list.data?.pages.flatMap((p) => p.messages) ?? []).filter((m) => !inDomain || inDomain.has(m.mailboxId))

  function refresh() {
    void list.refetch()
    void client.invalidateQueries({ queryKey: ['mail', 'folders'] })
  }

  return (
    <View style={{ flex: 1 }}>
      <Header
        title="Inbox"
        left={<IconButton icon={Menu} label="Menu" onPress={onMenu} />}
        right={<IconButton icon={PenLine} label="New message" onPress={() => router.push('/compose')} />}
      />
      <View style={s.search}>
        <Search color={c.dim} size={18} strokeWidth={1.75} />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={picked.domain ? `Search ${picked.domain.name}` : 'Search'}
          placeholderTextColor={c.dim}
          style={s.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
      </View>
      <View style={s.filters}>
        {FILTERS.map((f) => (
          <Pressable key={f.id} onPress={() => setFilter(f.id)} style={[s.chip, filter === f.id && s.chipOn]}>
            <Text style={{ color: filter === f.id ? c.card : c.muted, fontSize: 14, fontWeight: '500' }}>{f.label}</Text>
          </Pressable>
        ))}
      </View>

      {boxes?.length === 0 ? (
        <Empty>No mailboxes on {picked.domain?.name} yet.</Empty>
      ) : list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failed message={errorMessage(list.error)} onRetry={refresh} />
      ) : (
        <FlatList
          data={messages}
          keyExtractor={(m) => `${m.mailboxId}:${m.id}`}
          renderItem={({ item }) => <MessageRow message={item} />}
          ListEmptyComponent={<Empty>Nothing here.</Empty>}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
          onEndReachedThreshold={0.5}
          refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={refresh} tintColor={c.dim} />}
          keyboardDismissMode="on-drag"
        />
      )}
    </View>
  )
}

function MessageRow({ message: m }: { message: MessageSummary }) {
  const open = () => router.push({ pathname: '/thread', params: { mailboxId: m.mailboxId, threadId: m.threadId, id: m.id, subject: m.subject } })
  return (
    <Pressable onPress={open} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.card }]}>
      <View style={s.dotColumn}>{m.seen ? null : <View style={s.dot} />}</View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text numberOfLines={1} style={[s.from, !m.seen && { color: c.white, fontWeight: '500' }]}>
            {sender(m.from)}
            {m.threadSize > 1 ? <Text style={{ color: c.dim, fontWeight: '400' }}>  {m.threadSize}</Text> : null}
          </Text>
          {m.pinned ? <Pin color={c.dim} size={13} strokeWidth={1.75} /> : null}
          <Text style={s.time}>{formatTime(m.receivedAt)}</Text>
        </View>
        <Text numberOfLines={1} style={[s.subject, !m.seen && { color: c.text }]}>
          {m.subject || '(no subject)'}
        </Text>
        <Text numberOfLines={1} style={s.preview}>
          {m.preview}
        </Text>
      </View>
    </Pressable>
  )
}

const s = StyleSheet.create({
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, marginHorizontal: pad, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.card },
  searchInput: { flex: 1, color: c.text, fontSize: 16, paddingVertical: 0 },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: pad, paddingVertical: 12 },
  chip: { height: 32, paddingHorizontal: 14, borderRadius: 16, justifyContent: 'center', backgroundColor: c.card },
  chipOn: { backgroundColor: c.white },
  row: { flexDirection: 'row', paddingRight: pad, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  dotColumn: { width: 34, alignItems: 'center', paddingTop: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.white },
  from: { flex: 1, color: c.soft, fontSize: 16 },
  time: { color: c.dim, fontSize: 13 },
  subject: { color: c.soft, fontSize: 16, marginTop: 2 },
  preview: { color: c.dim, fontSize: 13, marginTop: 3 },
})
