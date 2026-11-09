// The migration API, as the wizard calls it. The screens only use what this file exports.
//
// Signed in, every step goes to the real API (apps/api/src/migration); the only things kept in this browser are the
// last stage and copy totals the API reported, so Settings can show them without a request. In demo mode (?demo)
// everything is simulated in localStorage, one migration per organization; copying, DNS detection and the final
// sync advance with the clock, so the whole flow can be clicked through in a few minutes.
//
// Testing hooks (simulation only): ?sim=access-lost makes Google refuse access once copying has started, and
// ?sim=fail makes Verify fail the Gmail and Drive checks. Against the API with GOOGLE_MODE=fake, an admin
// address starting with "nodrive" fails two checks and one starting with "nobody" is unknown.

import { isDemo } from '../lib/account'
import { api, apiBlob, readJson, writeJson } from '../lib/core'
import { sampleDiscovery } from './sample'
import type {
  Connection,
  CopyStatus,
  Count,
  DnsRecordRow,
  FinalStatus,
  FinishStatus,
  Migration,
  Permission,
  Plan,
  ReportRow,
  Stage,
  SwitchStatus,
  UserPlan,
  UserProgress,
} from './types'

/** Simulation bookkeeping kept next to the migration. */
type Sim = {
  migration: Migration
  run?: { startedAt: number; pausedAt?: number; pausedMs: number; accessLostAt?: number; quotaFixed?: boolean }
  switch?: { enteredAt: number; ttlDone: boolean; published: boolean; detectedAt?: number }
  final?: { startedAt: number }
  finish?: { enteredAt: number; accessRemoved: boolean; invitesSent: boolean }
}

const key = (orgId: string) => `xstate.migration.${orgId}`
/** Signed in and not in demo mode: the steps the API does go to the API. */
const live = () => !isDemo()
/** The last stage the API reported, so Settings can show it without a request. */
const stageKey = (orgId: string) => `xstate.migration.${orgId}.stage`

type Remote = { migration: Migration | null }

/**
 * Notes what the API returned. Signed in, the API is the only source of truth: nothing from the demo simulation is
 * read, so two admins' browsers can't disagree about which step the import is on.
 */
function remember(orgId: string, m: Migration): Migration {
  writeJson(stageKey(orgId), m.stage)
  if (m.google?.clientId) CLIENT_ID = m.google.clientId
  if (m.google) SCOPES = m.google.scopes.map((g) => ({ ...SCOPE_TEXT[g.id], id: g.id, url: g.scopes.join(',') }))
  return m
}
const params = new URLSearchParams(location.search)
const wait = (ms = 350) => new Promise((r) => setTimeout(r, ms))

function read(orgId: string): Sim | null {
  return readJson<Sim>(key(orgId))
}

function write(orgId: string, sim: Sim): void {
  writeJson(key(orgId), sim)
}

function update(orgId: string, fn: (sim: Sim) => void): Sim {
  const sim = read(orgId)
  if (!sim) throw new Error('No migration has been started for this organization.')
  fn(sim)
  write(orgId, sim)
  return sim
}

/** The migration in progress, or a new one at the Connect step. `lastSeenAt` is the previous visit. */
export async function load(orgId: string, admin: { name: string; email: string }): Promise<Migration> {
  if (live()) {
    const { migration } = await api<Remote>('GET', `/migration/orgs/${orgId}`)
    if (!migration) throw new Error('No import has been started for this organization yet. Ask an admin to start one.')
    // Past copying, the later steps show the copy totals; fetch them in case this browser never saw the copy.
    if (['switch', 'final', 'finish', 'done'].includes(migration.stage)) await copyStatus(orgId).catch(() => null)
    return remember(orgId, migration)
  }
  await wait(150)
  const sim = read(orgId) ?? {
    migration: {
      stage: 'connect',
      startedBy: admin,
      lastSeenAt: new Date().toISOString(),
      connection: null,
      discovery: null,
      plan: null,
    },
  }
  const previous = sim.migration.lastSeenAt
  sim.migration.lastSeenAt = new Date().toISOString()
  write(orgId, sim)
  return { ...sim.migration, lastSeenAt: previous }
}

