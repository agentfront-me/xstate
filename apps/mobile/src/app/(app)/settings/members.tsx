// Everyone in the organization: role and status. Tap someone for their details, where owners and admins can sign
// them out everywhere, suspend or restore them. Adding people and the rest happen on the web.

import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ChevronRight } from 'lucide-react-native'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { canManage, useAccount } from '@/lib/account'
import { errorMessage } from '@/lib/api'
import { initialsOf, memberLine, membersQuery, memberState, ROLE } from '@/sections/workspace'
import { Avatar, BackButton, Card, Empty, Failed, Header, Loading, Row, Screen } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

export default function MembersScreen() {
  const { org } = useAccount()
  const members = useQuery(membersQuery(org.id))
  const refresh = () => void members.refetch()

  return (
    <Screen>
      <Header title="Members" left={<BackButton />} />
      {members.isError ? (
        <Failed message={errorMessage(members.error)} onRetry={refresh} />
      ) : !members.data ? (
        <Loading />
      ) : (
        <ScrollView contentContainerStyle={{ paddingTop: 8, paddingBottom: 32 }} refreshControl={<RefreshControl refreshing={members.isRefetching} onRefresh={refresh} tintColor={c.dim} />}>
          {members.data.length === 0 ? (
            <Empty>No members.</Empty>
          ) : (
            <Card>
              {members.data.map((m) => {
                const state = memberState(m)
                const dim = !!(m.suspendedAt || m.deleteAfter)
                return (
                  <Row key={m.id} onPress={() => router.push({ pathname: '/settings/member/[id]', params: { id: m.id } })}>
                    <View style={dim && { opacity: 0.5 }}>
                      <Avatar text={initialsOf(m)} />
                    </View>
                    <View style={{ flex: 1, opacity: dim ? 0.6 : 1 }}>
                      <Text numberOfLines={1} style={s.title}>
                        {m.name ?? m.email}
                        {m.you ? <Text style={s.you}> (you)</Text> : null}
                      </Text>
                      <Text numberOfLines={1} style={s.sub}>
                        {memberLine(m)}
                      </Text>
                    </View>
                    <Text style={{ color: state?.color ?? c.dim, fontSize: 14 }}>{state?.label ?? ROLE[m.role]}</Text>
                    <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
                  </Row>
                )
              })}
            </Card>
          )}
          <Text style={s.note}>
            {canManage(org) ? 'Add people, change addresses and passwords, or delete members on the web.' : 'Only owners and admins can change members.'}
          </Text>
        </ScrollView>
      )}
    </Screen>
  )
}

const s = StyleSheet.create({
  title: { color: c.text, fontSize: 16 },
  you: { color: c.dim },
  sub: { color: c.dim, fontSize: 13, marginTop: 2 },
  note: { color: c.dim, fontSize: 13, paddingHorizontal: pad + 4, paddingTop: 12 },
})
