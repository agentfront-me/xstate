// One member: role, addresses and the shared mailboxes they can open. Owners and admins can also sign them out
// everywhere, suspend or restore them, and restore them while their deletion is pending (the API decides who may:
// never the owner, an admin only by an owner or admin, and nobody suspends themselves).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { canManage, useAccount } from '@/lib/account'
import { api, errorMessage } from '@/lib/api'
import { clearSession } from '@/lib/session'
import type { OrgMember } from '@/lib/types'
import { initialsOf, membersQuery, memberState, ROLE } from '@/sections/workspace'
import { Avatar, BackButton, Button, Card, Failed, Header, Loading, Row, Screen, SectionLabel } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

type Action = 'sign-out' | 'suspend' | 'restore'

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export default function MemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { org, mailboxes } = useAccount()
  const client = useQueryClient()
  const members = useQuery(membersQuery(org.id))
  const m = members.data?.find((x) => x.id === id)

  const act = useMutation({
    mutationFn: async (action: Action) => (await api<{ member: OrgMember }>('POST', `/members/${id}/${action}`)).member,
    onSuccess: (member, action) => {
      // Signing yourself out everywhere ends this session too: straight to sign-in.
      if (member.you && action === 'sign-out') return void clearSession()
      client.setQueryData<OrgMember[]>(['members', org.id], (list = []) => list.map((x) => (x.id === member.id ? member : x)))
    },
    onError: (err) => Alert.alert("That didn't work", errorMessage(err)),
  })

  const confirm = (action: Action, title: string, body: string, button: string) =>
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel' },
      { text: button, style: action === 'restore' ? 'default' : 'destructive', onPress: () => act.mutate(action) },
    ])

  if (members.isError) {
    return (
      <Screen>
        <Header title="Member" left={<BackButton />} />
        <Failed message={errorMessage(members.error)} onRetry={() => void members.refetch()} />
      </Screen>
    )
  }
  if (!m) {
    return (
      <Screen>
        <Header title="Member" left={<BackButton />} />
        {members.isPending ? <Loading /> : <Text style={s.note}>This member is no longer in the organization.</Text>}
      </Screen>
    )
  }

  const name = m.name ?? m.email
  const state = memberState(m)
  const admin = canManage(org)
  // What the API allows, so buttons only show where they work.
  const canAct = admin && m.role !== 'owner' && (m.role !== 'admin' || org.role === 'owner' || org.role === 'admin')
  const invited = m.status === 'invited'
  const shared = m.sharedAccess
    .map((a) => ({ ...a, mailbox: mailboxes.find((mb) => mb.id === a.mailboxId) }))
    .filter((a) => a.mailbox)

  return (
    <Screen>
      <Header title={name} left={<BackButton />} large={false} />
      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={members.isRefetching} onRefresh={() => void members.refetch()} tintColor={c.dim} />}
      >
        <View style={s.head}>
          <Avatar text={initialsOf(m)} size={48} />
          <View style={{ flex: 1 }}>
            <Text style={s.name} numberOfLines={1}>
              {name}
            </Text>
            <Text style={s.sub} numberOfLines={1}>
              {m.email}
            </Text>
          </View>
        </View>

        <Card>
          <Row>
            <Text style={s.label}>Role</Text>
            <Text style={s.value}>{ROLE[m.role]}</Text>
          </Row>
          {state ? (
            <Row>
              <Text style={s.label}>Status</Text>
              <Text style={[s.value, { color: state.color }]}>
                {m.deleteAfter ? `Deleted for good ${day(m.deleteAfter)}` : m.suspendedAt ? `Suspended since ${day(m.suspendedAt)}` : state.label}
              </Text>
            </Row>
          ) : null}
        </Card>

        {m.mailbox ? (
          <>
            <SectionLabel>Addresses</SectionLabel>
            <Card>
              {m.mailbox.addresses.map((a) => (
                <Row key={a.id}>
                  <Text style={[s.value, { flex: 1, textAlign: 'left' }]} numberOfLines={1}>
                    {a.address}
                  </Text>
                  {a.primary ? <Text style={s.tag}>Primary</Text> : null}
                </Row>
              ))}
            </Card>
          </>
        ) : null}

        {shared.length ? (
          <>
            <SectionLabel>Shared mailboxes</SectionLabel>
            <Card>
              {shared.map((a) => (
                <Row key={a.mailboxId}>
                  <Text style={[s.value, { flex: 1, textAlign: 'left' }]} numberOfLines={1}>
                    {a.mailbox!.address}
                  </Text>
                  <Text style={s.sub}>{a.access === 'read' ? 'Read only' : 'Full'}</Text>
                </Row>
              ))}
            </Card>
          </>
        ) : null}

        {(canAct || m.you) && !invited ? (
          <View style={s.actions}>
            {m.deleteAfter ? (
              <Button
                title="Restore member"
                variant="secondary"
                busy={act.isPending}
                onPress={() => confirm('restore', `Restore ${name}?`, 'Their access and mailbox go back to how they were. Paused agents stay paused.', 'Restore')}
              />
            ) : (
              <>
                {!m.suspendedAt ? (
                  <Button
                    title="Sign out everywhere"
                    variant="secondary"
                    busy={act.isPending && act.variables === 'sign-out'}
                    onPress={() =>
                      m.you
                        ? confirm('sign-out', 'Sign out everywhere?', "You're signed out of xstate on every computer and phone, this one too.", 'Sign out')
                        : confirm('sign-out', `Sign ${name} out everywhere?`, 'They are signed out of xstate on every computer and phone, and can sign in again.', 'Sign out')
                    }
                  />
                ) : null}
                {!m.you && canAct ? (
                  m.suspendedAt ? (
                    <Button
                      title="Restore access"
                      variant="secondary"
                      busy={act.isPending && act.variables === 'restore'}
                      onPress={() => confirm('restore', `Restore ${name}'s access?`, 'They can sign in and use the organization again.', 'Restore')}
                    />
                  ) : (
                    <Button
                      title="Suspend access"
                      variant="danger"
                      busy={act.isPending && act.variables === 'suspend'}
                      onPress={() =>
                        confirm('suspend', `Suspend ${name}?`, 'They are signed out and can’t sign in until you restore them. Their mail and files are kept.', 'Suspend')
                      }
                    />
                  )
                ) : null}
              </>
            )}
          </View>
        ) : null}

        <Text style={s.note}>
          {admin ? 'Change addresses, passwords and shared mailboxes, or delete members, on the web.' : 'Only owners and admins can change members.'}
        </Text>
      </ScrollView>
    </Screen>
  )
}

const s = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: pad + 4, paddingVertical: 16 },
  name: { color: c.text, fontSize: 20, fontWeight: '500' },
  sub: { color: c.dim, fontSize: 14, marginTop: 2 },
  label: { color: c.muted, fontSize: 16, flex: 1 },
  value: { color: c.text, fontSize: 16, textAlign: 'right' },
  tag: { color: c.dim, fontSize: 12, borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
  actions: { gap: 10, paddingHorizontal: pad, paddingTop: 20 },
  note: { color: c.dim, fontSize: 13, paddingHorizontal: pad + 4, paddingTop: 16 },
})
