// Moving a domain's mail from Stalwart to the mailbox store (docs/mailbox-store-plan.md, phase 4d). Owners only,
// not on MCP. The order matters: `start` (the domain is `switching`: SES mail for it is handed to Stalwart, see
// mailbox/receive.ts), the MX record moves to SES, then `flip` once public DNS shows only SES's MX. `rollback` goes
// back within 30 days; `cancel` ends a switch whose MX still points at Stalwart. Every step of a flip is recorded on
// the switch, and a flip that stopped can be called again: each step is safe to repeat.

import * as addressesDb from '../db/addresses'
import * as domainsDb from '../db/domains'
import * as switchesDb from '../db/domain-switches'
import type { DomainSwitchRow, SwitchStep } from '../db/domain-switches'
import * as mailboxesDb from '../db/mailboxes'
import type { MailboxRow } from '../db/mailboxes'
import * as usersDb from '../db/users'
import { ensureCopied } from '../mailbox/calendar-store'
import { checkStore, syncStore, type ShadowEnv } from '../mailbox/shadow'
import { sweepHeld } from '../mailbox/stalwart-sweep'
import { store } from '../mailbox/stub'
import { organizationBucket, storageConfigured } from '../storage/buckets'
import { getObject } from '../storage/r2'
import { domainContext } from './access'
import { isTestDomain, mxHosts } from './dns'
import { EmailError, forbidden } from './errors'
import * as accounts from './stalwart/accounts'
import * as stalwartMail from './stalwart/mail'
import { syncStoreRouting } from './stalwart/routing'
import { onlySesMx, readiness, type Check, type MailboxFacts } from './switch-rules'
import { sendSystemEmail } from './system-mail'
import type { Actor } from './types'

type SwitchEnv = Env

/** A switch can be rolled back this long after its flip. */
const ROLLBACK_DAYS = 30

export type SwitchStatus = {
  domain: { id: string; name: string; mailPath: 'stalwart' | 'switching' | 'store' }
  switch: { id: string; state: string; startedAt: string; mxSeenAt: string | null; flippedAt: string | null; endedAt: string | null; steps: SwitchStep[] } | null
  dns: { mx: string[]; onlySes: boolean }
  ready: boolean
  checks: Check[]
  next: string
}

export async function switchStatus(env: SwitchEnv, actor: Actor, domainId: string): Promise<SwitchStatus> {
  const { domain } = await ownerContext(env, actor, domainId)
  const [mailboxes, latest, dns] = await Promise.all([mailboxesOn(env, domainId), switchesDb.latest(env.DB, domainId), dnsOf(env, domain.name)])
  const facts = await Promise.all(mailboxes.map((m) => factsOf(env, m, domainId)))
  const { ready, checks } = readiness({ sending: domain.ses_status }, facts)
  return {
    domain: { id: domain.id, name: domain.name, mailPath: domain.mail_path },
    switch: latest ? view(latest) : null,
    dns,
    ready,
    checks,
    next: nextStep(domain.mail_path, latest, ready, dns.onlySes),
  }
}

/** The domain goes into `switching`: from now on SES mail for it is handed to Stalwart until the flip. */
export async function startSwitch(env: SwitchEnv, actor: Actor, domainId: string): Promise<SwitchStatus> {
  const { domain } = await ownerContext(env, actor, domainId)
  if (domain.mail_path !== 'stalwart') throw new EmailError('switch_state', `${domain.name} is already ${domain.mail_path}`, 409)
  const facts = await Promise.all((await mailboxesOn(env, domainId)).map((m) => factsOf(env, m, domainId)))
  const { ready, checks } = readiness({ sending: domain.ses_status }, facts)
  if (!ready) throw new EmailError('switch_not_ready', `Not ready: ${checks.filter((c) => !c.ok).map((c) => `${c.check} (${c.detail})`).join('; ')}`, 409)
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await env.DB.batch([
    switchesDb.insert(env.DB, { id, domainId, startedBy: actor.userId, now }),
    switchesDb.setMailPath(env.DB, domainId, 'switching', now),
    switchesDb.addStep(env.DB, id, { step: 'start', at: now, ok: true }),
  ])
  console.log('domain-switch', JSON.stringify({ domain: domain.name, step: 'start' }))
  return switchStatus(env, actor, domainId)
}

/**
 * The flip: once public DNS shows only SES's MX. Each mailbox's store takes over its mail (after a last shadow sync),
 * the mailboxes and the domain move to the store, calendars are copied, Stalwart's routing rule and the sweep run
 * now, and the old Stalwart accounts stop sending and lose their passwords. Every step is recorded; calling it
 * again after a failure carries on.
 */
