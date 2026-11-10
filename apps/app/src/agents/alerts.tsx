// Approvals waiting anywhere in the organization: the count on the rail's Agents item, and a desktop notification
// when new ones arrive (desktop app only, when notifications are on and the window isn't focused, like new mail).

import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { isDemo, useAccount } from '../lib/account'
import { desktop } from '../lib/core'
import { agentKeys, agentsApi } from './api'

const POLL_MS = 60_000

/** Pending approvals the signed-in person can see (0 for people who don't manage agents). */
export function usePendingApprovals(): number {
  const account = useAccount()
  const orgId = account.mode === 'live' && !isDemo() ? account.org.id : null
  const query = useQuery({
    queryKey: agentKeys.pending(orgId ?? ''),
    queryFn: () => agentsApi.pending(orgId!),
    enabled: !!orgId,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    retry: false,
  })
  return query.data?.count ?? 0
}

/** Mounted once in the shell: notifies when the pending count goes up. */
export function ApprovalAlerts() {
  const count = usePendingApprovals()
  const last = useRef<number | null>(null)
  useEffect(() => {
    const before = last.current
    last.current = count
    if (before !== null && count > before) void notify(count - before)
  }, [count])
  return null
}

async function notify(added: number) {
  if (!desktop || !('Notification' in window)) return
  const settings = await desktop.getSettings().catch(() => ({}) as Record<string, boolean>)
  if (!settings.notifications || document.hasFocus()) return
  const n = new Notification('xstate', { body: added === 1 ? 'An agent needs your approval.' : `${added} agent actions need your approval.` })
  n.onclick = () => {
    window.focus()
    window.location.hash = '#/agents'
  }
}
