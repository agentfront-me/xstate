// Choices kept on this device: the domain picked in the side menu and the notification switches.

import * as SecureStore from 'expo-secure-store'
import { useSyncExternalStore } from 'react'
import { useAccount } from './account'
import type { Domain, Mailbox } from './types'

export type Notify = { email: boolean; approvals: boolean; agentErrors: boolean }
export type Prefs = { domainId: string | null; notify: Notify }

const KEY = 'xstate.prefs'
let prefs: Prefs = { domainId: null, notify: { email: true, approvals: true, agentErrors: true } }
const listeners = new Set<() => void>()

function set(next: Prefs) {
  prefs = next
  listeners.forEach((fn) => fn())
}

// Read once at startup. Until it lands the defaults show, which is "All domains" and every switch on.
void SecureStore.getItemAsync(KEY)
  .then((raw) => {
    const stored = JSON.parse(raw ?? 'null') as Partial<Prefs> | null
    if (stored) set({ domainId: stored.domainId ?? null, notify: { ...prefs.notify, ...stored.notify } })
  })
  .catch(() => undefined)

export function setPrefs(change: Partial<Prefs>) {
  set({ ...prefs, ...change })
  void SecureStore.setItemAsync(KEY, JSON.stringify(prefs)).catch(() => undefined)
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => prefs,
  )
}

/** The domain picked in the side menu (null is all domains) and the mailboxes on it. */
export function usePickedDomain(): { domain: Domain | null; mailboxes: Mailbox[] | null } {
  const { domains, mailboxes } = useAccount()
  const { domainId } = usePrefs()
  // A domain removed since it was picked falls back to all domains.
  const domain = domains.find((d) => d.id === domainId) ?? null
  return { domain, mailboxes: domain ? mailboxes.filter((m) => m.domainId === domain.id) : null }
}
