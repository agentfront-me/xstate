// Settings: your account, the notification switches (sent to the API by lib/push.ts), and a read-only look at the workspace (members, domains,
// AI providers). Changes to the workspace are made on desktop.

import { useQuery } from '@tanstack/react-query'
import Constants from 'expo-constants'
import { router } from 'expo-router'
import { AtSign, ChevronRight, type LucideIcon, Sparkles, Users } from 'lucide-react-native'
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { canManage, useAccount } from '@/lib/account'
import { APP_VARIANT } from '@/lib/api'
import { initial } from '@/lib/format'
import { type Notify, setPrefs, usePrefs } from '@/lib/prefs'
import { usePushStatus } from '@/lib/push'
import { signOut } from '@/lib/sign-out'
import { membersQuery, providersQuery, providerState, worstProvider } from '@/sections/workspace'
import { Avatar, BackButton, Card, Header, Row, Screen, SectionLabel, Toggle } from '@/ui/kit'
import { c, pad } from '@/ui/theme'

const SWITCHES: { id: keyof Notify; title: string; sub: string }[] = [
  { id: 'email', title: 'New email', sub: 'Unread mail in the selected domain' },
  { id: 'approvals', title: 'Approvals', sub: 'When an agent needs your OK' },
  { id: 'agentErrors', title: 'Agent errors', sub: 'Failed runs and rejected keys' },
]

const role = (r: string) => r.charAt(0).toUpperCase() + r.slice(1)

export default function SettingsScreen() {
  const { user, org, domains } = useAccount()
  const { notify } = usePrefs()
  const push = usePushStatus()
  const admin = canManage(org)
  const members = useQuery(membersQuery(org.id))
  const providers = useQuery({ ...providersQuery(org.id), enabled: admin })

  const verified = domains.filter((d) => d.status === 'verified').length
  const worst = worstProvider(providers.data)

  const platform = Platform.OS === 'ios' ? 'iOS' : 'Android'
  const variant = APP_VARIANT === 'production' ? '' : ` · ${role(APP_VARIANT)}`

  return (
    <Screen>
      <Header title="Settings" left={<BackButton />} />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <SectionLabel>Account</SectionLabel>
        <Card>
          <Row>
            <Avatar text={initial(user.name ?? user.email)} size={40} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={s.title}>
                {user.name ?? user.email}
              </Text>
              <Text numberOfLines={1} style={s.sub}>
                {user.email} · {role(org.role)}
              </Text>
            </View>
          </Row>
        </Card>

        <SectionLabel>Notifications</SectionLabel>
        <Card>
          {SWITCHES.map((sw) => (
            <Row key={sw.id}>
              <View style={{ flex: 1 }}>
                <Text style={s.title}>{sw.title}</Text>
                <Text style={s.sub}>{sw.sub}</Text>
              </View>
              <Toggle label={sw.title} value={notify[sw.id]} onChange={(on) => setPrefs({ notify: { ...notify, [sw.id]: on } })} />
            </Row>
          ))}
        </Card>

        {push === 'denied' ? <Text style={s.note}>{"Notifications are turned off for xstate in your phone's settings."}</Text> : null}
        {push === 'unavailable' ? <Text style={s.note}>{"This device can't receive notifications."}</Text> : null}

        <SectionLabel>Workspace</SectionLabel>
        <Card>
          <Link icon={Users} title="Members" value={members.data ? `${members.data.length} ${members.data.length === 1 ? 'member' : 'members'}` : ''} onPress={() => router.push('/settings/members')} />
          <Link
            icon={AtSign}
            title="Domains"
            value={domains.length === 0 ? 'None' : verified === domains.length ? `${verified} verified` : `${verified} of ${domains.length} verified`}
            onPress={() => router.push('/settings/domains')}
          />
          {admin ? (
            <Link
              icon={Sparkles}
              title="AI providers"
              value={worst ? providerState(worst).label : providers.data ? 'No key' : ''}
              color={worst ? providerState(worst).color : undefined}
              onPress={() => router.push('/settings/providers')}
            />
          ) : null}
        </Card>

        <Pressable onPress={() => void signOut()} style={({ pressed }) => [s.logOut, pressed && { backgroundColor: c.raised }]}>
          <Text style={{ color: c.danger, fontSize: 16, fontWeight: '500' }}>Log out</Text>
        </Pressable>
        <Text style={s.version}>
          xstate for {platform} · {Constants.expoConfig?.version ?? ''}
          {variant}
        </Text>
      </ScrollView>
    </Screen>
  )
}

function Link({ icon: Icon, title, value, color = c.dim, onPress }: { icon: LucideIcon; title: string; value: string; color?: string; onPress: () => void }) {
  return (
    <Row onPress={onPress}>
      <Icon color={c.muted} size={20} strokeWidth={1.75} />
      <Text style={[s.title, { flex: 1 }]}>{title}</Text>
      <Text style={{ color, fontSize: 14 }}>{value}</Text>
      <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
    </Row>
  )
}

const s = StyleSheet.create({
  title: { color: c.text, fontSize: 16 },
  sub: { color: c.dim, fontSize: 13, marginTop: 2 },
  note: { color: c.dim, fontSize: 13, paddingHorizontal: pad + 4, paddingTop: 10 },
  logOut: { height: 52, marginHorizontal: pad, marginTop: 24, borderRadius: 14, backgroundColor: c.card, alignItems: 'center', justifyContent: 'center' },
  version: { color: c.faint, fontSize: 13, textAlign: 'center', paddingTop: 16 },
})
