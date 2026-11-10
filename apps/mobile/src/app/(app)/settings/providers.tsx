// The organization's AI provider keys and whether each still works. View only; owners and admins.

import { useQuery } from '@tanstack/react-query'
import { Sparkles } from 'lucide-react-native'
import { useAccount } from '@/lib/account'
import type { ProviderId } from '@/lib/types'
import { ListScreen, providersQuery, providerState } from '@/sections/workspace'
import { c } from '@/ui/theme'

const PROVIDERS: { id: ProviderId; name: string }[] = [
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'openai', name: 'OpenAI' },
]

export default function ProvidersScreen() {
  const { org } = useAccount()
  const providers = useQuery(providersQuery(org.id))
  return (
    <ListScreen
      title="AI providers"
      items={
        providers.data &&
        PROVIDERS.map(({ id, name }) => {
          const saved = providers.data.find((p) => p.provider === id)
          const icon = <Sparkles color={c.muted} size={20} strokeWidth={1.75} />
          if (!saved) return { id, icon, title: name, sub: 'No key', value: 'Off' }
          const used = saved.usedBy === 0 ? 'Not used by any agent' : `Used by ${saved.usedBy} ${saved.usedBy === 1 ? 'agent' : 'agents'}`
          return { id, icon, title: name, sub: used, value: providerState(saved).label, color: providerState(saved).color }
        })
      }
      note="Add or rotate keys on desktop."
      empty="No providers."
      error={providers.error}
      refreshing={providers.isRefetching}
      onRefresh={() => void providers.refetch()}
    />
  )
}
