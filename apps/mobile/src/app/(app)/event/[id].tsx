// One analytics event: what happened, who did it, and the visit it belongs to (source, device, location).

import { useQuery } from '@tanstack/react-query'
import { router, useLocalSearchParams } from 'expo-router'
import { ChevronRight } from 'lucide-react-native'
import { ScrollView, Text, View } from 'react-native'
import { useAccount } from '@/lib/account'
import { TYPE_LABEL, countryName, eventLabel, whoLabel } from '@/lib/analytics'
import { api, errorMessage } from '@/lib/api'
import type { FeedEvent } from '@/lib/types'
import { BackButton, Card, Failed, Header, Loading, Row, Screen, SectionLabel } from '@/ui/kit'
import { c } from '@/ui/theme'

type Visit = Record<string, string | number>

/** The visit's columns worth showing, in order, with their labels. */
const VISIT: [string, string][] = [
  ['channel', 'Channel'],
  ['referring_domain', 'Referrer'],
  ['utm_source', 'UTM source'],
  ['utm_medium', 'UTM medium'],
  ['utm_campaign', 'UTM campaign'],
  ['click_id', 'Ad click'],
  ['landing_path', 'Landing page'],
  ['city', 'City'],
  ['region', 'Region'],
  ['country', 'Country'],
  ['as_org', 'Network'],
  ['ip', 'IP address'],
  ['device_type', 'Device'],
  ['browser', 'Browser'],
  ['os', 'System'],
  ['screen', 'Screen'],
  ['locale', 'Language'],
]

export default function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { org } = useAccount()
  const detail = useQuery({
    queryKey: ['analytics', 'event', org.id, id],
    queryFn: () => api<{ event: FeedEvent; visit: Visit | null }>('GET', `/analytics/orgs/${org.id}/events/${id}`),
  })
  const e = detail.data?.event
  const visit = detail.data?.visit ?? {}
  const props = e ? Object.entries(e.properties).filter(([k, v]) => v !== null && v !== '' && !(e.type === 'email' && (k === 'mailbox_id' || k === 'email_id'))) : []

  return (
    <Screen>
      <Header left={<BackButton />} title={e ? TYPE_LABEL[e.type] : ''} large={false} />
      {detail.isPending ? (
        <Loading />
      ) : detail.isError || !e ? (
        <Failed message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}>
            <Text style={{ color: c.text, fontSize: 22, fontWeight: '500' }}>{eventLabel(e)}</Text>
            <Text style={{ color: c.dim, fontSize: 14 }}>{new Date(e.occurredAt).toLocaleString()}</Text>
          </View>

          <Card>
            <Row onPress={() => router.push({ pathname: '/user/[id]', params: { id: e.person.id } })}>
              <Text style={{ color: c.muted, fontSize: 15 }}>Person</Text>
              <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontSize: 15, textAlign: 'right' }}>
                {whoLabel(e.person)}
              </Text>
              <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
            </Row>
          </Card>

          {props.length ? (
            <>
              <SectionLabel>{e.type === 'identify' ? 'Traits' : 'Properties'}</SectionLabel>
              <Card>
                {props.map(([k, v]) => (
                  <Pair key={k} label={k} value={typeof v === 'object' ? JSON.stringify(v) : String(v)} />
                ))}
              </Card>
            </>
          ) : null}

          {Object.keys(visit).length ? (
            <>
              <SectionLabel>Visit</SectionLabel>
              <Card>
                {VISIT.filter(([k]) => visit[k] !== undefined).map(([k, label]) => (
                  <Pair key={k} label={label} value={k === 'country' ? countryName(String(visit[k])) : String(visit[k])} />
                ))}
              </Card>
            </>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  )
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <Row>
      <Text style={{ color: c.muted, fontSize: 15 }}>{label}</Text>
      <Text numberOfLines={2} style={{ flex: 1, color: c.text, fontSize: 15, textAlign: 'right' }}>
        {value}
      </Text>
    </Row>
  )
}
