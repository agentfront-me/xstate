// Agents: what needs your approval, then every agent with a switch to pause or resume it.

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ChevronRight, Menu } from 'lucide-react-native'
import { useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAccount } from '@/lib/account'
import { api, errorMessage } from '@/lib/api'
import type { AgentSummary } from '@/lib/types'
import { Card, Empty, Failed, Header, IconButton, Loading, Row, SectionLabel, Toggle, useToast } from '@/ui/kit'
import { c } from '@/ui/theme'
import { ApprovalCard, approvalsQuery } from './approvals'

export const agentsQuery = (orgId: string) => ({
  queryKey: ['agents', 'list', orgId] as const,
  queryFn: async () => (await api<{ agents: AgentSummary[] }>('GET', `/agents/orgs/${orgId}`)).agents,
})

export function statusText(a: AgentSummary): string {
  if (a.issue) return a.issue.message
  if (a.status === 'paused') return 'Paused'
  return a.pendingApprovals ? `Running · ${a.pendingApprovals} waiting for you` : 'Running'
}

export function Agents({ onMenu }: { onMenu: () => void }) {
  const { org } = useAccount()
  const insets = useSafeAreaInsets()
  const client = useQueryClient()
  const toast = useToast()
  const list = useQuery(agentsQuery(org.id))
  // The spinner is for a pull only; an approval or a switch reloads the list quietly.
  const [pulling, setPulling] = useState(false)
  async function refresh() {
    setPulling(true)
    await client.invalidateQueries({ queryKey: ['agents'] }).catch(() => {})
    setPulling(false)
  }
  const agents = list.data ?? []

  // The API lists approvals per agent, so ask only the agents that have some.
  const waiting = agents.filter((a) => a.pendingApprovals)
  const approvals = useQueries({ queries: waiting.map((a) => approvalsQuery(a.id)) })
  const pending = approvals.flatMap((q, i) => (q.data?.approvals ?? []).map((approval) => ({ approval, agent: waiting[i]!, canDecide: q.data!.canDecide })))

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'active' | 'paused' }) => api('POST', `/agents/${id}/status`, { status }),
    onMutate: ({ id, status }) => {
      client.setQueryData<AgentSummary[]>(agentsQuery(org.id).queryKey, (old) => old?.map((a) => (a.id === id ? { ...a, status } : a)))
    },
    onError: (err) => toast(errorMessage(err)),
    onSettled: () => void client.invalidateQueries({ queryKey: ['agents', 'list'] }),
  })

  return (
    <View style={{ flex: 1 }}>
      <Header title="Agents" left={<IconButton icon={Menu} label="Menu" onPress={onMenu} />} />
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <Failed message={errorMessage(list.error)} onRetry={() => void list.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          refreshControl={<RefreshControl refreshing={pulling} onRefresh={() => void refresh()} tintColor={c.dim} />}
        >
          <SectionLabel>Needs approval</SectionLabel>
          {pending.length ? (
            pending.map(({ approval, agent, canDecide }) => <ApprovalCard key={approval.id} approval={approval} agentName={agent.name} canDecide={canDecide} />)
          ) : (
            <Text style={s.caughtUp}>All caught up.</Text>
          )}

          <SectionLabel>Agents</SectionLabel>
          {agents.length ? (
            <Card>
              {agents.map((a) => (
                <Row key={a.id} onPress={() => router.push({ pathname: '/agent/[id]', params: { id: a.id } })}>
                  <View style={[s.dot, { backgroundColor: a.issue ? c.danger : a.status === 'active' ? c.white : c.faint }]} />
                  <View style={{ flex: 1 }}>
                    <Text numberOfLines={1} style={{ color: c.text, fontSize: 16 }}>
                      {a.name}
                    </Text>
                    <Text numberOfLines={1} style={{ color: a.issue ? c.danger : c.dim, fontSize: 13, marginTop: 2 }}>
                      {statusText(a)}
                    </Text>
                  </View>
                  <Toggle label={`${a.name} is on`} value={a.status === 'active'} onChange={(on) => setStatus.mutate({ id: a.id, status: on ? 'active' : 'paused' })} />
                  <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
                </Row>
              ))}
            </Card>
          ) : (
            <Empty>No agents yet. Create one on desktop.</Empty>
          )}
        </ScrollView>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  dot: { width: 8, height: 8, borderRadius: 4 },
  caughtUp: { color: c.dim, fontSize: 15, paddingHorizontal: 16, paddingVertical: 4 },
})
