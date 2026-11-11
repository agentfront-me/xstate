// Users: opens on the segments, each with how many people are in it; a segment opens its people, with search.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ChevronLeft, ChevronRight, CircleCheck, Clock, Hourglass, Layers, type LucideIcon, Mail, Menu, Search, Star, Target, User, UserMinus, Users as UsersIcon } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAccount } from '@/lib/account'
import { api, errorMessage, qs } from '@/lib/api'
import { initial, personName } from '@/lib/format'
import { usePickedDomain } from '@/lib/prefs'
import type { Overview, Person } from '@/lib/types'
import { Avatar, Card, Empty, Failed, Header, IconButton, Loading, LoadingMore, Row } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

const ICONS: Record<string, LucideIcon> = {
  layers: Layers,
  user: User,
  users: UsersIcon,
  target: Target,
  mail: Mail,
  'circle-check': CircleCheck,
  hourglass: Hourglass,
  'user-minus': UserMinus,
  clock: Clock,
  star: Star,
}

/** `id: null` is everyone. `other` is your own auto-saved "Other contacts" (from a Google import), not a saved segment. */
type Picked = { id: string | null; name: string; other?: boolean }

export function Users({ onMenu }: { onMenu: () => void }) {
  const [segment, setSegment] = useState<Picked | null>(null)
  return segment ? <People segment={segment} onBack={() => setSegment(null)} /> : <Segments onMenu={onMenu} onPick={setSegment} />
}

function Segments({ onMenu, onPick }: { onMenu: () => void; onPick: (s: Picked) => void }) {
  const { org } = useAccount()
  const insets = useSafeAreaInsets()
  // The domain picked in the side menu narrows the total and every segment count. Other contacts are yours, not a domain's.
  const domain = usePickedDomain().domain?.name
  const overview = useQuery({ queryKey: ['audience', 'overview', org.id, domain ?? null], queryFn: () => api<Overview>('GET', `/audience/orgs/${org.id}/overview${qs({ domain })}`) })

  const rows = [
    { id: null as string | null, name: 'All users', icon: 'users', count: overview.data?.total ?? 0 },
    ...(overview.data?.segments ?? []).map((s) => ({ id: s.id as string | null, name: s.name, icon: s.icon, count: s.count })),
    ...(overview.data?.otherContacts ? [{ id: 'other' as string | null, name: 'Other contacts', icon: 'mail', count: overview.data.otherContacts, other: true }] : []),
  ]

  return (
    <View style={{ flex: 1 }}>
      <Header title="Users" left={<IconButton icon={Menu} label="Menu" onPress={onMenu} />} />
      {overview.isPending ? (
        <Loading />
      ) : overview.isError ? (
        <Failed message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingTop: 8, paddingBottom: insets.bottom + 16 }}
          refreshControl={<RefreshControl refreshing={overview.isRefetching} onRefresh={() => void overview.refetch()} tintColor={c.dim} />}
        >
          <Card>
            {rows.map((r) => {
              const Icon = ICONS[r.icon] ?? Layers
              return (
                <Row key={r.id ?? 'all'} onPress={() => onPick({ id: r.id, name: r.name, other: 'other' in r })}>
                  <Icon color={c.muted} size={20} strokeWidth={1.75} />
                  <Text numberOfLines={1} style={s.name}>
                    {r.name}
                  </Text>
                  <Text style={s.count}>{r.count.toLocaleString()}</Text>
                  <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
                </Row>
              )
            })}
          </Card>
        </ScrollView>
      )}
    </View>
  )
}

type Page = { people: Person[]; total: number; nextCursor: string | null }

function People({ segment, onBack }: { segment: Picked; onBack: () => void }) {
  const { org } = useAccount()
  const insets = useSafeAreaInsets()
  const domain = usePickedDomain().domain?.name
  const [text, setText] = useState('')
  const [q, setQ] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 300)
    return () => clearTimeout(t)
  }, [text])

  const list = useInfiniteQuery({
    queryKey: ['audience', 'people', org.id, segment.id, domain ?? null, q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Page>('GET', `/audience/orgs/${org.id}/people${qs(segment.other ? { other: true, q, limit: 50, cursor: pageParam } : { segmentId: segment.id ?? undefined, domain, q, limit: 50, cursor: pageParam })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const people = list.data?.pages.flatMap((p) => p.people) ?? []

  return (
    <View style={{ flex: 1 }}>
      <View style={s.back}>
        <Pressable onPress={onBack} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <ChevronLeft color={c.muted} size={22} strokeWidth={1.75} />
          <Text style={{ color: c.muted, fontSize: 16 }}>Segments</Text>
        </Pressable>
      </View>
      <Text numberOfLines={1} style={s.title}>
        {segment.name}
      </Text>
      <View style={s.search}>
        <Search color={c.dim} size={18} strokeWidth={1.75} />
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={domain && !segment.other ? `Search ${domain}` : 'Search users'}
          placeholderTextColor={c.dim}
          style={s.searchInput}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failed message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
      ) : (
        <FlatList
          data={people}
          keyExtractor={(p) => p.id}
          renderItem={({ item: p }) => (
            <Pressable onPress={() => router.push({ pathname: '/user/[id]', params: { id: p.id } })} style={({ pressed }) => [s.person, pressed && { backgroundColor: c.card }]}>
              <Avatar text={initial(personName(p))} size={36} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={s.personName}>
                  {personName(p)}
                </Text>
                {(p.name && p.email) || p.domain ? (
                  <Text numberOfLines={1} style={s.sub}>
                    {p.name && p.email ? p.email : p.domain}
                  </Text>
                ) : null}
              </View>
              <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
            </Pressable>
          )}
          ListEmptyComponent={<Empty>No users found.</Empty>}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          ListFooterComponent={<LoadingMore active={list.isFetchingNextPage} />}
          onEndReached={() => list.hasNextPage && !list.isFetchingNextPage && void list.fetchNextPage()}
          onEndReachedThreshold={0.5}
          refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} tintColor={c.dim} />}
          keyboardDismissMode="on-drag"
        />
      )}
    </View>
  )
}

const s = StyleSheet.create({
  back: { height: 44, paddingHorizontal: 10, justifyContent: 'center' },
  title: { color: c.text, fontSize: 22, fontWeight: '500', paddingHorizontal: pad, paddingBottom: 12 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 40, marginHorizontal: pad, marginBottom: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: c.card },
  searchInput: { flex: 1, color: c.text, fontSize: 16, paddingVertical: 0 },
  name: { flex: 1, color: c.text, fontSize: 16 },
  personName: { color: c.text, fontSize: 16 },
  count: { color: c.dim, fontSize: 14 },
  sub: { color: c.dim, fontSize: 13, marginTop: 2 },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: pad, minHeight: 58, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
})
