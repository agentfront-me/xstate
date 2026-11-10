// One person: who they are, what we know about them, and the mail to and from them.

import { useQuery } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { ChevronRight, Mail } from 'lucide-react-native'
import { ScrollView, Text, View } from 'react-native'
import { useAccount } from '@/lib/account'
import { api, errorMessage } from '@/lib/api'
import { formatTime, initial, label, longDate, personName, relative } from '@/lib/format'
import type { PersonDetail } from '@/lib/types'
import { Avatar, BackButton, Card, Empty, Failed, Header, IconButton, Loading, Row, Screen, SectionLabel } from '@/ui/kit'
import { c } from '@/ui/theme'

const KIND = { user: 'User', lead: 'Lead', contact: 'Contact' } as const

const HIDDEN = new Set(['other', 'googleId', 'google_id'])

export default function UserScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { org } = useAccount()
  const detail = useQuery({ queryKey: ['audience', 'person', org.id, id], queryFn: () => api<PersonDetail>('GET', `/audience/orgs/${org.id}/people/${id}`) })
  const p = detail.data?.person

  const facts: [string, string][] = p
    ? [
        ['Type', p.kind === 'contact' && p.attributes.other === true ? 'Other contact' : KIND[p.kind]],
        ...(p.phone ? [['Phone', p.phone] as [string, string]] : []),
        ...Object.entries(p.attributes)
          // `other` and the Google id are bookkeeping from the Google import, not facts about the person.
          .filter(([k, v]) => !HIDDEN.has(k) && (typeof v !== 'boolean' || v))
          .slice(0, 8)
          .map(([k, v]) => [label(k), v === true ? 'Yes' : String(v)] as [string, string]),
        ['First seen', longDate(p.firstSeenAt)],
        ['Last seen', relative(p.lastSeenAt)],
      ]
    : []

  return (
    <Screen>
      <Header
        left={<BackButton />}
        right={p?.email ? <IconButton icon={Mail} label="Send email" onPress={() => router.push({ pathname: '/compose', params: { to: p.email ?? '' } })} /> : null}
      />
      {detail.isPending ? (
        <Loading />
      ) : detail.isError || !p ? (
        <Failed message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          <View style={{ alignItems: 'center', paddingVertical: 16, gap: 6 }}>
            <Avatar text={initial(personName(p))} size={64} />
            <Text style={{ color: c.text, fontSize: 22, fontWeight: '500', marginTop: 8 }}>{personName(p)}</Text>
            {p.name && p.email ? <Text style={{ color: c.muted, fontSize: 15 }}>{p.email}</Text> : null}
          </View>

          <Card>
            {facts.map(([k, v]) => (
              <Row key={k}>
                <Text style={{ color: c.muted, fontSize: 15 }}>{k}</Text>
                <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontSize: 15, textAlign: 'right' }}>
                  {v}
                </Text>
              </Row>
            ))}
          </Card>

          <SectionLabel>Conversations</SectionLabel>
          {detail.data.emails?.length ? (
            <Card>
              {detail.data.emails.map((m) => (
                <Row key={`${m.mailboxId}:${m.id}`} onPress={() => router.push({ pathname: '/thread', params: { mailboxId: m.mailboxId, threadId: m.threadId, id: m.id, subject: m.subject } })}>
                  <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontSize: 15 }}>
                    {m.subject || '(no subject)'}
                  </Text>
                  <Text style={{ color: c.dim, fontSize: 13 }}>{formatTime(m.receivedAt)}</Text>
                  <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
                </Row>
              ))}
            </Card>
          ) : (
            <Empty>No conversations yet.</Empty>
          )}
        </ScrollView>
      )}
    </Screen>
  )
}
