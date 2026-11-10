// What an agent is waiting on a person for. Shown in the Agents list, on an agent and on a run.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { StyleSheet, Text, View } from 'react-native'
import { api, errorMessage } from '@/lib/api'
import { relative } from '@/lib/format'
import type { Approval } from '@/lib/types'
import { Button, useToast } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

export const approvalsQuery = (agentId: string) => ({
  queryKey: ['agents', 'approvals', agentId] as const,
  queryFn: () => api<{ approvals: Approval[]; canDecide: boolean }>('GET', `/agents/${agentId}/approvals?status=pending`),
})

export function ApprovalCard({ approval: a, agentName, canDecide }: { approval: Approval; agentName?: string; canDecide: boolean }) {
  const client = useQueryClient()
  const toast = useToast()
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => api('POST', `/agents/${a.agentId}/approvals/${encodeURIComponent(a.id)}`, { decision }),
    onSuccess: (_data, decision) => {
      toast(decision === 'approve' ? 'Approved' : 'Rejected')
      void client.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (err) => toast(errorMessage(err)),
  })

  return (
    <View style={s.card}>
      <Text style={s.title}>{a.toolLabel}</Text>
      {a.reason ? <Text style={s.why}>{a.reason}</Text> : null}
      <Text style={s.meta}>
        {[agentName, `Run ${a.runId.slice(-6)}`, `asked ${relative(a.createdAt).toLowerCase()}`].filter(Boolean).join(' · ')}
      </Text>
      {canDecide ? (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
          <Button title="Approve" small style={{ flex: 1 }} busy={decide.isPending && decide.variables === 'approve'} disabled={decide.isPending} onPress={() => decide.mutate('approve')} />
          <Button title="Reject" small variant="secondary" style={{ flex: 1 }} busy={decide.isPending && decide.variables === 'reject'} disabled={decide.isPending} onPress={() => decide.mutate('reject')} />
        </View>
      ) : (
        <Text style={[s.meta, { marginTop: 10 }]}>Only an approver can decide this.</Text>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  card: { backgroundColor: c.card, borderRadius: 14, marginHorizontal: pad, marginBottom: 10, padding: 14 },
  title: { color: c.text, fontSize: 16, fontWeight: '500' },
  why: { color: c.soft, fontSize: 14, lineHeight: 20, marginTop: 4 },
  meta: { color: c.dim, fontSize: 13, marginTop: 8 },
})
