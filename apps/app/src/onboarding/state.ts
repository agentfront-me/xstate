// What onboarding knows about the signed-in person, the steps, and the progress kept in localStorage (choices
// the API doesn't store yet: skipping verification, finishing step 5, the chosen agent).

import { PROGRESS_KEY, readJson, writeJson } from '../lib/core'
import type { Domain, Mailbox, Org, User } from '../lib/types'

export const MCP_URL = 'https://mcp.xstate.com/sse'
export const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
export const POLL_MS = 5000

export type Provider = { id?: string; name?: string }

export type Data = {
  user: User
  org: Org
  domain: Domain | null
  mailboxes: Mailbox[]
  /** The DNS provider found by the domain check in this visit. */
  provider?: Provider | null
}

export type Screen = 'loading' | 'account' | 'login' | 'domain' | 'verify' | 'addresses' | 'agent' | 'done' | 'error'

export const STEP_LABELS: Record<Screen, string> = {
  loading: '',
  account: '1 of 5',
  login: '',
  domain: '2 of 5',
  verify: '3 of 5',
  addresses: '4 of 5',
  agent: '5 of 5',
  done: 'Done',
  error: '',
}

export type Progress = {
  provider?: Provider & { domainId: string }
  skippedVerify?: string
  finished?: boolean
  agent?: { id: string; addresses: string[]; access: string }
}

export const progress = (): Progress => readJson<Progress>(PROGRESS_KEY) ?? {}

export function setProgress(changes: Progress): void {
  writeJson(PROGRESS_KEY, { ...progress(), ...changes })
}

export const domainName = (data: Data | null) => data?.domain?.name ?? 'yourbusiness.com'

/**
 * Back from Domain Connect: the DNS provider redirects to /signup?state=<domain id>, with error=… if it failed or
 * the person cancelled. Remembered for the verify step, and the address bar is tidied.
 */
export type ConnectReturn = { state: string; error: string | null }
export let connectReturn: ConnectReturn | null = null

export function readConnectReturn(): void {
  const params = new URLSearchParams(location.search)
  if (!params.has('state')) return
  connectReturn = { state: params.get('state') ?? '', error: params.get('error') }
  history.replaceState(null, '', location.pathname)
}

export function clearConnectReturn(): void {
  connectReturn = null
}
