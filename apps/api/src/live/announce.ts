// Telling the organization's live hub (live/hub.ts) that something changed. Never fails the caller: a missed event
// only means the app shows the change when it next reloads, as it did before live updates.

import type { LiveEvent } from './hub'

export async function announce(env: Pick<Env, 'LIVE'>, organizationId: string, event: LiveEvent, userIds?: string[]): Promise<void> {
  try {
    await env.LIVE.get(env.LIVE.idFromName(organizationId)).announce(event, userIds)
  } catch (err) {
    console.warn('live: announce failed', JSON.stringify(event), err)
  }
}
