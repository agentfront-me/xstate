// The domain picked in the rail's header. Email, Agents and Users show only what belongs to it; null is all domains.
// Remembered per browser. A remembered domain the organization no longer has reads as all domains.

import { useSyncExternalStore } from 'react'
import { useAccount } from './account'
import type { Domain, Mailbox } from './types'

const KEY = 'xstate.domain-scope'
const listeners = new Set<() => void>()

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

let current = read()

export function setDomainScope(domainId: string | null): void {
  current = domainId
  try {
    if (domainId) localStorage.setItem(KEY, domainId)
    else localStorage.removeItem(KEY)
  } catch {
    // Not remembered.
  }
  listeners.forEach((fn) => fn())
}

/** The domain in scope, or null for all domains. */
export function useDomainScope(): Domain | null {
  const id = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
  )
  const account = useAccount()
  return (id && account.domains.find((d) => d.id === id)) || null
}

/** The organization's mailboxes on the domain in scope (all of them when no domain is picked). */
export function useScopedMailboxes(): Mailbox[] {
  const account = useAccount()
  const scope = useDomainScope()
  return scope ? account.mailboxes.filter((m) => m.domainId === scope.id) : account.mailboxes
}

/** Whether an address is on the domain in scope (always, when no domain is picked). */
export const inDomain = (address: string, scope: Domain | null) => !scope || address.split('@')[1]?.toLowerCase() === scope.name.toLowerCase()
