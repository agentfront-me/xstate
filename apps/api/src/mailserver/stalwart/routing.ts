// Keeps Stalwart's routing rule for store-held domains in step with D1 (./routing-rule.ts; docs/mailbox-store-plan.md,
// "Mail from Stalwart mailboxes to store-held ones"). Run by the hourly job: when the domains on Stalwart's rule
// differ from D1's, both expressions are rewritten and Stalwart reloads its settings. Nothing is written otherwise.

import * as domainsDb from '../../db/domains'
import { jmap, type StalwartEnv } from './client'
import { storeRuleDomains, withStoreRule, type StalwartExpression } from './routing-rule'

export type RoutingSync = { domains: string[]; changed: boolean; mixed: string[]; before: string[] }

export async function syncStoreRouting(env: StalwartEnv & { DB: D1Database }): Promise<RoutingSync> {
  const { held, mixed } = await domainsDb.storeHeldNames(env.DB)
  if (mixed.length) console.error('stalwart-routing: domains with mailboxes on both sides keep local delivery', JSON.stringify(mixed))
  const [got] = await jmap(env, [['x:MtaOutboundStrategy/get', { ids: ['singleton'], properties: ['route', 'schedule'] }]])
  const strategy = (got?.list as { route: StalwartExpression; schedule: StalwartExpression }[] | undefined)?.[0]
  if (!strategy) throw new Error('stalwart-routing: no outbound strategy on the mail server')

  const want = [...held].map((d) => d.toLowerCase()).sort()
  const before = storeRuleDomains(strategy.route)
  const inStep = JSON.stringify(before) === JSON.stringify(want) && JSON.stringify(storeRuleDomains(strategy.schedule)) === JSON.stringify(want)
  if (inStep) return { domains: want, changed: false, mixed, before }

  await jmap(env, [
    ['x:MtaOutboundStrategy/set', { update: { singleton: { route: withStoreRule(strategy.route, want), schedule: withStoreRule(strategy.schedule, want) } } }],
    ['x:Action/set', { create: { r: { '@type': 'ReloadSettings' } } }],
  ])
  console.log('stalwart-routing', JSON.stringify({ before, after: want, previous: { route: strategy.route, schedule: strategy.schedule } }))
  return { domains: want, changed: true, mixed, before }
}