export async function flipSwitch(env: SwitchEnv, actor: Actor, domainId: string): Promise<SwitchStatus> {
  const { domain } = await ownerContext(env, actor, domainId)
  const sw = await switchesDb.latest(env.DB, domainId)
  if (!sw || (sw.state !== 'switching' && sw.state !== 'flipped')) throw new EmailError('switch_state', `${domain.name} isn't being switched`, 409)
  const step = (name: string) => async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      const detail = await run()
      await switchesDb.addStep(env.DB, sw.id, { step: name, at: new Date().toISOString(), ok: true, detail }).run()
      return detail
    } catch (err) {
      await switchesDb.addStep(env.DB, sw.id, { step: name, at: new Date().toISOString(), ok: false, detail: err instanceof Error ? err.message : String(err) }).run()
      throw err
    }
  }
  const mailboxes = await mailboxesOn(env, domainId)

  if (sw.state === 'switching') {
    await step('checks')(async () => {
      const dns = await dnsOf(env, domain.name)
      if (!dns.onlySes) throw new EmailError('switch_dns', `Public DNS still shows ${dns.mx.join(', ') || 'no MX'} for ${domain.name}; it must show only Amazon SES`, 409)
      const facts = await Promise.all(mailboxes.map((m) => factsOf(env, m, domainId)))
      const { ready, checks } = readiness({ sending: domain.ses_status }, facts)
      if (!ready) throw new EmailError('switch_not_ready', `Not ready: ${checks.filter((c) => !c.ok).map((c) => c.check).join('; ')}`, 409)
      return { mx: dns.mx }
    })
    for (const m of mailboxes) {
      if (m.backend === 'store') continue
      await step(`own:${m.address}`)(async () => {
        const synced = await syncStore(env as ShadowEnv, m.id)
        // The sweep starts a day back: a message the last sync only queued for copying (copy jobs stop once the
        // mailbox is on the store) is brought in by it; Message-IDs keep anything from arriving twice.
        const sweptFrom = new Date(Date.now() - 86_400_000).toISOString()
        return { synced: synced ? { stored: synced.stored, placed: synced.placed, removed: synced.removed } : null, ...(await (await store(env, m.id)).takeOwnership(sweptFrom)) }
      })
    }
    await step('move')(async () => {
      const now = new Date().toISOString()
      await env.DB.batch([
        ...mailboxes.map((m) => env.DB.prepare("UPDATE mailboxes SET backend = 'store', updated_at = ? WHERE id = ?").bind(now, m.id)),
        switchesDb.setMailPath(env.DB, domainId, 'store', now),
        switchesDb.setState(env.DB, sw.id, 'flipped', { flippedAt: now }),
      ])
      return { mailboxes: mailboxes.length }
    })
  }

  const moved = await mailboxesOn(env, domainId)
  await step('calendars')(async () => {
    const copied: Record<string, unknown> = {}
    for (const m of moved) copied[m.address] = await ensureCopied(env, m)
    return copied
  })
  await step('routing')(() => syncStoreRouting(env))
  await step('sweep')(() => sweepHeld(env))
  await step('accounts')(async () => {
    const out: Record<string, string> = {}
    for (const m of moved) {
      const blocked = await accounts.setSendingBlocked(env, m.stalwart_id, true)
      // An administrator account (Stalwart's own login) keeps its password: Stalwart's admin needs it until phase 5.
      if (blocked === 'done' && m.kind !== 'shared') await accounts.setPassword(env, m.stalwart_id, randomSecret())
      out[m.address] = blocked
    }
    return out
  })
  await step('notice')(async () => {
    const user = await usersDb.findById(env.DB, actor.userId)
    if (!user) return { sent: false }
    const lines = [
      `${domain.name} now runs on xstate's new mail system: ${moved.map((m) => m.address).join(', ')}.`,
      'Mail arrives through Amazon SES and is kept in each mailbox\'s own store. Mail apps that used IMAP or SMTP for these mailboxes no longer sign in; use the xstate apps.',
      `If anything is wrong, the switch can be rolled back for ${ROLLBACK_DAYS} days.`,
    ]
    return sendSystemEmail(env, { to: { name: user.name, email: user.email }, subject: `${domain.name} moved to the new mail system`, text: lines.join('\n\n'), html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('') })
  })
  console.log('domain-switch', JSON.stringify({ domain: domain.name, step: 'flipped', mailboxes: moved.length }))
  return switchStatus(env, actor, domainId)
}

