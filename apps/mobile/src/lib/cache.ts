// What's loaded is also kept on the phone (SQLite, through expo-sqlite's key-value store), so opening the app shows
// the inbox and the rest straight away, even after it was closed, and then refreshes them quietly.
//
// Kept: the account and the lists (inbox, folders, agents and their approvals, users, storage), only the first page
// of a long one, for up to a week. Not kept: single emails, runs or people (those load when opened), and anything that
// failed or is still loading. Signing out, or the session running out, wipes it. A new app version starts empty, so
// an old saved shape never meets new code.

import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import type { PersistQueryClientOptions } from '@tanstack/react-query-persist-client'
import Constants from 'expo-constants'
import { queryClient } from './account'
import { onSessionChange } from './session'

const KEPT = new Set(['account', 'mail/list', 'mail/folders', 'agents/list', 'agents/pending', 'agents/approvals', 'audience/overview', 'audience/people', 'storage/folder', 'storage/items', 'storage/usage'])
const kept = (key: readonly unknown[]) => KEPT.has(String(key[0])) || KEPT.has(`${String(key[0])}/${String(key[1])}`)
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

type Infinite = { pages: unknown[]; pageParams: unknown[] }
const isInfinite = (data: unknown): data is Infinite =>
  !!data && typeof data === 'object' && Array.isArray((data as Infinite).pages) && Array.isArray((data as Infinite).pageParams)

// expo-sqlite is native: a build made before it was added has no such module, and importing it would throw. There
// nothing is kept (a persister without storage does nothing) and the app works as before.
type KvStore = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> }
let storage: KvStore | undefined
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  storage = (require('expo-sqlite/kv-store') as { default: KvStore }).default
} catch {
  storage = undefined
}

const persister = createAsyncStoragePersister({
  storage,
  key: 'xstate.cache',
  throttleTime: 2000,
  // A list scrolled a long way keeps only its first page; the rest loads again when scrolled to.
  serialize: (client) => {
    for (const q of client.clientState.queries) {
      const data = q.state.data
      if (isInfinite(data) && data.pages.length > 1) q.state.data = { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
    }
    return JSON.stringify(client)
  },
})

export const persistOptions: Omit<PersistQueryClientOptions, 'queryClient'> = {
  persister,
  maxAge: WEEK_MS,
  buster: String(Constants.expoConfig?.version ?? ''),
  dehydrateOptions: {
    shouldDehydrateQuery: (q) => q.state.status === 'success' && kept(q.queryKey),
  },
}

/** After the saved lists are back on screen: reload whatever is showing, quietly. */
export function refreshRestored() {
  void queryClient.invalidateQueries()
}

// Signed out (or the session ran out): nothing of this account stays on the phone.
onSessionChange((session) => {
  if (session) return
  queryClient.clear()
  void persister.removeClient()
})
