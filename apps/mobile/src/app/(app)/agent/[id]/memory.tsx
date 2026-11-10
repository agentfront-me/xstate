// What an agent remembers, grouped by who or what each fact is about. A fact can be removed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { X } from 'lucide-react-native'
import { Alert, RefreshControl, ScrollView, Text, View } from 'react-native'
import { api, errorMessage } from '@/lib/api'
import { relative } from '@/lib/format'
import type { Fact } from '@/lib/types'
import { BackButton, Card, Empty, Failed, Header, IconButton, Loading, Row, Screen, SectionLabel, useToast } from '@/ui/kit'
import { c } from '@/ui/theme'

export default function Memory() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const client = useQueryClient()
  const toast = useToast()
  const key = ['agents', 'memory', id]
  const memory = useQuery({ queryKey: key, queryFn: async () => (await api<{ facts: Fact[] }>('GET', `/agents/${id}/memory`)).facts })

  const remove = useMutation({
    mutationFn: (factId: string) => api('DELETE', `/agents/${id}/memory/${factId}`),
    onSuccess: () => {
      toast('Forgotten')
      void client.invalidateQueries({ queryKey: key })
      void client.invalidateQueries({ queryKey: ['agents', 'health', id] })
    },
    onError: (err) => toast(errorMessage(err)),
  })

  const confirm = (fact: Fact) =>
    Alert.alert('Forget this?', fact.fact, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => remove.mutate(fact.id) },
    ])

  const groups = new Map<string, Fact[]>()
  for (const fact of memory.data ?? []) groups.set(fact.subject, [...(groups.get(fact.subject) ?? []), fact])

  return (
    <Screen>
      <Header title="Memory" left={<BackButton />} />
      {memory.isPending ? (
        <Loading />
      ) : memory.isError ? (
        <Failed message={errorMessage(memory.error)} onRetry={() => void memory.refetch()} />
      ) : groups.size === 0 ? (
        <Empty>Nothing remembered yet.</Empty>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={<RefreshControl refreshing={memory.isRefetching} onRefresh={() => void memory.refetch()} tintColor={c.dim} />}>
          {[...groups].map(([subject, facts]) => (
            <View key={subject}>
              <SectionLabel>{subject}</SectionLabel>
              <Card>
                {facts.map((fact) => (
                  <Row key={fact.id} style={{ alignItems: 'flex-start' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: c.text, fontSize: 15, lineHeight: 21 }}>{fact.fact}</Text>
                      <Text style={{ color: c.dim, fontSize: 13, marginTop: 4 }}>{relative(fact.updatedAt)}</Text>
                    </View>
                    <IconButton icon={X} label="Forget" color={c.dim} size={18} onPress={() => confirm(fact)} />
                  </Row>
                ))}
              </Card>
            </View>
          ))}
        </ScrollView>
      )}
    </Screen>
  )
}
