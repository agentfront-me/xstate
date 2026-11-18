// One funnel: overall conversion, then each step with a bar, the share who went on and the median time. Read-only;
// funnels are made and changed in the web app.

import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useAccount } from '@/lib/account'
import { duration, percent, stepLabel } from '@/lib/analytics'
import { api, errorMessage, qs } from '@/lib/api'
import { usePickedDomain } from '@/lib/prefs'
import type { Funnel, FunnelResult } from '@/lib/types'
import { BackButton, Card, Failed, Header, Loading, Screen } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

const RANGES = [7, 30, 90] as const

export default function FunnelScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>()
  const { org } = useAccount()
  const domain = usePickedDomain().domain?.name
  const [range, setRange] = useState<(typeof RANGES)[number]>(30)
  const q = useQuery({
    queryKey: ['analytics', 'funnel', org.id, id, range, domain ?? null],
    queryFn: () => api<{ funnel: Funnel; result: FunnelResult }>('GET', `/analytics/orgs/${org.id}/funnels/${id}/result${qs({ range, domain })}`),
  })
  const funnel = q.data?.funnel
  const result = q.data?.result
  const first = result?.steps[0]?.people ?? 0
  const last = result?.steps.at(-1)?.people ?? 0

  return (
    <Screen>
      <Header left={<BackButton />} title={funnel?.name ?? name ?? 'Funnel'} large={false} />
      <View style={s.ranges}>
        {RANGES.map((r) => (
          <Pressable key={r} onPress={() => setRange(r)} style={[s.range, range === r && s.rangeOn]} accessibilityRole="button" accessibilityState={{ selected: range === r }}>
            <Text style={[s.rangeText, range === r && s.rangeTextOn]}>{r} days</Text>
          </Pressable>
        ))}
      </View>
      {q.isPending ? (
        <Loading />
      ) : q.isError || !funnel || !result ? (
        <Failed message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={c.dim} />}
        >
          <View style={s.overall}>
            <Text style={s.dim}>Overall conversion</Text>
            <Text style={s.big}>{percent(result.conversion)}</Text>
            <Text style={s.dim}>
              {last.toLocaleString()} of {first.toLocaleString()} {first === 1 ? 'person' : 'people'} completed every step · {funnel.windowDays} day window
            </Text>
          </View>
          <Card>
            {result.steps.map((step, i) => {
              const share = first ? step.people / first : 0
              return (
                <View key={i} style={s.step}>
                  <View style={s.stepHead}>
                    <Text style={s.n}>{i + 1}</Text>
                    <Text numberOfLines={1} style={s.stepName}>
                      {stepLabel(funnel.steps[i]!)}
                    </Text>
                    <Text style={s.people}>{step.people.toLocaleString()}</Text>
                  </View>
                  <View style={s.track}>
                    <View style={[s.fill, { width: `${Math.max(share * 100, step.people ? 1 : 0)}%` }]} />
                  </View>
                  {i > 0 ? (
                    <Text style={s.dim}>
                      {percent(step.fromPrevious ?? 0)} from previous · {(step.dropped ?? 0).toLocaleString()} dropped · median {duration(step.medianSeconds)}
                    </Text>
                  ) : null}
                </View>
              )
            })}
          </Card>
        </ScrollView>
      )}
    </Screen>
  )
}

const s = StyleSheet.create({
  ranges: { flexDirection: 'row', gap: 8, paddingHorizontal: pad, paddingBottom: 8 },
  range: { height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: c.card, justifyContent: 'center' },
  rangeOn: { backgroundColor: c.text },
  rangeText: { color: c.muted, fontSize: 14 },
  rangeTextOn: { color: c.bg, fontWeight: '500' },
  overall: { paddingHorizontal: pad, paddingVertical: 16, gap: 4 },
  big: { color: c.text, fontSize: 36, fontWeight: '500', fontVariant: ['tabular-nums'] },
  dim: { color: c.dim, fontSize: 13 },
  step: { paddingHorizontal: 14, paddingVertical: 14, gap: 8 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  n: { width: 22, height: 22, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: c.borderStrong, color: c.muted, fontSize: 12, textAlign: 'center', lineHeight: 21 },
  stepName: { flex: 1, color: c.text, fontSize: 15 },
  people: { color: c.text, fontSize: 15, fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 4, backgroundColor: c.raised, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4, backgroundColor: c.text },
})
