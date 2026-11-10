// The signed-in session. The token is kept in the device keychain (expo-secure-store) and mirrored in memory,
// so API calls don't wait on the keychain.

import * as SecureStore from 'expo-secure-store'
import { useSyncExternalStore } from 'react'

export type Session = { token: string; expiresAt: string }

const KEY = 'xstate.session'
type State = { ready: boolean; session: Session | null }

let state: State = { ready: false, session: null }
const listeners = new Set<() => void>()

function set(next: State) {
  state = next
  listeners.forEach((fn) => fn())
}

const valid = (s: Session | null): Session | null => (s && Date.parse(s.expiresAt) > Date.now() ? s : null)

/** Reads the stored session once, when the app starts. */
export async function loadSession(): Promise<void> {
  let stored: Session | null = null
  try {
    stored = JSON.parse((await SecureStore.getItemAsync(KEY)) ?? 'null') as Session | null
  } catch {
    // An unreadable keychain entry is the same as being signed out.
  }
  set({ ready: true, session: valid(stored) })
}

export async function saveSession(s: Session): Promise<void> {
  const session = { token: s.token, expiresAt: s.expiresAt }
  set({ ready: true, session })
  await SecureStore.setItemAsync(KEY, JSON.stringify(session)).catch(() => undefined)
}

export async function clearSession(): Promise<void> {
  set({ ready: true, session: null })
  await SecureStore.deleteItemAsync(KEY).catch(() => undefined)
}

export const currentSession = () => valid(state.session)

export function useSession(): State {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => state,
  )
}
