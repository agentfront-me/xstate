import { CircleAlert, CircleCheck, CircleDashed, CircleX, Clock, type LucideIcon } from 'lucide-react-native'
import type { RunStatus } from '@/lib/types'
import { c } from '@/ui/theme'

export const RUN_STATUS: Record<RunStatus, { label: string; icon: LucideIcon; color: string }> = {
  running: { label: 'Running', icon: CircleDashed, color: c.muted },
  waiting_for_approval: { label: 'Waiting for approval', icon: Clock, color: c.warn },
  done: { label: 'Done', icon: CircleCheck, color: c.muted },
  failed: { label: 'Failed', icon: CircleX, color: c.danger },
  max_steps: { label: 'Hit step limit', icon: CircleAlert, color: c.warn },
  skipped: { label: 'Skipped', icon: CircleDashed, color: c.faint },
}