/** Whether this organization has a migration that has started copying, for Settings (from what was last fetched). */
export function summary(orgId: string): { stage: Stage; percent: number | null } | null {
  if (live()) {
    const stage = readJson<Stage>(stageKey(orgId))
    if (!stage) return null
    return { stage, percent: stage === 'copying' ? (readJson<{ percent: number }>(totalsKey(orgId))?.percent ?? null) : null }
  }
  const sim = read(orgId)
  if (!sim) return null
  return { stage: sim.migration.stage, percent: sim.run && sim.migration.stage === 'copying' ? status(sim).percent : null }
}

export async function setStage(orgId: string, stage: Stage): Promise<Migration> {
  if (live()) {
    const { migration } = await api<{ migration: Migration }>('POST', `/migration/orgs/${orgId}/stage`, { stage })
    return remember(orgId, migration)
  }
  await wait(80)
  return simStage(orgId, stage)
}

function simStage(orgId: string, stage: Stage): Migration {
  return update(orgId, (sim) => {
    sim.migration.stage = stage
    const now = Date.now()
    if (stage === 'switch' && !sim.switch) sim.switch = { enteredAt: now, ttlDone: false, published: false }
    if (stage === 'finish' && !sim.finish) sim.finish = { enteredAt: now, accessRemoved: false, invitesSent: false }
    if (stage === 'done') sim.migration.finishedAt = new Date(now).toISOString()
  }).migration
}

// ---------------------------------------------------------------------------------------------------------------
// 1 · Connect

/** The client ID admins paste into Domain-wide delegation. The API's replaces the demo one once loaded. */
export let CLIENT_ID = '108234552971636281530'

const SCOPE_TEXT: Record<Permission, { label: string; detail: string }> = {
  directory: { label: 'Directory', detail: 'Read users, groups, domains and storage use' },
  gmail: { label: 'Gmail', detail: 'Read messages, labels and attachments' },
  contacts: { label: 'Contacts', detail: 'Read personal and other contacts' },
  drive: { label: 'Drive', detail: 'Read My Drive, Shared drives and sharing' },
  calendar: { label: 'Calendar', detail: 'Read the calendars people own and their events' },
}

/** One line per permission. Signed in, the scopes come from the API, so they always match what Verify checks. */
export let SCOPES: { id: Permission; label: string; url: string; detail: string }[] = [
  {
    id: 'directory',
    label: 'Directory',
    url: 'https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.group.readonly,https://www.googleapis.com/auth/admin.directory.domain.readonly',
    detail: 'Read users, groups and domains',
  },
  { id: 'gmail', label: 'Gmail', url: 'https://www.googleapis.com/auth/gmail.readonly', detail: 'Read messages, labels and attachments' },
  {
    id: 'contacts',
    label: 'Contacts',
    url: 'https://www.googleapis.com/auth/contacts.readonly,https://www.googleapis.com/auth/contacts.other.readonly',
    detail: 'Read personal and other contacts',
  },
  { id: 'drive', label: 'Drive', url: 'https://www.googleapis.com/auth/drive.readonly', detail: 'Read My Drive, Shared drives and sharing' },
  { id: 'calendar', label: 'Calendar', url: 'https://www.googleapis.com/auth/calendar.readonly', detail: 'Read the calendars people own and their events' },
]

/** Asks Google for a token per scope, as the admin. */
export async function verify(orgId: string, adminEmail: string): Promise<Connection> {
  if (live()) {
    const { migration } = await api<{ migration: Migration }>('POST', `/migration/orgs/${orgId}/verify`, { adminEmail })
    return remember(orgId, migration).connection!
  }
  await wait(1400)
  const failing = params.get('sim') === 'fail'
  const connection: Connection = {
    adminEmail,
    checks: { directory: true, gmail: !failing, contacts: true, drive: !failing, calendar: true },
    verifiedAt: new Date().toISOString(),
  }
  update(orgId, (sim) => {
    sim.migration.connection = connection
  })
  return connection
}

