// Members, Secrets, Billing and Integrations have no API yet: they're sample data kept in memory here, so edits
// survive switching sections. Members are only filled in demo mode; signed in, the team is just you for now.

import { useSyncExternalStore } from 'react'
import { isDemo } from '../lib/account'
import * as sample from '../lib/sample'
import type { Billing, Integration, Member, Secret } from '../lib/sample'

export type SettingsData = {
  members: Member[]
  secrets: Secret[]
  billing: Billing
  integrations: Integration[]
}

let data: SettingsData = {
  members: isDemo() ? sample.sampleMembers.map((m) => ({ ...m })) : [],
  secrets: sample.sampleSecrets.map((s) => ({ ...s })),
  billing: sample.sampleBilling,
  integrations: sample.sampleIntegrations.map((i) => ({ ...i })),
}

const listeners = new Set<() => void>()

export function setSettings(fn: (d: SettingsData) => SettingsData): void {
  data = fn(data)
  listeners.forEach((l) => l())
}

export function useSettingsData(): SettingsData {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => data,
  )
}
