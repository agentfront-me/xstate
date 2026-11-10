import { z } from 'zod'
import * as devices from '../db/devices'
import * as domainsDb from '../db/domains'
import { loadMember } from '../mailserver/access'
import { defineOperation } from './define'

const token = z.string().regex(/^Expo(nent)?PushToken\[[^\]]{1,200}\]$/, 'Not an Expo push token')

const view = (d: devices.DeviceRow) => ({
  id: d.id,
  platform: d.platform,
  notify: { email: !!d.notify_email, approvals: !!d.notify_approvals, agentErrors: !!d.notify_agent_errors },
  domainId: d.domain_id,
})

export const devicesRegister = defineOperation({
  name: 'devices_register',
  description:
    "Registers the mobile app on this phone for push notifications, or updates what it wants: new email (optionally one domain's only), agent approvals and agent errors. Called by the app after sign-in and whenever a notification switch changes.",
  input: z.object({
    token,
    platform: z.enum(['ios', 'android']),
    notify: z.object({ email: z.boolean(), approvals: z.boolean(), agentErrors: z.boolean() }),
    domainId: z.string().min(1).max(64).nullish(),
  }),
  http: { method: 'PUT', path: '/devices' },
  mcp: false,
  run: async ({ env, actor }, input) => {
    let domainId: string | null = null
    if (input.domainId) {
      // Only a domain of an organization the person belongs to; anything else falls back to all domains.
      const domain = await domainsDb.find(env.DB, input.domainId)
      if (domain && (await loadMember(env, domain.organization_id, actor.userId).catch(() => null))) domainId = domain.id
    }
    return { device: view(await devices.upsert(env.DB, { userId: actor.userId, token: input.token, platform: input.platform, ...input.notify, domainId })) }
  },
})

export const devicesRemove = defineOperation({
  name: 'devices_remove',
  description: 'Stops push notifications to this phone. Called by the app when signing out.',
  input: z.object({ token }),
  http: { method: 'POST', path: '/devices/remove' },
  mcp: false,
  run: async ({ env, actor }, input) => {
    await devices.removeForUser(env.DB, actor.userId, input.token)
  },
})

export const deviceOperations = [devicesRegister, devicesRemove]
