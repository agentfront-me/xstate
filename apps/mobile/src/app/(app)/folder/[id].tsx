import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams } from 'expo-router'
import { RefreshControl, ScrollView } from 'react-native'
import { api, errorMessage } from '@/lib/api'
import type { StorageItem } from '@/lib/types'
import { Items } from '@/sections/Storage'
import { BackButton, Failed, Header, Loading, Screen } from '@/ui/kit'
import { c } from '@/ui/theme'

export default function FolderScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>()
  const folder = useQuery({
    queryKey: ['storage', 'folder', id],
    queryFn: () => api<{ folder: StorageItem; items: StorageItem[] }>('GET', `/storage/folders/${encodeURIComponent(id)}`),
  })

  return (
    <Screen>
      <Header title={folder.data?.folder.name ?? name ?? ''} left={<BackButton />} />
      {folder.isPending ? (
        <Loading />
      ) : folder.isError ? (
        <Failed message={errorMessage(folder.error)} onRetry={() => void folder.refetch()} />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingTop: 8, paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={folder.isRefetching} onRefresh={() => void folder.refetch()} tintColor={c.dim} />}
        >
          <Items items={folder.data.items} />
        </ScrollView>
      )}
    </Screen>
  )
}
