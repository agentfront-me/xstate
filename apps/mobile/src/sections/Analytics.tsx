// Analytics: what visitors do on the organization's websites, read-only on the phone. Two tabs: Live (the newest
// events, refreshed every few seconds while on screen) and Funnels (each with its 30-day conversion). Installing
// the snippet, settings and editing funnels stay in the web app.

import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ChartLine, ChevronRight, Funnel as FunnelIcon, Menu } from 'lucide-react-native'
import { useState } from 'react'
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAccount } from '@/lib/account'
import { TYPE_LABEL, ago, eventLabel, percent, whoLabel } from '@/lib/analytics'
import { api, errorMessage, qs } from '@/lib/api'
import { usePickedDomain } from '@/lib/prefs'
import type { EventsPage, EventType, Funnel } from '@/lib/types'
import { Card, Empty, Failed, Header, IconButton, Loading, Row } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

const TYPES: (EventType | undefined)[] = [undefined, 'page', 'track', 'email', 'identify']

export function Analytics({ onMenu }: { onMenu: () => void }) {
  const [tab, setTab] = useState<'live' | 'funnels'>('live')
  return (
    <View style={{ flex: 1 }}>
      <Header title="Analytics" left={<IconButton icon={Menu} label="Menu" onPress={onMenu} />} />
      <Chips
        items={[
          { id: 'live', label: 'Live events' },
          { id: 'funnels', label: 'Funnels' },
        ]}
        value={tab}
        onChange={(v) => setTab(v as 'live' | 'funnels')}
      />
      {tab === 'live' ? <Live /> : <Funnels />}
    </View>
  )
}

function Chips({ items, value, onChange }: { items: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips} style={{ flexGrow: 0 }}>
      {items.map((it) => {
        const on = it.id === value
        return (
          <Pressable key={it.id} onPress={() => onChange(it.id)} style={[s.chip, on && s.chipOn]} accessibilityRole="button" accessibilityState={{ selected: on }}>
            <Text style={[s.chipText, on && s.chipTextOn]}>{it.label}</Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

function Live() {
  const { org } = useAccount()
  const insets = useSafeAreaInsets()
  const domain = usePickedDomain().domain?.name
  const [type, setType] = useState<EventType | undefined>(undefined)
  const events = useQuery({
    queryKey: ['analytics', 'events', org.id, domain ?? null, type ?? null],
    queryFn: () => api<EventsPage>('GET', `/analytics/orgs/${org.id}/events${qs({ domain, type, limit: 60 })}`),
    // Live, like the web feed: the newest page again every few seconds while the app is in front.
    refetchInterval: 4000,
    refetchIntervalInBackground: false,
  })

  return (
    <View style={{ flex: 1 }}>
      <Chips
        items={TYPES.map((t) => ({ id: t ?? 'all', label: t ? TYPE_LABEL[t] : 'All' }))}
        value={type ?? 'all'}
        onChange={(id) => setType(id === 'all' ? undefined : (id as EventType))}
      />
      {events.isPending ? (
        <Loading />
      ) : events.isError ? (
        <Failed message={errorMessage(events.error)} onRetry={() => void events.refetch()} />
      ) : (
        <FlatList
          data={events.data.events}
          keyExtractor={(e) => String(e.id)}
          ListHeaderComponent={<Text style={s.recent}>{events.data.recent.toLocaleString()} {events.data.recent === 1 ? 'event' : 'events'} in the last 5 min</Text>}
          renderItem={({ item: e }) => (
            <Pressable onPress={() => router.push({ pathname: '/event/[id]', params: { id: String(e.id) } })} style={({ pressed }) => [s.event, pressed && { backgroundColor: c.card }]}>
              <Text style={[s.type, (e.type === 'identify' || e.type === 'email') && s.typeQuiet]}>{TYPE_LABEL[e.type]}</Text>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={s.eventName}>
                  {eventLabel(e)}
                </Text>
                <Text numberOfLines={1} style={s.sub}>
                  {whoLabel(e.person)}
                </Text>
              </View>
              <Text style={s.time}>{ago(e.occurredAt)}</Text>
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={s.empty}>
              <ChartLine color={c.dim} size={28} strokeWidth={1.5} />
              <Text style={s.emptyTitle}>{type ? 'No events of this kind yet' : 'No events yet'}</Text>
              {!type ? <Text style={s.emptyText}>Add the analytics snippet to your site from Analytics in the web app. Events show up here as they arrive.</Text> : null}
            </View>
          }
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={() => void events.refetch()} tintColor={c.dim} />}
        />
      )}
    </View>
  )
}

function Funnels() {
  const { org } = useAccount()
  const insets = useSafeAreaInsets()
  const domain = usePickedDomain().domain?.name
  const funnels = useQuery({
    queryKey: ['analytics', 'funnels', org.id, domain ?? null],
    queryFn: () => api<{ funnels: (Funnel & { conversion: number })[] }>('GET', `/analytics/orgs/${org.id}/funnels${qs({ domain })}`),
  })
  if (funnels.isPending) return <Loading />
  if (funnels.isError) return <Failed message={errorMessage(funnels.error)} onRetry={() => void funnels.refetch()} />
  return (
    <ScrollView
      contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 16 }}
      refreshControl={<RefreshControl refreshing={funnels.isRefetching} onRefresh={() => void funnels.refetch()} tintColor={c.dim} />}
    >
      {funnels.data.funnels.length ? (
        <Card>
          {funnels.data.funnels.map((f) => (
            <Row key={f.id} onPress={() => router.push({ pathname: '/funnel/[id]', params: { id: f.id, name: f.name } })}>
              <FunnelIcon color={c.muted} size={20} strokeWidth={1.75} />
              <View style={{ flex: 1 }}>
                <Text numberOfLines={1} style={s.funnelName}>
                  {f.name}
                </Text>
                <Text style={s.sub}>
                  {f.steps.length} steps · {f.windowDays} day window
                </Text>
              </View>
              <Text style={s.conversion}>{percent(f.conversion)}</Text>
              <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
            </Row>
          ))}
        </Card>
      ) : (
        <Empty>No funnels yet. Create one in Analytics in the web app.</Empty>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  chips: { gap: 8, paddingHorizontal: pad, paddingBottom: 10 },
  chip: { height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: c.card, justifyContent: 'center' },
  chipOn: { backgroundColor: c.text },
  chipText: { color: c.muted, fontSize: 14 },
  chipTextOn: { color: c.bg, fontWeight: '500' },
  recent: { color: c.dim, fontSize: 13, paddingHorizontal: pad, paddingBottom: 6 },
  event: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: pad, minHeight: 58, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
  type: { width: 66, textAlign: 'center', fontSize: 12, color: c.text, backgroundColor: c.card, borderRadius: 10, paddingVertical: 3, overflow: 'hidden' },
  typeQuiet: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: c.borderStrong, color: c.muted },
  eventName: { color: c.text, fontSize: 15 },
  sub: { color: c.dim, fontSize: 13, marginTop: 2 },
  time: { color: c.dim, fontSize: 13 },
  empty: { alignItems: 'center', gap: 8, paddingTop: 64, paddingHorizontal: 32 },
  emptyTitle: { color: c.text, fontSize: 16, fontWeight: '500' },
  emptyText: { color: c.dim, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  funnelName: { color: c.text, fontSize: 16 },
  conversion: { color: c.text, fontSize: 15, fontVariant: ['tabular-nums'] },
})
