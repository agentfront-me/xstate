// The side menu: the account, the domain switcher, the four sections, Settings and Log out.

import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { Bot, Check, ChevronDown, ChevronUp, Globe, HardDrive, Inbox, LogOut, type LucideIcon, Settings, Users } from 'lucide-react-native'
import { useEffect, useState } from 'react'
import { Animated, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAccount } from '@/lib/account'
import { api } from '@/lib/api'
import { initial } from '@/lib/format'
import { setPrefs, usePickedDomain } from '@/lib/prefs'
import { signOut } from '@/lib/sign-out'
import type { MailboxFolders } from '@/lib/types'
import { Avatar } from '@/ui/kit'
import { c } from '@/ui/theme'

export type Section = 'email' | 'users' | 'storage' | 'agents'

const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: 'email', label: 'Email', icon: Inbox },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'agents', label: 'Agents', icon: Bot },
]

export const foldersQuery = (orgId: string) => ({
  queryKey: ['mail', 'folders', orgId] as const,
  queryFn: async () => (await api<{ mailboxes: MailboxFolders[] }>('GET', `/email/orgs/${orgId}/folders`)).mailboxes,
})

export const pendingQuery = (orgId: string) => ({
  queryKey: ['agents', 'pending', orgId] as const,
  queryFn: async () => (await api<{ count: number }>('GET', `/agents/orgs/${orgId}/approvals/pending`)).count,
})

type Props = { open: boolean; section: Section; onClose: () => void; onPick: (s: Section) => void }

export function Drawer({ open, section, onClose, onPick }: Props) {
  const { user, org, domains } = useAccount()
  const picked = usePickedDomain()
  const [choosing, setChoosing] = useState(false)
  const insets = useSafeAreaInsets()
  const width = Math.min(320, useWindowDimensions().width * 0.78)
  const x = useState(() => new Animated.Value(0))[0]

  const folders = useQuery(foldersQuery(org.id))
  const pending = useQuery(pendingQuery(org.id))
  // The Email count follows the picked domain.
  const inDomain = picked.mailboxes && new Set(picked.mailboxes.map((m) => m.id))
  const unread = (folders.data ?? [])
    .filter((m) => !inDomain || inDomain.has(m.mailboxId))
    .reduce((n, m) => n + (m.folders.find((f) => f.role === 'inbox')?.unread ?? 0), 0)
  const badges: Partial<Record<Section, number>> = { email: unread, agents: pending.data ?? 0 }

  useEffect(() => {
    Animated.timing(x, { toValue: open ? 1 : 0, duration: 220, useNativeDriver: true }).start()
  }, [open, x])

  function close() {
    setChoosing(false)
    onClose()
  }

  function pickDomain(id: string | null) {
    setPrefs({ domainId: id })
    setChoosing(false)
  }

  async function logOut() {
    close()
    await signOut()
  }

  return (
    // Always mounted, so it can slide both ways; closed, it sits off-screen and lets touches through.
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'auto' : 'none'} accessibilityElementsHidden={!open} importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)', opacity: x }]}>
        <Pressable style={{ flex: 1 }} onPress={close} accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View
        style={[s.panel, { width, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12, transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-width, 0] }) }] }]}
      >
        <View style={s.account}>
          <Avatar text={initial(user.name ?? user.email)} size={30} />
          <Text numberOfLines={1} style={s.name}>
            {user.name ?? user.email}
          </Text>
          {org.plan ? <Text style={s.plan}>{org.plan.charAt(0).toUpperCase() + org.plan.slice(1)}</Text> : null}
        </View>

        {domains.length > 0 ? (
          <View style={{ marginBottom: 8 }}>
            <Pressable onPress={() => setChoosing((v) => !v)} accessibilityRole="button" accessibilityLabel="Switch domain" style={({ pressed }) => [s.switcher, pressed && { backgroundColor: c.raised }]}>
              <Globe color={c.muted} size={18} strokeWidth={1.75} />
              <Text numberOfLines={1} style={s.switcherText}>
                {picked.domain?.name ?? 'All domains'}
              </Text>
              {choosing ? <ChevronUp color={c.dim} size={18} strokeWidth={1.75} /> : <ChevronDown color={c.dim} size={18} strokeWidth={1.75} />}
            </Pressable>
            {choosing ? (
              <View style={s.domains}>
                {[{ id: null as string | null, name: 'All domains', pending: false }, ...domains.map((d) => ({ id: d.id as string | null, name: d.name, pending: d.status === 'pending' }))].map((d) => (
                  <Pressable key={d.id ?? 'all'} onPress={() => pickDomain(d.id)} style={({ pressed }) => [s.domain, pressed && { backgroundColor: c.card }]}>
                    <Text numberOfLines={1} style={s.domainText}>
                      {d.name}
                    </Text>
                    {d.pending ? <Text style={{ color: c.warn, fontSize: 13 }}>DNS pending</Text> : null}
                    {d.id === (picked.domain?.id ?? null) ? <Check color={c.text} size={18} strokeWidth={1.75} /> : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        <View style={{ flex: 1, gap: 2 }}>
          {SECTIONS.map(({ id, label, icon: Icon }) => {
            const active = id === section
            const badge = badges[id]
            return (
              <Pressable
                key={id}
                onPress={() => {
                  onPick(id)
                  close()
                }}
                style={({ pressed }) => [s.item, (active || pressed) && { backgroundColor: c.border }]}
              >
                <Icon color={active ? c.text : c.muted} size={20} strokeWidth={1.75} />
                <Text style={[s.itemText, !active && { color: c.soft }]}>{label}</Text>
                {badge ? <Text style={s.badge}>{badge}</Text> : null}
              </Pressable>
            )
          })}
        </View>

        <View style={s.bottom}>
          <Pressable
            onPress={() => {
              close()
              router.push('/settings')
            }}
            style={({ pressed }) => [s.item, pressed && { backgroundColor: c.border }]}
          >
            <Settings color={c.muted} size={20} strokeWidth={1.75} />
            <Text style={[s.itemText, { color: c.soft }]}>Settings</Text>
          </Pressable>
          <Pressable onPress={logOut} style={({ pressed }) => [s.item, pressed && { backgroundColor: c.border }]}>
            <LogOut color={c.muted} size={20} strokeWidth={1.75} />
            <Text style={[s.itemText, { color: c.soft }]}>Log out</Text>
          </Pressable>
        </View>
      </Animated.View>
    </View>
  )
}

const s = StyleSheet.create({
  panel: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: c.card, paddingHorizontal: 10 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 8, height: 48, marginBottom: 8 },
  switcher: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: c.borderStrong },
  switcherText: { color: c.text, fontSize: 16, flex: 1 },
  domains: { marginTop: 6, borderRadius: 10, backgroundColor: c.bg, overflow: 'hidden' },
  domain: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 46, paddingHorizontal: 14 },
  domainText: { color: c.text, fontSize: 16, flex: 1 },
  name: { color: c.text, fontSize: 17, fontWeight: '500', flex: 1 },
  plan: { color: c.dim, fontSize: 13 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, height: 46, paddingHorizontal: 12, borderRadius: 10 },
  itemText: { color: c.text, fontSize: 17, flex: 1 },
  badge: { color: c.dim, fontSize: 13 },
  bottom: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 8, gap: 2 },
})