export const allPassed = (c: Connection | null) => !!c && Object.values(c.checks).every(Boolean)

// ---------------------------------------------------------------------------------------------------------------
// 2 · Discover

/** How long the Discover step waits for the server before saying it's slow (the watchdog restarts lost jobs hourly). */
const DISCOVERY_WAIT_MS = 15 * 60_000

export const DISCOVERY_PARTS = ['Users and groups', 'Domains', 'Shared drives', 'Mail size', 'Drive size', 'Contacts'] as const

/**
 * Counts what's in the Workspace whose admin was verified. `onPart` reports each part as it finishes (for the
 * loading list). `xstateDomains` are the organization's domains in xstate, or null to keep the sample's answer.
 */
export async function discover(
  orgId: string,
  domain: string,
  xstateDomains: string[] | null,
  onPart: (index: number) => void,
  /** Stops the wait (the step was left); the server carries on and the result shows when the step is opened again. */
  signal?: AbortSignal,
): Promise<Migration> {
  if (live()) {
    // Runs in the background on the server; the loading list follows its progress.
    let { migration } = await api<{ migration: Migration }>('POST', `/migration/orgs/${orgId}/discover`)
    const until = Date.now() + DISCOVERY_WAIT_MS
    for (;;) {
      const s = migration.discoveryStatus
      onPart(s?.partsDone ?? 0)
      if (s?.state === 'failed') throw new Error(s.error ?? 'Discovery failed. Try again.')
      if (s?.state === 'done') return remember(orgId, migration)
      if (Date.now() > until) throw new Error('Discovery is taking longer than usual. Leave this page open and come back, or count again.')
      await wait(1500)
      if (signal?.aborted) throw new DOMException('Left the step', 'AbortError')
      migration = (await api<{ migration: Migration }>('GET', `/migration/orgs/${orgId}`)).migration
    }
  }
  for (let i = 0; i < DISCOVERY_PARTS.length; i++) {
    await wait(i === 3 ? 1600 : 700)
    onPart(i + 1)
  }
  const discovery = sampleDiscovery(domain)
  if (xstateDomains) for (const d of discovery.domains) d.inXstate = xstateDomains.includes(d.name)
  return update(orgId, (sim) => {
    sim.migration.discovery = discovery
    sim.migration.plan ??= defaultPlan(sim.migration)
    sim.migration.stage = 'discover'
  }).migration
}

