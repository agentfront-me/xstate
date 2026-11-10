// One agent: what's wrong with it (if anything), what it's waiting on you for, its runs and its setup.

import { useQuery } from '@tanstack/react-query'
import * as Clipboard from 'expo-clipboard'
import { router, useLocalSearchParams } from 'expo-router'
import { ChevronRight, CircleAlert, Copy } from 'lucide-react-native'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useAccount } from '@/lib/account'
import { api, errorMessage } from '@/lib/api'
import { relative } from '@/lib/format'
import type { AgentSummary, Health, Run, Trigger } from '@/lib/types'
import { ApprovalCard, approvalsQuery } from '@/sections/approvals'
import { RUN_STATUS } from '@/sections/runs'
import { BackButton, Card, Empty, Failed, Header, Loading, Row, Screen, SectionLabel, useToast } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { mailboxes } = useAccount()
  const toast = useToast()

  const agent = useQuery({ queryKey: ['agents', 'one', id], queryFn: async () => (await api<{ agent: AgentSummary & { draft?: { mailboxes?: string[] } } }>('GET', `/agents/${id}`)).agent })
  const health = useQuery({ queryKey: ['agents', 'health', id], queryFn: () => api<Health>('GET', `/agents/${id}/health`) })
  const runs = useQuery({ queryKey: ['agents', 'runs', id], queryFn: async () => (await api<{ runs: Run[] }>('GET', `/agents/${id}/runs`)).runs })
  const triggers = useQuery({ queryKey: ['agents', 'triggers', id], queryFn: async () => (await api<{ triggers: Trigger[] }>('GET', `/agents/${id}/triggers`)).triggers })
  const approvals = useQuery(approvalsQuery(id))

  const a = agent.data
  const refetch = () => void Promise.all([agent.refetch(), health.refetch(), runs.refetch(), triggers.refetch(), approvals.refetch()])
  const addresses = (a?.mailboxes ?? a?.draft?.mailboxes ?? []).map((mid) => mailboxes.find((m) => m.id === mid)?.address).filter((v): v is string => !!v)

  async function copy(address: string) {
    await Clipboard.setStringAsync(address)
    toast('Address copied')
  }

  const enabled = (triggers.data ?? []).filter((t) => t.enabled)
  const setup: [string, string][] = [
    ['Triggers', triggers.data ? (enabled.length === 1 ? enabled[0]!.summary : `${enabled.length} on`) : '…'],
    ['Model', a?.model?.id ?? 'Not set'],
    ['This month', health.data ? `$${health.data.monthSpend.toFixed(2)}${health.data.cap ? ` of $${health.data.cap}` : ''}` : '…'],
  ]

  return (
    <Screen>
      <Header left={<BackButton />} />
      {agent.isPending ? (
        <Loading />
      ) : agent.isError || !a ? (
        <Failed message={errorMessage(agent.error)} onRetry={refetch} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={<RefreshControl refreshing={agent.isRefetching} onRefresh={refetch} tintColor={c.dim} />}>
          <View style={{ paddingHorizontal: pad, gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text numberOfLines={2} style={s.name}>
                {a.name}
              </Text>
              {a.hasDraftChanges ? <Text style={s.draft}>Draft changes</Text> : null}
            </View>
            {a.description ? <Text style={{ color: c.muted, fontSize: 15, lineHeight: 21 }}>{a.description}</Text> : null}
            {addresses.map((address) => (
              <Pressable key={address} onPress={() => copy(address)} hitSlop={6} style={s.address}>
                <Text numberOfLines={1} style={{ color: c.soft, fontSize: 14, flexShrink: 1 }}>
                  {address}
                </Text>
                <Copy color={c.dim} size={14} strokeWidth={1.75} />
              </Pressable>
            ))}
          </View>

          {(health.data?.issues ?? []).map((issue, i) => (
            <View key={i} style={s.issue}>
              <CircleAlert color={c.danger} size={18} strokeWidth={1.75} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.danger, fontSize: 15 }}>{issue.message}</Text>
                <Text style={{ color: c.muted, fontSize: 13, marginTop: 4 }}>Fix it in Settings on desktop, then retry.</Text>
              </View>
            </View>
          ))}

          {approvals.data?.approvals.length ? (
            <>
              <SectionLabel>Needs approval</SectionLabel>
              {approvals.data.approvals.map((ap) => (
                <ApprovalCard key={ap.id} approval={ap} canDecide={approvals.data.canDecide} />
              ))}
            </>
          ) : null}

          <SectionLabel right={<Text style={{ color: c.dim, fontSize: 13 }}>{a.status === 'active' ? 'Running' : 'Paused'}</Text>}>Runs</SectionLabel>
          {runs.isPending ? (
            <Loading />
          ) : runs.data?.length ? (
            <Card>
              {runs.data.slice(0, 20).map((r) => {
                const st = RUN_STATUS[r.status] ?? RUN_STATUS.done
                return (
                  <Row key={r.id} onPress={() => router.push({ pathname: '/agent/[id]/run/[runId]', params: { id, runId: r.id } })}>
                    <st.icon color={st.color} size={18} strokeWidth={1.75} />
                    <View style={{ flex: 1 }}>
                      <Text numberOfLines={1} style={{ color: c.text, fontSize: 15 }}>
                        {r.trigger.label}
                      </Text>
                      <Text numberOfLines={1} style={{ color: c.dim, fontSize: 13, marginTop: 2 }}>
                        {r.status === 'done' ? (r.summary ?? st.label) : r.status === 'failed' ? (r.error ?? st.label) : st.label}
                      </Text>
                    </View>
                    <Text style={{ color: c.dim, fontSize: 13 }}>{relative(r.startedAt)}</Text>
                    <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
                  </Row>
                )
              })}
            </Card>
          ) : (
            <Empty>No runs yet.</Empty>
          )}

          <SectionLabel>Setup</SectionLabel>
          <Card>
            {setup.map(([k, v]) => (
              <Row key={k}>
                <Text style={{ color: c.muted, fontSize: 15 }}>{k}</Text>
                <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontSize: 15, textAlign: 'right' }}>
                  {v}
                </Text>
              </Row>
            ))}
            <Row onPress={() => router.push({ pathname: '/agent/[id]/memory', params: { id } })}>
              <Text style={{ flex: 1, color: c.muted, fontSize: 15 }}>Memory</Text>
              <Text style={{ color: c.text, fontSize: 15 }}>{health.data ? health.data.memoryFacts : ''}</Text>
              <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
            </Row>
          </Card>
          <Text style={s.note}>Edit triggers, instructions and tools on desktop.</Text>
        </ScrollView>
      )}
    </Screen>
  )
}

const s = StyleSheet.create({
  name: { color: c.text, fontSize: 22, fontWeight: '500', flexShrink: 1 },
  draft: { color: c.warn, backgroundColor: c.warnBg, fontSize: 12, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden' },
  address: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', marginTop: 4 },
  issue: { flexDirection: 'row', gap: 10, marginHorizontal: pad, marginTop: 16, padding: 14, borderRadius: 14, backgroundColor: c.dangerBg },
  note: { color: c.dim, fontSize: 13, textAlign: 'center', paddingHorizontal: 32, paddingTop: 20 },
})
