// Storage: the organization's files and your own, by folder, and how much space is used.

import { useQuery } from '@tanstack/react-query'
import { router } from 'expo-router'
import { ChevronRight, File, Folder, Menu } from 'lucide-react-native'
import { RefreshControl, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAccount } from '@/lib/account'
import { api, errorMessage } from '@/lib/api'
import { formatSize, relative } from '@/lib/format'
import type { StorageItem, Usage } from '@/lib/types'
import { Card, Empty, Failed, Header, IconButton, Loading, Row, SectionLabel } from '@/ui/kit'
import { c } from '@/ui/theme'

const itemsQuery = (orgId: string, view: 'organization' | 'personal') => ({
  queryKey: ['storage', 'items', orgId, view] as const,
  queryFn: async () => (await api<{ items: StorageItem[] }>('GET', `/storage/orgs/${orgId}/items?view=${view}`)).items,
})

export function Storage({ onMenu }: { onMenu: () => void }) {
  const { org } = useAccount()
  const insets = useSafeAreaInsets()
  const shared = useQuery(itemsQuery(org.id, 'organization'))
  const personal = useQuery(itemsQuery(org.id, 'personal'))
  const usage = useQuery({ queryKey: ['storage', 'usage', org.id], queryFn: () => api<Usage>('GET', `/storage/orgs/${org.id}/usage`) })

  const refetch = () => void Promise.all([shared.refetch(), personal.refetch(), usage.refetch()])
  const error = shared.error ?? personal.error
  const u = usage.data

  return (
    <View style={{ flex: 1 }}>
      <Header title="Storage" left={<IconButton icon={Menu} label="Menu" onPress={onMenu} />} />
      {shared.isPending || personal.isPending ? (
        <Loading />
      ) : error ? (
        <Failed message={errorMessage(error)} onRetry={refetch} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          refreshControl={<RefreshControl refreshing={shared.isRefetching || personal.isRefetching} onRefresh={refetch} tintColor={c.dim} />}
        >
          <SectionLabel>{org.name}</SectionLabel>
          <Items items={shared.data ?? []} />
          <SectionLabel>My files</SectionLabel>
          <Items items={personal.data ?? []} />
          {u ? (
            <>
              <SectionLabel>Used</SectionLabel>
              <Card>
                <UsageRow label={org.name} bytes={u.organization.bytes} files={u.organization.files} />
                <UsageRow label="My files" bytes={u.personal.bytes} files={u.personal.files} />
                <UsageRow label="Email attachments" bytes={u.attachments.bytes} files={u.attachments.files} />
              </Card>
            </>
          ) : null}
        </ScrollView>
      )}
    </View>
  )
}

const UsageRow = ({ label, bytes, files }: { label: string; bytes: number; files: number }) => (
  <Row>
    <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontSize: 16 }}>
      {label}
    </Text>
    <Text style={{ color: c.dim, fontSize: 14 }}>
      {formatSize(bytes)} · {files.toLocaleString()} {files === 1 ? 'file' : 'files'}
    </Text>
  </Row>
)

/** Folders first, then files. Folders open; files show their size and when they changed. */
export function Items({ items }: { items: StorageItem[] }) {
  if (!items.length) return <Empty>Nothing here.</Empty>
  const sorted = [...items].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1))
  return (
    <Card>
      {sorted.map((item) =>
        item.kind === 'folder' ? (
          <Row key={item.id} onPress={() => router.push({ pathname: '/folder/[id]', params: { id: item.id, name: item.name } })}>
            <Folder color={c.muted} size={20} strokeWidth={1.75} />
            <Text numberOfLines={1} style={{ flex: 1, color: c.text, fontSize: 16 }}>
              {item.name}
            </Text>
            <ChevronRight color={c.faint} size={18} strokeWidth={1.75} />
          </Row>
        ) : (
          <Row key={item.id}>
            <File color={c.muted} size={20} strokeWidth={1.75} />
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ color: c.text, fontSize: 16 }}>
                {item.name}
              </Text>
              <Text style={{ color: c.dim, fontSize: 13, marginTop: 2 }}>{relative(item.updatedAt)}</Text>
            </View>
            <Text style={{ color: c.dim, fontSize: 14 }}>{formatSize(item.size)}</Text>
          </Row>
        ),
      )}
    </Card>
  )
}
