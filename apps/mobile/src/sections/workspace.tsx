// The workspace lists Settings opens (members, domains, AI providers): their queries, status wording, and the
// shared read-only list screen.

import type { ReactNode } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { api, errorMessage } from '@/lib/api'
import type { OrgMember, Provider } from '@/lib/types'
import { BackButton, Card, Empty, Failed, Header, Loading, Row, Screen } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

export const membersQuery = (orgId: string) => ({
  queryKey: ['members', orgId] as const,
  queryFn: async () => (await api<{ members: OrgMember[] }>('GET', `/members/orgs/${orgId}`)).members,
})

/** Saved keys only: a provider with no key is not in the list. Owners and admins only. */
export const providersQuery = (orgId: string) => ({
  queryKey: ['ai-providers', orgId] as const,
  queryFn: async () => (await api<{ providers: Provider[] }>('GET', `/orgs/${orgId}/ai-providers`)).providers,
})

const STATES: Record<Provider['status'], { label: string; color: string; rank: number }> = {
  invalid: { label: 'Key rejected', color: c.danger, rank: 3 },
  no_credit: { label: 'No credit', color: c.danger, rank: 2 },
  rate_limited: { label: 'Rate limited', color: c.warn, rank: 1 },
  valid: { label: 'Active', color: c.dim, rank: 0 },
}

export const providerState = (p: Provider) => STATES[p.status]

/** The key that most needs attention, for the one-line summary on Settings. */
export const worstProvider = (list: Provider[] | undefined) => [...(list ?? [])].sort((a, b) => STATES[b.status].rank - STATES[a.status].rank)[0]

export type Item = { id: string; icon?: ReactNode; title: string; sub?: string; value: string; color?: string }

type Props = { title: string; items: Item[] | undefined; note: string; empty: string; error?: unknown; refreshing?: boolean; onRefresh: () => void }

/** A view-only list: a name and a line under it on the left, its status on the right, and where to change it. */
export function ListScreen({ title, items, note, empty, error, refreshing = false, onRefresh }: Props) {
  return (
    <Screen>
      <Header title={title} left={<BackButton />} />
      {error ? (
        <Failed message={errorMessage(error)} onRetry={onRefresh} />
      ) : !items ? (
        <Loading />
      ) : (
        <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: 32 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.dim} />}>
          {items.length === 0 ? (
            <Empty>{empty}</Empty>
          ) : (
            <Card>
              {items.map((it) => (
                <Row key={it.id}>
                  {it.icon}
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={s.title}>
                      {it.title}
                    </Text>
                    {it.sub ? (
                      <Text numberOfLines={1} style={s.sub}>
                        {it.sub}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={{ color: it.color ?? c.dim, fontSize: 14 }}>{it.value}</Text>
                </Row>
              ))}
            </Card>
          )}
          <Text style={s.note}>{note}</Text>
        </ScrollView>
      )}
    </Screen>
  )
}

const s = StyleSheet.create({
  title: { color: c.text, fontSize: 16 },
  sub: { color: c.dim, fontSize: 13, marginTop: 2 },
  note: { color: c.dim, fontSize: 13, paddingHorizontal: pad + 4, paddingTop: 12 },
})
