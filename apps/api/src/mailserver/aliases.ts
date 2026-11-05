import * as addressesDb from '../db/addresses'
import * as domainsDb from '../db/domains'
import * as mailboxesDb from '../db/mailboxes'
import { domainAccess, mailboxContext, requireAddressFree } from './access'
import { EmailError, forbidden, notFound, withRollback } from './errors'
import * as stalwart from './stalwart/accounts'
import { toMailbox, type Actor, type EmailEnv, type Mailbox } from './types'
import { normalizeLocalPart } from './validation'

/** Adds an extra address to a mailbox. It can be on any domain of the organization the actor manages. */
export async function addAlias(
  env: EmailEnv,
  actor: Actor,
  mailboxId: string,
  alias: { localPart: string; domainId: string },
): Promise<Mailbox> {
  const { mailbox, member } = await mailboxContext(env, actor, mailboxId, 'manage')
  const domain = await domainsDb.find(env.DB, alias.domainId)
  if (!domain || domain.organization_id !== mailbox.organization_id) throw notFound('domain')
  if (domainAccess(member, domain.id) !== 'manage') throw forbidden(`You can't manage ${domain.name}`)

  const localPart = normalizeLocalPart(alias.localPart)
  const address = `${localPart}@${domain.name}`
  await requireAddressFree(env, address)

  const before = await currentAliases(env, mailbox.id)
  await stalwart.setAliases(env, mailbox.stalwart_id, [...before, { localPart, domainId: domain.stalwart_id }])
  await withRollback(
    () =>
      addressesDb
        .insert(env.DB, {
          organizationId: mailbox.organization_id,
          mailboxId: mailbox.id,
          domainId: domain.id,
          localPart,
          address,
          isPrimary: false,
          now: new Date().toISOString(),
        })
        .run(),
    () => stalwart.setAliases(env, mailbox.stalwart_id, before),
  )
  return toMailbox((await mailboxesDb.find(env.DB, mailbox.id))!)
}

export async function removeAlias(env: EmailEnv, actor: Actor, mailboxId: string, address: string): Promise<Mailbox> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'manage')
  const row = await addressesDb.findOnMailbox(env.DB, mailbox.id, address.trim().toLowerCase())
  if (!row) throw notFound('alias')
  if (row.is_primary) throw new EmailError('primary_address', 'The primary address cannot be removed; delete the mailbox instead')

  const before = await currentAliases(env, mailbox.id)
  const after = await currentAliases(env, mailbox.id, row.id)
  await stalwart.setAliases(env, mailbox.stalwart_id, after)
  await withRollback(
    () => addressesDb.remove(env.DB, row.id).run(),
    () => stalwart.setAliases(env, mailbox.stalwart_id, before),
  )
  return toMailbox((await mailboxesDb.find(env.DB, mailbox.id))!)
}

/** The mailbox's aliases as Stalwart expects them, optionally leaving one out. */
async function currentAliases(env: EmailEnv, mailboxId: string, excludeAddressId?: string): Promise<stalwart.Alias[]> {
  const rows = await addressesDb.listAliases(env.DB, mailboxId)
  return rows
    .filter((a) => a.id !== excludeAddressId)
    .map((a) => ({ localPart: a.local_part, domainId: a.domain_stalwart_id }))
}
