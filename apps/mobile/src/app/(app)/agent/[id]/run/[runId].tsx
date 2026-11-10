// One run: how it ended, what it cost, and each step it took.

import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { Bot, type LucideIcon, Wrench, Zap } from 'lucide-react-native'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { api, errorMessage } from '@/lib/api'
import { formatTime, formatUsd, label } from '@/lib/format'
import type { Run, RunStep } from '@/lib/types'
import { ApprovalCard, approvalsQuery } from '@/sections/approvals'
import { RUN_STATUS } from '@/sections/runs'
import { BackButton, Failed, Header, Loading, Screen, SectionLabel } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

function describe(step: RunStep): { icon: LucideIcon; title: string; detail: string } {
  const d = step.detail
  if (step.kind === 'model') {
    const calls = Array.isArray(d.calls) ? (d.calls as { toolName?: string }[]).map((call) => call.toolName).filter(Boolean) : []
    return { icon: Bot, title: calls.length ? `Decided to use ${calls.join(', ')}` : 'Thought', detail: typeof d.text === 'string' ? d.text : '' }
  }
  if (step.kind === 'tool') {
    const output = typeof d.output === 'string' ? d.output : d.output === undefined ? '' : JSON.stringify(d.output)
    return { icon: Wrench, title: String(d.tool ?? 'Tool'), detail: output }
  }
  const text = typeof d.message === 'string' ? d.message : typeof d.reason === 'string' ? d.reason : ''
  return { icon: Zap, title: label(step.kind), detail: text }
}

export default function RunScreen() {
  const { id, runId } = useLocalSearchParams<{ id: string; runId: string }>()
  const run = useQuery({
    queryKey: ['agents', 'run', id, runId],
    queryFn: () => api<{ run: Run; steps: RunStep[] }>('GET', `/agents/${id}/runs/${runId}`),
    // A run in progress keeps moving; look again every few seconds until it settles.
    refetchInterval: (q) => (q.state.data && ['running', 'waiting_for_approval'].includes(q.state.data.run.status) ? 5000 : false),
  })
  const approvals = useQuery(approvalsQuery(id))
  const r = run.data?.run
  const st = r ? (RUN_STATUS[r.status] ?? RUN_STATUS.done) : null
  const pending = (approvals.data?.approvals ?? []).filter((a) => a.runId === runId)
  const seconds = r?.finishedAt ? Math.max(1, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)) : null

  return (
    <Screen>
      <Header title={`Run ${runId.slice(-6)}`} large={false} left={<BackButton />} />
      {run.isPending ? (
        <Loading />
      ) : run.isError || !r || !st ? (
        <Failed message={errorMessage(run.error)} onRetry={() => void run.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={<RefreshControl refreshing={run.isRefetching} onRefresh={() => void run.refetch()} tintColor={c.dim} />}>
          <View style={{ paddingHorizontal: pad, gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <st.icon color={st.color} size={22} strokeWidth={1.75} />
              <Text style={{ color: c.text, fontSize: 22, fontWeight: '500' }}>{st.label}</Text>
            </View>
            <Text style={{ color: c.dim, fontSize: 13 }}>
              {[r.trigger.label, formatTime(r.startedAt), seconds ? `${seconds}s` : null, `${r.steps} steps`, formatUsd(r.cost)].filter(Boolean).join(' · ')}
            </Text>
            {r.summary ? <Text style={{ color: c.soft, fontSize: 15, lineHeight: 22 }}>{r.summary}</Text> : null}
            {r.error ? <Text style={{ color: c.danger, fontSize: 15, lineHeight: 22 }}>{r.error}</Text> : null}
          </View>

          {pending.length ? (
            <>
              <SectionLabel>Waiting for you</SectionLabel>
              {pending.map((a) => (
                <ApprovalCard key={a.id} approval={a} canDecide={approvals.data?.canDecide ?? false} />
              ))}
            </>
          ) : null}

          <SectionLabel>Steps</SectionLabel>
          <View style={{ paddingHorizontal: pad }}>
            {run.data.steps.map((step, i) => {
              const { icon: Icon, title, detail } = describe(step)
              return (
                <View key={step.seq} style={s.step}>
                  <View style={{ alignItems: 'center' }}>
                    <View style={s.stepIcon}>
                      <Icon color={c.muted} size={14} strokeWidth={1.75} />
                    </View>
                    {i < run.data.steps.length - 1 ? <View style={s.line} /> : null}
                  </View>
                  <View style={{ flex: 1, paddingBottom: 18 }}>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      <Text numberOfLines={2} style={{ flex: 1, color: c.text, fontSize: 15 }}>
                        {title}
                      </Text>
                      <Text style={{ color: c.dim, fontSize: 13 }}>{formatTime(step.at)}</Text>
                    </View>
                    {detail ? (
                      <Text numberOfLines={6} style={{ color: c.muted, fontSize: 14, lineHeight: 20, marginTop: 4 }}>
                        {detail}
                      </Text>
                    ) : null}
                  </View>
                </View>
              )
            })}
            {run.data.steps.length === 0 ? <Text style={{ color: c.dim, fontSize: 15 }}>No steps recorded.</Text> : null}
          </View>
        </ScrollView>
      )}
    </Screen>
  )
}

const s = StyleSheet.create({
  step: { flexDirection: 'row', gap: 12 },
  stepIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' },
  line: { flex: 1, width: StyleSheet.hairlineWidth, backgroundColor: c.borderStrong, marginVertical: 4 },
})
