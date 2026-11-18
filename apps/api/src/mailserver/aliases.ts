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

  await requireSamePath(env, mailbox, domain)

  const localPart = normalizeLocalPart(alias.localPart)
  const address = `${localPart}@${domain.name}`
  await requireAddressFree(env, address)

  const before = await currentAliases(env, mailbox.id)
  if (onStalwart(mailbox)) await stalwart.setAliases(env, mailbox.stalwart_id, [...before, { localPart, domainId: domain.stalwart_id }])
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
    () => (onStalwart(mailbox) ? stalwart.setAliases(env, mailbox.stalwart_id, before) : Promise.resolve()),
  )
  return toMailbox((await mailboxesDb.find(env.DB, mailbox.id))!)
}

/**
 * Whether the mailbox's addresses live in Stalwart. A mailbox on the new mail system is reached through the addresses
 * table alone (mailbox/receive.ts), and its primary address can change, so its Stalwart account is left alone.
 */
const onStalwart = (mailbox: mailboxesDb.MailboxRow) => mailbox.backend !== 'store'

export async function removeAlias(env: EmailEnv, actor: Actor, mailboxId: string, address: string): Promise<Mailbox> {
  const { mailbox } = await mailboxContext(env, actor, mailboxId, 'manage')
  const row = await addressesDb.findOnMailbox(env.DB, mailbox.id, address.trim().toLowerCase())
  if (!row) throw notFound('alias')
  if (row.is_primary) throw new EmailError('primary_address', 'The primary address cannot be removed; delete the mailbox instead')

  const before = await currentAliases(env, mailbox.id)
  const after = await currentAliases(env, mailbox.id, row.id)
  if (onStalwart(mailbox)) await stalwart.setAliases(env, mailbox.stalwart_id, after)
  await withRollback(
    () => addressesDb.remove(env.DB, row.id).run(),
    () => (onStalwart(mailbox) ? stalwart.setAliases(env, mailbox.stalwart_id, before) : Promise.resolve()),
  )
  return toMailbox((await mailboxesDb.find(env.DB, mailbox.id))!)
}

/**
 * Puts the mailbox's aliases back into Stalwart, for a mailbox returning to it (domain-switch.ts rollbackSwitch):
 * aliases added while it was on the new mail system were never written there.
 */
export async function resyncStalwartAliases(env: EmailEnv, mailboxId: string, stalwartId: string): Promise<void> {
  await stalwart.setAliases(env, stalwartId, await currentAliases(env, mailboxId))
}

/** The mailbox's aliases as Stalwart expects them, optionally leaving one out. */
async function currentAliases(env: EmailEnv, mailboxId: string, excludeAddressId?: string): Promise<stalwart.Alias[]> {
  const rows = await addressesDb.listAliases(env.DB, mailboxId)
  return rows
    .filter((a) => a.id !== excludeAddressId)
    .map((a) => ({ localPart: a.local_part, domainId: a.domain_stalwart_id }))
}

/**
 * An alias must be on a domain whose mail lives where the mailbox's own domain's mail lives (phase 4b). Otherwise a
 * domain would have mailboxes in both Stalwart and the mailbox store: Stalwart's routing rule then can't cover it,
 * and mail between the two would be delivered to the wrong place. Domains move whole.
 */
async function requireSamePath(env: EmailEnv, mailbox: mailboxesDb.MailboxRow, domain: domainsDb.DomainRow): Promise<void> {
  const own = await domainsDb.find(env.DB, mailbox.domain_id)
  const path = own?.mail_path ?? 'stalwart'
  if (path === domain.mail_path) return
  const where = (p: string) => (p === 'store' ? 'the new mail system' : p === 'switching' ? 'a domain being moved' : 'the current mail server')
  throw new EmailError(
    'domain_mail_path_differs',
    `${domain.name} is on ${where(domain.mail_path)} and this mailbox's domain is on ${where(path)}. Aliases must stay on domains handled the same way.`,
    409,
  )
}