/**
 * Back to Stalwart within ROLLBACK_DAYS of the flip: the domain returns to `switching` (SES mail handed to Stalwart
 * again), the mailboxes to Stalwart, and the messages the store received or sent since the flip are copied into
 * Stalwart. Moves, flags and calendar changes made since the flip are reported, not copied. Each store starts a fresh
 * shadow copy. Then move the MX back to Stalwart and `cancel`.
 */
export async function rollbackSwitch(env: SwitchEnv, actor: Actor, domainId: string): Promise<SwitchStatus & { copiedBack: Record<string, { copied: number; skipped: number }> }> {
  const { domain } = await ownerContext(env, actor, domainId)
  const sw = await switchesDb.latest(env.DB, domainId)
  if (!sw || sw.state !== 'flipped' || !sw.flipped_at) throw new EmailError('switch_state', `${domain.name} hasn't been flipped`, 409)
  if (Date.now() - Date.parse(sw.flipped_at) > ROLLBACK_DAYS * 86_400_000) throw new EmailError('switch_too_late', `The switch of ${domain.name} is over ${ROLLBACK_DAYS} days old`, 409)
  const mailboxes = await mailboxesOn(env, domainId)
  const now = new Date().toISOString()
  await env.DB.batch([
    ...mailboxes.map((m) => env.DB.prepare("UPDATE mailboxes SET backend = 'stalwart', store_mode = 'shadow', updated_at = ? WHERE id = ?").bind(now, m.id)),
    switchesDb.setMailPath(env.DB, domainId, 'switching', now),
    switchesDb.setState(env.DB, sw.id, 'rolled_back'),
  ])
  await syncStoreRouting(env)
  const copiedBack: Record<string, { copied: number; skipped: number }> = {}
  for (const m of mailboxes) {
    copiedBack[m.address] = await copyBack(env, m, Math.floor(Date.parse(sw.flipped_at) / 1000))
    await accounts.setSendingBlocked(env, m.stalwart_id, false)
    // A fresh shadow copy: the store holds nothing Stalwart doesn't have now.
    await (await store(env, m.id)).destroy()
  }
  await switchesDb.addStep(env.DB, sw.id, { step: 'rollback', at: new Date().toISOString(), ok: true, detail: copiedBack }).run()
  console.log('domain-switch', JSON.stringify({ domain: domain.name, step: 'rolled_back', copiedBack }))
  return { ...(await switchStatus(env, actor, domainId)), copiedBack }
}

/** Ends a switch whose MX still points at Stalwart (never flipped, or rolled back with the MX moved back). */
export async function cancelSwitch(env: SwitchEnv, actor: Actor, domainId: string): Promise<SwitchStatus> {
  const { domain } = await ownerContext(env, actor, domainId)
  const sw = await switchesDb.latest(env.DB, domainId)
  if (!sw || (sw.state !== 'switching' && sw.state !== 'rolled_back')) throw new EmailError('switch_state', `${domain.name} isn't being switched`, 409)
  const dns = await dnsOf(env, domain.name)
  // Only once the MX is back on Stalwart: otherwise SES would drop mail for mailboxes that are on Stalwart again.
  if (dns.onlySes && !isTestDomain(env, domain.name)) {
    throw new EmailError('switch_dns', `Public DNS still shows only Amazon SES for ${domain.name}; point the MX back at Stalwart first`, 409)
  }
  const now = new Date().toISOString()
  await env.DB.batch([
    switchesDb.setMailPath(env.DB, domainId, 'stalwart', now),
    switchesDb.setState(env.DB, sw.id, 'cancelled', { endedAt: now }),
    switchesDb.addStep(env.DB, sw.id, { step: 'cancel', at: now, ok: true }),
  ])
  return switchStatus(env, actor, domainId)
}