/** Suspended users default to a shared mailbox (or Skip when they have almost nothing); everyone else gets a member. */
function defaultPlan(m: Migration): Plan {
  const d = m.discovery!
  const users: Record<string, UserPlan> = {}
  for (const u of d.users) {
    if (u.suspended && u.mailBytes < 1024 ** 3) users[u.id] = { action: 'skip', mail: false, contacts: false, drive: false, calendar: false }
    // Google won't let xstate read a suspended person's contacts or calendar.
    else if (u.suspended) users[u.id] = { action: 'shared', mail: true, contacts: false, drive: true, calendar: false }
    else if (u.existingMailbox) users[u.id] = { action: 'existing', existing: u.existingMailbox, mail: true, contacts: true, drive: true, calendar: true }
    else users[u.id] = { action: 'create', mail: true, contacts: true, drive: true, calendar: true }
  }
  return {
    users,
    groups: Object.fromEntries(d.groups.map((g) => [g.id, g.members <= 12])),
    drives: Object.fromEntries(d.drives.map((x) => [x.id, true])),
    mailRange: 'all',
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 3 · Plan and 4 · Review

export async function savePlan(orgId: string, plan: Plan): Promise<void> {
  if (live()) return api('PUT', `/migration/orgs/${orgId}/plan`, plan)
  update(orgId, (sim) => {
    sim.migration.plan = plan
  })
}

export const RANGE_SHARE: Record<Plan['mailRange'], number> = { all: 1, '5y': 0.82, '3y': 0.64, '1y': 0.3 }

export async function start(orgId: string): Promise<Migration> {
  if (live()) {
    // The API creates members, mailboxes and shared mailboxes, then starts the copy jobs.
    const { migration } = await api<{ migration: Migration }>('POST', `/migration/orgs/${orgId}/start`)
    return remember(orgId, migration)
  }
  await wait(600)
  return update(orgId, (sim) => {
    sim.run = { startedAt: Date.now(), pausedMs: 0 }
    sim.migration.stage = 'copying'
  }).migration
}

// ---------------------------------------------------------------------------------------------------------------
// 5 · Copying

/** Seconds of simulation per user, and when each starts. Marcus has 500,000 messages and is slowed by Google. */
function schedule(index: number, messages: number): { offset: number; length: number } {
  return { offset: (index % 6) * 2 + Math.floor(index / 6) * 9, length: messages > 200_000 ? 150 : 18 + Math.min(24, messages / 1500) }
}

/** The simulated length of the copy, scaled to a believable real duration for "time left". */
const REAL_PER_SIM_SECOND = (2 * 86_400) / 190

function elapsed(sim: Sim, now = Date.now()): number {
  const run = sim.run!
  const stop = run.accessLostAt ?? run.pausedAt ?? now
  return Math.max(0, (stop - run.startedAt - run.pausedMs) / 1000)
}

function count(total: number, share: number): Count {
  return { done: Math.min(total, Math.round(total * share)), total }
}

function status(sim: Sim): CopyStatus {
  const m = sim.migration
  const d = m.discovery!
  const plan = m.plan!
  const t = elapsed(sim)
  const range = RANGE_SHARE[plan.mailRange]
  const paused = !!sim.run?.pausedAt
  const accessLost = !!sim.run?.accessLostAt
  const users: UserProgress[] = []
  let doneUsers = 0
  let sum = 0
  let longest = 0
  const totals = { messages: 0, contacts: 0, files: 0, events: 0 }

  d.users.forEach((user, index) => {
    const p = plan.users[user.id]!
    if (p.action === 'skip') return
    const { offset, length } = schedule(index, user.messages ?? 0)
    longest = Math.max(longest, offset + length)
    let share = Math.max(0, Math.min(1, (t - offset) / length))
    const messages = Math.round((user.messages ?? 0) * range)

    // Sofia's mailbox quota is smaller than her Gmail: mail stops at 63% until it's fixed.
    const quotaStop = user.id === 'g-sofia' && !sim.run?.quotaFixed
    const mailShare = quotaStop ? Math.min(share, 0.635) : share
    const contactsShare = Math.min(1, share * 3)
    const progress: UserProgress = {
      user,
      action: p.action,
      mail: p.mail ? count(messages, mailShare) : null,
      contacts: p.contacts && p.action !== 'shared' ? count(user.contacts ?? 0, contactsShare) : null,
      drive: p.drive ? count(user.files ?? 0, share) : null,
      // A made-up calendar per person: about 40 events plus a few per thousand messages.
      calendar: p.calendar && p.action !== 'shared' ? count(40 + Math.round((user.messages ?? 0) / 2000), Math.min(1, share * 2)) : null,
      ...(user.driveBytes > 1024 ** 4 && p.drive && { driveBytes: count(user.driveBytes, share) }),
      state: 'waiting',
    }
    const parts = [progress.mail, progress.contacts, progress.drive, progress.calendar].filter((x): x is Count => !!x)
    const finished = parts.every((c) => c.done === c.total)
    if (finished) progress.state = 'done'
    else if (quotaStop && mailShare >= 0.635) {
      progress.state = 'attention'
      progress.issue = 'quota'
    } else if (share > 0) progress.state = messages > 200_000 ? 'slowed' : 'copying'
    if ((paused || accessLost) && progress.state !== 'done') progress.state = 'paused'
    if (progress.state === 'done') doneUsers++
    if (quotaStop && progress.state !== 'done') share = Math.min(share, 0.8)
    sum += progress.state === 'done' ? 1 : share
    totals.messages += progress.mail?.total ?? 0
    totals.contacts += progress.contacts?.total ?? 0
    totals.events += progress.calendar?.total ?? 0
    totals.files += progress.drive?.total ?? 0
    users.push(progress)
  })

  const percent = users.length ? Math.floor((sum / users.length) * 100) : 100
  return {
    users,
    percent: doneUsers === users.length ? 100 : Math.min(99, percent),
    doneUsers,
    remaining: Math.max(60, (longest - t) * REAL_PER_SIM_SECOND),
    paused,
    accessLost,
    ...(sim.run?.accessLostAt && { pausedAt: new Date(sim.run.accessLostAt).toISOString() }),
    finished: doneUsers === users.length,
    totals,
  }
}

/** The last real copy status, so Settings and the steps after copying can show it without a request. */
const totalsKey = (orgId: string) => `xstate.migration.${orgId}.totals`
type Totals = CopyStatus['totals'] & { users: number; percent: number }

export async function copyStatus(orgId: string): Promise<CopyStatus> {
  if (live()) {
    const s = await api<CopyStatus>('GET', `/migration/orgs/${orgId}/copy`)
    writeJson(totalsKey(orgId), { ...s.totals, users: s.users.length, percent: s.percent } satisfies Totals)
    return s
  }
  await wait(60)
  const sim = read(orgId)!
  // ?sim=access-lost: Google stops accepting the access 12 seconds into the copy.
  if (params.get('sim') === 'access-lost' && sim.run && !sim.run.accessLostAt && !sim.run.pausedAt && elapsed(sim) > 12) {
    update(orgId, (s) => {
      s.run!.accessLostAt = Date.now()
    })
    return status(read(orgId)!)
  }
  return status(sim)
}

export async function pause(orgId: string): Promise<void> {
  if (live()) return api('POST', `/migration/orgs/${orgId}/pause`)
  await wait(200)
  update(orgId, (sim) => {
    sim.run!.pausedAt ??= Date.now()
  })
}

export async function resume(orgId: string): Promise<void> {
  if (live()) return api('POST', `/migration/orgs/${orgId}/resume`)
  await wait(200)
  update(orgId, (sim) => {
    const run = sim.run!
    if (run.pausedAt) run.pausedMs += Date.now() - run.pausedAt
    delete run.pausedAt
  })
}

/** Checks whether Google accepts xstate's access again; copying resumes where it stopped if it does. */
export async function checkAccess(orgId: string): Promise<boolean> {
  if (live()) {
    const { ok } = await api<{ ok: boolean }>('POST', `/migration/orgs/${orgId}/check-access`)
    if (!ok) throw new Error('Google still refuses xstate’s access. Check Domain-wide delegation, then try again.')
    return ok
  }
  await wait(1200)
  update(orgId, (sim) => {
    const run = sim.run!
    if (run.accessLostAt) run.pausedMs += Date.now() - run.accessLostAt
    delete run.accessLostAt
  })
  // Don't take it away again in the same visit.
  params.delete('sim')
  return true
}

export type QuotaFix = 'raise' | 'range' | 'retry' | 'skip'

/**
 * Unblocks one person's copy: raise the quota of their xstate mailbox (or, in the demo, copy only recent mail),
 * or try again after fixing the cause in Google.
 */
export async function fixQuota(orgId: string, fix: QuotaFix, googleId: string): Promise<void> {
  if (live()) return api('POST', `/migration/orgs/${orgId}/users/${encodeURIComponent(googleId)}/fix`, { fix: fix === 'range' ? 'retry' : fix })
  await wait(500)
  update(orgId, (sim) => {
    sim.run!.quotaFixed = true
  })
}

/** Done → Import again: a fresh migration from Connect (the API keeps the finished one's report until its cleanup). */
export async function startNew(orgId: string): Promise<Migration> {
  if (live()) {
    const { migration } = await api<{ migration: Migration }>('POST', `/migration/orgs/${orgId}/new`)
    writeJson(totalsKey(orgId), null)
    return remember(orgId, migration)
  }
  writeJson(key(orgId), null)
  return load(orgId, { name: 'You', email: '' })
}

/** Stops copying. Everything copied so far stays in xstate; the wizard starts again at Connect. */
export async function cancel(orgId: string): Promise<void> {
  if (live()) {
    await api('POST', `/migration/orgs/${orgId}/cancel`)
    writeJson(key(orgId), null)
    writeJson(stageKey(orgId), null)
    return
  }
  await wait(500)
  writeJson(key(orgId), null)
}

// ---------------------------------------------------------------------------------------------------------------
// 6 · Switch

function records(domain: string): Omit<DnsRecordRow, 'found'>[] {
  return [
    { type: 'MX', name: '@', value: '10 mx.xstate.io' },
    { type: 'TXT', name: '@', value: 'v=spf1 mx include:amazonses.com ~all' },
    {
      type: 'TXT',
      name: 'xstate._domainkey',
      value: 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAu7Q3x2Lr9pX0dJgK5vT8sQx',
    },
    { type: 'TXT', name: '_dmarc', value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}` },
  ]
}

function switchStatus(sim: Sim): SwitchStatus {
  const s = sim.switch!
  const detected = s.published
  return {
    ttlDone: s.ttlDone,
    records: records(sim.migration.discovery!.domain).map((r) => ({ ...r, found: detected })),
    ...(s.detectedAt && { detectedAt: new Date(s.detectedAt).toISOString() }),
    provider: 'Cloudflare',
  }
}

/** Looks the records up again. In the simulation they appear 15 seconds after the step opens. */
export async function checkRecords(orgId: string): Promise<SwitchStatus> {
  if (live()) return api<SwitchStatus>('GET', `/migration/orgs/${orgId}/switch`)
  await wait(500)
  const sim = update(orgId, (s) => {
    const sw = s.switch!
    if (!sw.published && Date.now() - sw.enteredAt > 15_000) {
      sw.published = true
      sw.detectedAt = Date.now()
    }
  })
  return switchStatus(sim)
}

export async function markTtlDone(orgId: string): Promise<SwitchStatus> {
  if (live()) return api<SwitchStatus>('POST', `/migration/orgs/${orgId}/switch/ttl`)
  return switchStatus(
    update(orgId, (s) => {
      s.switch!.ttlDone = true
    }),
  )
}

/** One-click setup through the DNS host (Domain Connect). */
export async function autoSetup(orgId: string, applyUrl?: string | null): Promise<SwitchStatus> {
  if (live()) {
    // The DNS host's page adds the records; the checklist picks them up when they resolve.
    if (applyUrl) window.open(applyUrl, '_blank', 'noopener')
    return checkRecords(orgId)
  }
  await wait(1500)
  return switchStatus(
    update(orgId, (s) => {
      s.switch!.published = true
      s.switch!.detectedAt = Date.now()
    }),
  )
}

/** What the copy moved. Signed in, the totals last fetched (zeros until the first fetch lands). */
export function copiedTotals(orgId: string): CopyStatus['totals'] & { users: number } {
  if (live()) return readJson<Totals>(totalsKey(orgId)) ?? { messages: 0, contacts: 0, files: 0, users: 0 }
  const s = status(read(orgId)!)
  return { ...s.totals, users: s.users.length }
}

// ---------------------------------------------------------------------------------------------------------------
// 7 · Final sync

const FINAL_SECONDS = 25

export async function startFinal(orgId: string): Promise<void> {
  if (live()) return api('POST', `/migration/orgs/${orgId}/final`)
  await wait(400)
  update(orgId, (sim) => {
    sim.final = { startedAt: Date.now() }
    sim.migration.stage = 'final'
  })
}

export async function finalStatus(orgId: string): Promise<FinalStatus> {
  if (live()) return api<FinalStatus>('GET', `/migration/orgs/${orgId}/final`)
  await wait(60)
  const sim = read(orgId)!
  const startedAt = sim.final?.startedAt ?? Date.now()
  const share = Math.min(1, (Date.now() - startedAt) / 1000 / FINAL_SECONDS)
  return {
    mail: count(3_204, share),
    contacts: count(38, Math.min(1, share * 2)),
    calendar: count(64, Math.min(1, share * 1.8)),
    drive: count(212, Math.min(1, share * 1.4)),
    finished: share >= 1,
    rerunAt: new Date(startedAt + 86_400_000).toISOString(),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// 8 · Finish

/** xstate checks every minute whether its Google access is gone; the simulation sees it gone after 20 seconds. */
export async function finishStatus(orgId: string): Promise<FinishStatus> {
  if (live()) return api<FinishStatus>('GET', `/migration/orgs/${orgId}/finish`)
  await wait(60)
  const sim = update(orgId, (s) => {
    const f = (s.finish ??= { enteredAt: Date.now(), accessRemoved: false, invitesSent: false })
    if (!f.accessRemoved && Date.now() - f.enteredAt > 20_000) f.accessRemoved = true
  })
  const f = sim.finish!
  const m = sim.migration
  const d = m.discovery!
  const plan = m.plan!
  const copy = status(sim)
  const report: ReportRow[] = copy.users.map((u) => ({
    name: u.user.name,
    shared: u.action === 'shared',
    messages: u.mail?.total ?? 0,
    contacts: u.contacts?.total ?? null,
    events: u.calendar?.total ?? null,
    files: u.drive?.total ?? 0,
  }))
  const period = 10_000
  const since = Date.now() - f.enteredAt
  return {
    accessRemoved: f.accessRemoved,
    nextCheckAt: new Date(Date.now() + (period - (since % period))).toISOString(),
    invitesSent: f.invitesSent,
    newMembers: d.users.filter((u) => plan.users[u.id]!.action === 'create').map((u) => ({ name: u.name, email: u.email })),
    report,
    skipped: [
      { count: 1_180, label: '"Anyone with the link" shares', reason: 'not recreated; files are private to their owner in xstate' },
      { count: 84, label: 'Files owned by people outside the company', reason: 'shared into Drive from other organizations' },
      { count: 31, label: 'Google Forms', reason: 'no file format to export' },
      { count: 17, label: 'Chat messages in mail', reason: "Google Chat isn't imported" },
    ],
  }
}

/** For Settings: an import that ended while xstate can still read the Google Workspace. Never in demo mode. */
export type AccessReminder = { open: false } | { open: true; ended: 'finished' | 'cancelled'; endedAt: string | null; domain: string | null }

export async function accessReminder(orgId: string): Promise<AccessReminder> {
  if (!live()) return { open: false }
  return api<AccessReminder>('GET', `/migration/orgs/${orgId}/access-reminder`)
}

/** Links for people who couldn't be emailed (no personal address in Google), for the admin to pass on. */
export type InviteLink = { name: string; email: string; url: string }

export async function sendInvites(orgId: string): Promise<{ sent: number; links: InviteLink[] }> {
  if (live()) return api<{ sent: number; links: InviteLink[] }>('POST', `/migration/orgs/${orgId}/finish/invites`)
  await wait(900)
  const sim = update(orgId, (s) => {
    s.finish!.invitesSent = true
  })
  return { sent: sim.migration.discovery!.users.length, links: [] }
}

/** The report to download: from the API (every skipped item included), or made here in demo mode. */
export async function reportBlob(orgId: string, f: FinishStatus): Promise<Blob> {
  if (live()) return apiBlob(`/migration/orgs/${orgId}/report.csv`)
  return new Blob([reportCsv(f)], { type: 'text/csv' })
}

/** The report as CSV, one row per user. */
export function reportCsv(f: FinishStatus): string {
  const esc = (v: string | number | null) => {
    const s = v === null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [['User', 'Kind', 'Messages', 'Contacts', 'Calendar events', 'Files']]
  for (const r of f.report) {
    rows.push([r.name, r.shared ? 'Shared mailbox' : 'Member', String(r.messages), r.contacts === null ? '' : String(r.contacts), r.events == null ? '' : String(r.events), String(r.files)])
  }
  rows.push([], ['Skipped', 'Count', 'Reason'])
  for (const s of f.skipped) rows.push([s.label, String(s.count), s.reason])
  return rows.map((r) => r.map(esc).join(',')).join('\n')
}
