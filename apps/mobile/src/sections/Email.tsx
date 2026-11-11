// The inbox. The title is a menu of views (Inbox, Pinned, Unread, Archived, Spam) with the picked domain under it;
// conversations are grouped by day, with pinned ones first in the Inbox. Pull down to refresh. Swipe a row right to
// pin it or left to archive it: the row follows the finger, and let go past halfway it slides off and the list closes
// up. Search opens from the icon or the box at the bottom.

import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { router } from 'expo-router'
import { Archive, ArchiveRestore, Check, ChevronDown, Menu, PenLine, Pin, PinOff, Search, Sparkles, X } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { Modal, Platform, Pressable, RefreshControl, SectionList, StyleSheet, Text, TextInput, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAccount } from '@/lib/account'
import { api, errorMessage, qs } from '@/lib/api'
import { formatTime, sender } from '@/lib/format'
import { haptic } from '@/lib/haptics'
import { usePickedDomain } from '@/lib/prefs'
import type { FolderRole, FolderView, MessageSummary } from '@/lib/types'
import { Empty, Failed, IconButton, Loading, LoadingMore, useToast } from '@/ui/kit'
import { PullHeader, PullIndicator, ringColors, usePullToRefresh } from '@/ui/Spinner'
import { SwipeRow } from '@/ui/SwipeRow'
import { c, pad } from '@/ui/theme'

type ViewId = 'inbox' | 'pinned' | 'unread' | 'archived' | 'spam'
const VIEWS: { id: ViewId; label: string; folder: FolderView; empty: string }[] = [
  { id: 'inbox', label: 'Inbox', folder: 'inbox', empty: 'Nothing in your inbox.' },
  { id: 'pinned', label: 'Pinned', folder: 'pinned', empty: 'Nothing pinned.' },
  { id: 'unread', label: 'Unread', folder: 'inbox', empty: 'Nothing unread.' },
  { id: 'archived', label: 'Archived', folder: 'archive', empty: 'Nothing archived.' },
  { id: 'spam', label: 'Spam', folder: 'junk', empty: 'No spam.' },
]

// iPhone lists stretch past the top, which the design's pull to refresh follows; Android keeps RefreshControl.
const ios = Platform.OS === 'ios'
const PullSectionList = Animated.createAnimatedComponent(SectionList<MessageSummary, { title: string; data: MessageSummary[] }>)

type Page = { messages: MessageSummary[]; nextCursor: string | null }
type Patch = { pinned?: boolean; folder?: FolderRole }

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** "Today", "Yesterday", "Earlier this week" (the last seven days), then "Earlier". */
function dayGroup(iso: string, today: number): string {
  const days = Math.round((today - startOfDay(new Date(iso))) / 86_400_000)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'Earlier this week' : 'Earlier'
}

/** Newest first as the API returns them, so each group's rows are already together. The Inbox lifts pinned ones out. */
function group(messages: MessageSummary[], pinnedFirst: boolean): { title: string; data: MessageSummary[] }[] {
  const today = startOfDay(new Date())
  const sections: { title: string; data: MessageSummary[] }[] = []
  const add = (title: string, m: MessageSummary) => {
    const last = sections[sections.length - 1]
    if (last?.title === title) last.data.push(m)
    else sections.push({ title, data: [m] })
  }
  if (pinnedFirst) for (const m of messages) if (m.pinned) add('Pinned', m)
  for (const m of messages) if (!(pinnedFirst && m.pinned)) add(dayGroup(m.receivedAt, today), m)
  return sections
}