/** Hourly: for domains being switched, notes the first time public DNS shows only SES's MX. */
export async function watchSwitches(env: SwitchEnv): Promise<{ domain: string; onlySes: boolean }[]> {
  const out: { domain: string; onlySes: boolean }[] = []
  for (const sw of await switchesDb.switching(env.DB)) {
    const dns = await dnsOf(env, sw.name).catch(() => null)
    if (!dns) continue
    if (dns.onlySes) await switchesDb.setMxSeen(env.DB, sw.id, new Date().toISOString()).run()
    out.push({ domain: sw.name, onlySes: dns.onlySes })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------

async function ownerContext(env: SwitchEnv, actor: Actor, domainId: string) {
  const ctx = await domainContext(env, actor, domainId, 'manage')
  if (ctx.member.role !== 'owner') throw forbidden('Only the organization owner can move a domain to the new mail system')
  return ctx
}

/** Mailboxes with any address on the domain (primary or alias). */
async function mailboxesOn(env: SwitchEnv, domainId: string): Promise<MailboxRow[]> {
  const { results } = await env.DB.prepare('SELECT DISTINCT mailbox_id FROM addresses WHERE domain_id = ?').bind(domainId).all<{ mailbox_id: string }>()
  const rows = await Promise.all(results.map((r) => mailboxesDb.find(env.DB, r.mailbox_id)))
  return rows.filter((m): m is MailboxRow => !!m)
}

async function factsOf(env: SwitchEnv, m: MailboxRow, domainId: string): Promise<MailboxFacts> {
  const others = (await addressesDb.listForMailbox(env.DB, m.id)).filter((a) => a.domain_id !== domainId).map((a) => a.address)
  const base = { address: m.address, backend: m.backend, storeMode: m.store_mode, storeRaw: !!m.store_raw, otherDomainAddresses: others }
  if (m.backend === 'store' || m.store_mode === 'off') return { ...base, countsMatch: null, rawMissing: null, threadingLeft: null }
  const check = await checkStore(env as ShadowEnv, m.id).catch(() => null)
  const threading = await (await store(env, m.id)).threadingStats()
  return { ...base, countsMatch: check ? check.differences.length === 0 : null, rawMissing: check?.raw ? check.raw.missing : null, threadingLeft: threading.left }
}

async function dnsOf(env: SwitchEnv, name: string): Promise<{ mx: string[]; onlySes: boolean }> {
  // Test domains (local development) have no public DNS: they count as pointing at SES.
  if (isTestDomain(env, name)) return { mx: [], onlySes: true }
  const mx = await mxHosts(name)
  return { mx, onlySes: onlySesMx(mx, env.AWS_SES_REGION) }
}

/** Copies what the store received or sent since the flip into the mailbox's Stalwart account, once each. */
async function copyBack(env: SwitchEnv, m: MailboxRow, sinceS: number): Promise<{ copied: number; skipped: number }> {
  const result = { copied: 0, skipped: 0 }
  if (!storageConfigured(env)) return result
  const stub = await store(env, m.id)
  const messages = await stub.sinceFlip(sinceS)
  if (!messages.length) return result
  const bucket = await organizationBucket(env, m.organization_id)
  const folders = (await stalwartMail.getFolders(env, [m.stalwart_id])).get(m.stalwart_id) ?? []
  const folderFor = (role: string | null) => (folders.find((f) => f.role === (role === 'sent' || role === 'junk' || role === 'trash' || role === 'archive' ? role : 'inbox')) ?? folders.find((f) => f.role === 'inbox'))!
  for (const msg of messages) {
    if (!msg.rawKey || (msg.messageId && (await stalwartMail.hasMessageId(env, m.stalwart_id, msg.messageId)))) {
      result.skipped++
      continue
    }
    const res = await getObject(env, bucket, msg.rawKey)
    if (!res) {
      result.skipped++
      continue
    }
    const raw = new Uint8Array(await res.arrayBuffer())
    const blob = await stalwartMail.uploadBlob(env, m.stalwart_id, raw, 'message/rfc822', raw.length)
    const [imported] = await stalwartMail.importEmails(env, m.stalwart_id, [
      { blobId: blob.blobId, folderIds: [folderFor(msg.folder).id], keywords: msg.folder === 'sent' ? ['$seen'] : [], receivedAt: msg.receivedAt },
    ])
    if (imported?.ok) result.copied++
    else result.skipped++
  }
  return result
}

function nextStep(path: string, sw: DomainSwitchRow | null, ready: boolean, onlySes: boolean): string {
  if (path === 'stalwart') return ready ? 'Lower the MX record\'s TTL to 300 a day ahead, then start the switch.' : 'Fix the checks that fail, then start the switch.'
  if (path === 'switching' && sw?.state === 'rolled_back') return onlySes ? 'Point the MX record back at Stalwart, then cancel.' : 'Cancel the switch.'
  if (path === 'switching') return onlySes ? 'Public DNS shows only Amazon SES: flip when the old TTL has passed.' : 'Change the MX record to Amazon SES; flip once public DNS shows only it.'
  return `On the new mail system. Rollback is possible for ${ROLLBACK_DAYS} days after the flip.`
}

function view(sw: DomainSwitchRow): NonNullable<SwitchStatus['switch']> {
  return { id: sw.id, state: sw.state, startedAt: sw.started_at, mxSeenAt: sw.mx_seen_at, flippedAt: sw.flipped_at, endedAt: sw.ended_at, steps: JSON.parse(sw.steps) as SwitchStep[] }
}

function randomSecret(): string {
  return [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
