// Requests to the Email page from outside it (⌘K search, the desktop app's New mail menu). They're kept until the
// Email page takes them, so they survive the navigation to #/mail that usually comes first.

import { useEffect, useSyncExternalStore } from 'react'

type Intent = 'compose' | 'search'
let pending: Intent | null = null
const listeners = new Set<() => void>()

export function requestMail(intent: Intent): void {
  pending = intent
  listeners.forEach((fn) => fn())
}

/** Calls `handle` with each request, once, while the calling component is mounted. */
export function useMailIntent(handle: (intent: Intent) => void): void {
  const intent = useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => pending,
  )
  useEffect(() => {
    if (!intent) return
    pending = null
    handle(intent)
  }, [intent, handle])
}