export function Email({ onMenu }: { onMenu: () => void }) {
  const { org } = useAccount()
  const picked = usePickedDomain()
  const insets = useSafeAreaInsets()
  const client = useQueryClient()
  const toast = useToast()
  const [viewId, setViewId] = useState<ViewId>('inbox')
  const [choosing, setChoosing] = useState(false)
  const [searching, setSearching] = useState(false)
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  // Bumped when a swipe's change fails, so the rows it hid are drawn again.
  const [generation, setGeneration] = useState(0)
  const view = VIEWS.find((v) => v.id === viewId)!

  // Search as you type, a moment after the last key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 300)
    return () => clearTimeout(t)
  }, [text])

  // The API lists one mailbox or all of them. A domain with one mailbox asks for just that one; with several, the
  // list is narrowed here to the domain's mailboxes.
  const boxes = picked.mailboxes
  const only = boxes?.length === 1 ? boxes[0]?.id : undefined
  const list = useInfiniteQuery({
    queryKey: ['mail', 'list', org.id, viewId, query, only ?? 'all'],
    enabled: boxes?.length !== 0,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<Page>('GET', `/email/orgs/${org.id}/messages${qs({ folder: view.folder, mailboxId: only, limit: 50, unreadOnly: viewId === 'unread', query, cursor: pageParam })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const inDomain = boxes && !only ? new Set(boxes.map((m) => m.id)) : null
  const messages = (list.data?.pages.flatMap((p) => p.messages) ?? []).filter((m) => !inDomain || inDomain.has(m.mailboxId))
  const sections = group(messages, viewId === 'inbox' && !query)
  // The first load of the inbox shows only the spinner: search and writing come once there's a list to work with.
  const loading = list.isPending && boxes?.length !== 0 && !query

  // The ring at the top is for a pull only (ui/Spinner.tsx). A swipe, a sent message or coming back to the list also
  // reloads it, but quietly: the rows are already right on screen.
  const pull = usePullToRefresh(() => Promise.all([list.refetch(), client.invalidateQueries({ queryKey: ['mail', 'folders'] })]))

  /** A swipe. Moving to another folder moves the whole conversation; a pin is on the one message. */
  const update = useMutation({
    mutationFn: ({ m, patch }: { m: MessageSummary; patch: Patch; done: string }) =>
      api('PATCH', `/email/mailboxes/${m.mailboxId}/messages/${encodeURIComponent(m.id)}`, { ...patch, thread: patch.folder !== undefined }),
    onSuccess: (_result, { done }) => {
      toast(done)
      void client.invalidateQueries({ queryKey: ['mail', 'list'] })
      void client.invalidateQueries({ queryKey: ['mail', 'folders'] })
    },
    onError: (err) => {
      haptic.error()
      toast(errorMessage(err))
      setGeneration((g) => g + 1)
    },
  })
  // The tap comes as the row slides off, before the server answers, so it matches what the finger just did.
  function pin(m: MessageSummary) {
    haptic.tap()
    update.mutate({ m, patch: { pinned: !m.pinned }, done: m.pinned ? 'Unpinned' : 'Pinned' })
  }
  function archive(m: MessageSummary) {
    haptic.tap()
    if (viewId === 'archived' || viewId === 'spam') update.mutate({ m, patch: { folder: 'inbox' }, done: 'Moved to Inbox' })
    else update.mutate({ m, patch: { folder: 'archive' }, done: 'Archived' })
  }

  function closeSearch() {
    setSearching(false)
    setText('')
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={s.header}>
        <IconButton icon={Menu} label="Menu" onPress={onMenu} />
        <Pressable onPress={() => setChoosing(true)} accessibilityRole="button" accessibilityLabel={`${view.label}, change view`} hitSlop={6} style={{ flex: 1, paddingLeft: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={s.title}>{view.label}</Text>
            <ChevronDown color={c.muted} size={18} strokeWidth={2} />
          </View>
          <Text numberOfLines={1} style={s.domain}>
            {picked.domain?.name ?? 'All domains'}
          </Text>
        </Pressable>
        {loading ? null : (
          <IconButton icon={searching ? X : Search} label={searching ? 'Close search' : 'Search'} onPress={() => (searching ? closeSearch() : setSearching(true))} />
        )}
      </View>

      {searching ? (
        <View style={s.search}>
          <Search color={c.dim} size={18} strokeWidth={1.75} />
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={`Search ${view.label.toLowerCase()}`}
            placeholderTextColor={c.dim}
            style={s.searchInput}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            clearButtonMode="while-editing"
          />
        </View>
      ) : null}

      {boxes?.length === 0 ? (
        <Empty>No mailboxes on {picked.domain?.name} yet.</Empty>
      ) : list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failed message={errorMessage(list.error)} onRetry={() => void pull.refresh()} />
      ) : (
        <View style={{ flex: 1 }}>
          {ios ? <PullIndicator pull={pull.pull} refreshing={pull.refreshing} /> : null}
          <PullSectionList
            sections={sections}
            // A row that slid away stays hidden until the list comes back with it changed (or gone), which gives it a new key.
            keyExtractor={(m) => `${m.mailboxId}:${m.id}:${m.pinned}:${m.folder}:${generation}`}
            renderItem={({ item }) => <MessageRow message={item} restore={viewId === 'archived' || viewId === 'spam'} onPin={pin} onArchive={archive} />}
            renderSectionHeader={({ section }) => <Text style={s.group}>{section.title}</Text>}
            stickySectionHeadersEnabled={false}
            ListEmptyComponent={<Empty>{query ? `Nothing matches “${query}”.` : view.empty}</Empty>}
            contentContainerStyle={{ paddingBottom: 16 }}
            ListHeaderComponent={ios ? <PullHeader refreshing={pull.refreshing} /> : undefined}
            ListFooterComponent={<LoadingMore active={list.isFetchingNextPage} />}
            onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
            onEndReachedThreshold={0.5}
            onScroll={ios ? pull.onScroll : undefined}
            scrollEventThrottle={16}
            refreshControl={
              ios ? undefined : (
                <RefreshControl refreshing={pull.refreshing} onRefresh={() => void pull.refresh()} colors={[ringColors.head]} progressBackgroundColor={c.card} />
              )
            }
            keyboardDismissMode="on-drag"
          />
        </View>
      )}

      {searching || loading ? null : (
        <View style={[s.bottom, { paddingBottom: insets.bottom + 8 }]}>
          {/* No assistant behind it yet: it opens search. */}
          <Pressable onPress={() => setSearching(true)} accessibilityRole="button" style={({ pressed }) => [s.ask, pressed && { backgroundColor: c.border }]}>
            <Sparkles color={c.purple} size={20} strokeWidth={1.75} />
            <Text style={{ color: c.muted, fontSize: 16 }}>Ask me anything</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/compose')} accessibilityRole="button" accessibilityLabel="New message" style={({ pressed }) => [s.compose, pressed && { opacity: 0.8 }]}>
            <PenLine color={c.white} size={22} strokeWidth={2} />
          </Pressable>
        </View>
      )}

      <Modal visible={choosing} transparent animationType="fade" onRequestClose={() => setChoosing(false)}>
        <Pressable style={{ flex: 1 }} onPress={() => setChoosing(false)} accessibilityLabel="Close menu">
          <View style={[s.menu, { top: insets.top + 54 }]}>
            {VIEWS.map((v) => (
              <Pressable
                key={v.id}
                onPress={() => {
                  setViewId(v.id)
                  setChoosing(false)
                }}
                style={({ pressed }) => [s.menuItem, pressed && { backgroundColor: c.borderStrong }]}
              >
                <Text style={{ flex: 1, color: c.text, fontSize: 16 }}>{v.label}</Text>
                {v.id === viewId ? <Check color={c.text} size={18} strokeWidth={2} /> : null}
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </View>
  )
}

type RowProps = { message: MessageSummary; restore: boolean; onPin: (m: MessageSummary) => void; onArchive: (m: MessageSummary) => void }

function MessageRow({ message: m, restore, onPin, onArchive }: RowProps) {
  const open = () => router.push({ pathname: '/thread', params: { mailboxId: m.mailboxId, threadId: m.threadId, id: m.id, subject: m.subject } })
  return (
    <SwipeRow
      right={{ icon: m.pinned ? PinOff : Pin, label: m.pinned ? 'Unpin' : 'Pin', color: c.pinSwipe, ink: c.bg, onDone: () => onPin(m) }}
      left={{ icon: restore ? ArchiveRestore : Archive, label: restore ? 'Move to Inbox' : 'Archive', color: c.archiveSwipe, onDone: () => onArchive(m) }}
    >
      <Pressable onPress={open} style={({ pressed }) => [s.row, pressed && { backgroundColor: c.card }]}>
        <View style={s.dotColumn}>{m.seen ? null : <View style={s.dot} />}</View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text numberOfLines={1} style={s.from}>
              {sender(m.from)}
              {m.threadSize > 1 ? <Text style={{ color: c.dim, fontWeight: '400' }}>  {m.threadSize}</Text> : null}
            </Text>
            {m.pinned ? <Pin color={c.orange} size={14} strokeWidth={2} /> : null}
          </View>
          <Text numberOfLines={1} style={s.subject}>
            {m.subject || '(no subject)'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
            <Text numberOfLines={1} style={s.preview}>
              {m.preview}
            </Text>
            <Text style={s.time}>{formatTime(m.receivedAt)}</Text>
          </View>
        </View>
      </Pressable>
    </SwipeRow>
  )
}

const s = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', height: 60, paddingHorizontal: 8, gap: 4 },
  title: { color: c.text, fontSize: 22, fontWeight: '700' },
  domain: { color: c.dim, fontSize: 13, marginTop: 1 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, marginHorizontal: pad, marginBottom: 4, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.card },
  searchInput: { flex: 1, color: c.text, fontSize: 16, paddingVertical: 0 },
  group: { color: c.muted, fontSize: 14, fontWeight: '600', paddingHorizontal: pad + 6, paddingTop: 18, paddingBottom: 6 },
  row: { flexDirection: 'row', paddingRight: pad, paddingVertical: 9, backgroundColor: c.bg },
  dotColumn: { width: 30, alignItems: 'center', paddingTop: 7 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.blue },
  from: { flexShrink: 1, color: c.text, fontSize: 16, fontWeight: '700' },
  subject: { color: c.text, fontSize: 16, marginTop: 2 },
  preview: { flex: 1, color: c.dim, fontSize: 15, marginTop: 2 },
  time: { color: c.muted, fontSize: 13, fontWeight: '600' },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: pad, paddingTop: 8, backgroundColor: c.bg },
  ask: { flex: 1, height: 52, borderRadius: 26, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, backgroundColor: c.card, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
  compose: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: c.blueStrong },
  menu: { position: 'absolute', left: 52, width: 210, borderRadius: 14, backgroundColor: c.border, paddingVertical: 6, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  menuItem: { flexDirection: 'row', alignItems: 'center', height: 44, paddingHorizontal: 16 },
})
