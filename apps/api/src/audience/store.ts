// One Durable Object per organization (AUDIENCE.idFromName(organizationId)) holding that organization's audience in
// its own SQLite: people, their events, saved segments, and the attribute and event names seen so far.
//
// People are users and leads from the organization's websites, and contacts: address-book entries (imported from
// Google, or added by hand). A contact has no website (domain '') and belongs to one member (owner_member_id), or to
// the whole organization when that's NULL. Each read takes a viewer, and contacts of other members are left out.
// Google's "Other contacts" (auto-saved addresses) are contacts with attributes.other = true, kept out of the list
// and used for compose suggestions.
//
// Why a Durable Object and not D1: tracking writes on every page view of every customer's website. Kept apart per
// organization, one busy site can't slow sign-in or mail for everyone else, and no single database has to hold all
// of it. Access checks happen in the Worker (audience/service.ts); this class trusts its callers.

import { DurableObject } from 'cloudflare:workers'
import {
  type Dimension,
  type OverviewFilter,
  type OverviewRange,
  SESSION_RETENTION_DAYS,
  breakdownQuery,
  periodOf,
  seriesQuery,
  sessionWhere,
  totalsQuery,
} from './overview'
import { type Funnel, type FunnelInput, type FunnelRange, type FunnelResult, funnelQuery, summarize } from './funnels'
import { addEngagement, applyEmail, applyEvent, identified, type Metrics, mergeMetrics } from './metrics'
import { siteOf } from './site'
import {
  ANONYMOUS_RETENTION_DAYS,
  type AudienceEvent,
  type Attributes,
  type CollectBatch,
  type CollectItem,
  type Condition,
  type EmailActivity,
  EVENT_RETENTION_DAYS,
  type EventType,
  type FeedEvent,
  type Filter,
  IDENTIFY,
  PAGEVIEW,
  type Person,
  type PersonFields,
  type Segment,
  type SegmentIcon,
  type VisitContext,
} from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,                 -- 'user' (identified with a user id), 'lead' or 'contact'
  domain         TEXT NOT NULL,                 -- the website (site.ts): the organization's domain, else the hostname
  external_id    TEXT,                          -- the customer's own user id
  anonymous_id   TEXT,                          -- first visitor id seen
  name           TEXT,
  email          TEXT,
  phone          TEXT,
  source         TEXT NOT NULL,
  attributes     TEXT NOT NULL DEFAULT '{}',
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  owner_member_id TEXT                          -- contacts: the member whose contact it is; NULL = shared
);
CREATE UNIQUE INDEX IF NOT EXISTS people_external ON people (domain, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS people_seen ON people (last_seen_at DESC, id);
CREATE INDEX IF NOT EXISTS people_domain ON people (domain, last_seen_at DESC);

-- Every visitor id a person has used (one per browser), so later events from any of them find the person.
CREATE TABLE IF NOT EXISTS aliases (
  domain        TEXT NOT NULL,
  anonymous_id  TEXT NOT NULL,
  person_id     TEXT NOT NULL,
  PRIMARY KEY (domain, anonymous_id)
);
CREATE INDEX IF NOT EXISTS aliases_person ON aliases (person_id);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  properties   TEXT NOT NULL DEFAULT '{}',
  url          TEXT,
  occurred_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_person ON events (person_id, name, occurred_at);
CREATE INDEX IF NOT EXISTS events_time ON events (occurred_at);

-- Names for the segment builder's pickers.
CREATE TABLE IF NOT EXISTS event_names (name TEXT PRIMARY KEY, total INTEGER NOT NULL, last_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attribute_defs (key TEXT PRIMARY KEY, type TEXT NOT NULL, created_at TEXT NOT NULL);

-- Visits: one row per session id from the snippet (or a server call's context.sessionId), with what is the same for
-- the whole visit: where it came from, the device and the location. Events point here, so they stay small.
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  person_id         TEXT NOT NULL,
  domain            TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT NOT NULL,
  pageviews         INTEGER NOT NULL DEFAULT 0,
  events            INTEGER NOT NULL DEFAULT 0,
  engaged_ms        INTEGER NOT NULL DEFAULT 0,
  landing_path      TEXT,
  exit_path         TEXT,
  channel           TEXT,
  referrer          TEXT,
  referring_domain  TEXT,
  utm_source        TEXT,
  utm_medium        TEXT,
  utm_campaign      TEXT,
  utm_term          TEXT,
  utm_content       TEXT,
  click_id          TEXT,
  ip                TEXT,                          -- NULL when the organization doesn't keep IP addresses
  country           TEXT,
  region            TEXT,
  city              TEXT,
  postal_code       TEXT,
  timezone          TEXT,
  latitude          REAL,                          -- rounded to about 10 km
  longitude         REAL,
  continent         TEXT,
  asn               INTEGER,
  as_org            TEXT,
  browser           TEXT,
  browser_version   TEXT,
  os                TEXT,
  os_version        TEXT,
  device_type       TEXT,
  screen            TEXT,
  viewport          TEXT,
  locale            TEXT,
  library           TEXT
);
CREATE INDEX IF NOT EXISTS sessions_time ON sessions (domain, started_at);
CREATE INDEX IF NOT EXISTS sessions_person ON sessions (person_id, started_at);
CREATE INDEX IF NOT EXISTS sessions_ended ON sessions (ended_at);

-- Funnels (funnels.ts): ordered steps within a conversion window. Results are cached for a few minutes.
CREATE TABLE IF NOT EXISTS funnels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  steps        TEXT NOT NULL,
  window_days  INTEGER NOT NULL,
  position     INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS funnel_cache (
  funnel_id    TEXT NOT NULL,
  key          TEXT NOT NULL,                 -- range and domain
  result       TEXT NOT NULL,
  computed_at  TEXT NOT NULL,
  PRIMARY KEY (funnel_id, key)
);

CREATE TABLE IF NOT EXISTS segments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT NOT NULL,
  filter      TEXT NOT NULL,
  position    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`

/**
 * Changes to stores made before them, applied once each (the version is kept in storage). New stores get the same
 * result: SCHEMA, then every step.
 */
const UPGRADES: ((sql: SqlStorage) => void)[] = [
  // 1: contacts. Website people stay unique per (domain, email); contacts are unique per (owner, email) instead.
  (sql) => {
    const cols = sql.exec<{ name: string }>('PRAGMA table_info(people)').toArray().map((c) => c.name)
    if (!cols.includes('owner_member_id')) sql.exec('ALTER TABLE people ADD COLUMN owner_member_id TEXT')
    sql.exec('DROP INDEX IF EXISTS people_email')
    sql.exec("CREATE UNIQUE INDEX people_email ON people (domain, email) WHERE email IS NOT NULL AND kind <> 'contact'")
    sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS people_contact_email ON people (coalesce(owner_member_id, ''), email) WHERE kind = 'contact' AND email IS NOT NULL",
    )
    sql.exec("CREATE INDEX IF NOT EXISTS people_contact_owner ON people (owner_member_id) WHERE kind = 'contact'")
  },
  // 2: analytics. Events get their type, site, visit and path; people get metrics (metrics.ts).
  (sql) => {
    const cols = (table: string) => sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((c) => c.name)
    const events = cols('events')
    if (!events.includes('type')) sql.exec("ALTER TABLE events ADD COLUMN type TEXT NOT NULL DEFAULT 'track'")
    if (!events.includes('domain')) sql.exec('ALTER TABLE events ADD COLUMN domain TEXT')
    if (!events.includes('session_id')) sql.exec('ALTER TABLE events ADD COLUMN session_id TEXT')
    if (!events.includes('path')) sql.exec('ALTER TABLE events ADD COLUMN path TEXT')
    if (!cols('people').includes('metrics')) sql.exec("ALTER TABLE people ADD COLUMN metrics TEXT NOT NULL DEFAULT '{}'")
    sql.exec("UPDATE events SET type = 'page' WHERE name = '$pageview'")
    sql.exec('UPDATE events SET domain = (SELECT domain FROM people WHERE people.id = events.person_id) WHERE domain IS NULL')
    sql.exec('CREATE INDEX IF NOT EXISTS events_name_time ON events (name, occurred_at)')
    sql.exec('CREATE INDEX IF NOT EXISTS events_domain_time ON events (domain, occurred_at DESC, id DESC)')
    sql.exec('CREATE INDEX IF NOT EXISTS events_session ON events (session_id) WHERE session_id IS NOT NULL')
  },
  // 3: email events find people by address on any of the organization's sites.
  (sql) => {
    sql.exec("CREATE INDEX IF NOT EXISTS people_email_any ON people (email) WHERE email IS NOT NULL AND kind <> 'contact'")
  },
  // 4: the Overview. Revenue is kept on the visit it came from (so it outlives events and splits by channel), and
  // visits across all sites are read by time.
  (sql) => {
    const cols = sql.exec<{ name: string }>('PRAGMA table_info(sessions)').toArray().map((c) => c.name)
    if (!cols.includes('revenue')) sql.exec('ALTER TABLE sessions ADD COLUMN revenue REAL NOT NULL DEFAULT 0')
    if (!cols.includes('orders')) sql.exec('ALTER TABLE sessions ADD COLUMN orders INTEGER NOT NULL DEFAULT 0')
    sql.exec(
      `UPDATE sessions SET
         revenue = coalesce((SELECT sum(CAST(json_extract(e.properties, '$.revenue') AS REAL)) FROM events e
                             WHERE e.session_id = sessions.id AND e.type = 'track' AND typeof(json_extract(e.properties, '$.revenue')) IN ('integer', 'real')), 0),
         orders = (SELECT count(*) FROM events e
                   WHERE e.session_id = sessions.id AND e.type = 'track' AND typeof(json_extract(e.properties, '$.revenue')) IN ('integer', 'real'))`,
    )
    sql.exec('CREATE INDEX IF NOT EXISTS sessions_started ON sessions (started_at)')
  },
  // 5: people are kept per site (site.ts), not per hostname. The organization's domains last used, so a change to
  // them re-keys people and visitor ids (useSites); the first collect after this upgrade does that once.
  (sql) => {
    sql.exec('CREATE TABLE IF NOT EXISTS sites (name TEXT PRIMARY KEY)')
  },
]

/** Organization-wide analytics settings, kept in the store's own storage. */
export type AnalyticsSettings = { storeIp: boolean }
const DEFAULT_SETTINGS: AnalyticsSettings = { storeIp: true }

/** Who is looking: their member id, and whether they may change website people, segments and shared contacts. */
export type Viewer = { memberId: string; manage: boolean }

/** Segments every organization starts with. They're ordinary segments: rename or delete them freely. */
const STARTER_SEGMENTS: { name: string; icon: SegmentIcon; filter: Filter }[] = [
  { name: 'Leads', icon: 'target', filter: { match: 'all', conditions: [{ kind: 'type', op: 'is', value: 'lead' }] } },
  { name: 'Active this week', icon: 'clock', filter: { match: 'all', conditions: [{ kind: 'date', field: 'last_seen', op: 'within', days: 7 }] } },
  { name: 'New this month', icon: 'star', filter: { match: 'all', conditions: [{ kind: 'date', field: 'created', op: 'within', days: 30 }] } },
]

const MAX_ATTRIBUTES = 100
const MAX_FUNNELS = 50
/** How long a funnel's result is reused before it's worked out again. */
const FUNNEL_CACHE_MS = 5 * 60_000

type FunnelRow = { id: string; name: string; steps: string; window_days: number; created_at: string; updated_at: string }
const toFunnel = (r: FunnelRow): Funnel => ({
  id: r.id,
  name: r.name,
  steps: JSON.parse(r.steps) as Funnel['steps'],
  windowDays: r.window_days,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})
const DAY = 86_400_000

type PersonRow = {
  id: string
  kind: 'user' | 'lead' | 'contact'
  domain: string
  external_id: string | null
  anonymous_id: string | null
  name: string | null
  email: string | null
  phone: string | null
  source: string
  attributes: string
  first_seen_at: string
  last_seen_at: string
  created_at: string
  updated_at: string
  owner_member_id: string | null
  metrics: string
}
type EventRow = {
  id: number
  type: EventType
  name: string
  properties: string
  url: string | null
  session_id: string | null
  occurred_at: string
}
type SessionRow = { id: string; person_id: string }
type FeedRow = EventRow & {
  path: string | null
  domain: string | null
  person_id: string
  kind: 'user' | 'lead' | 'contact'
  person_name: string | null
  email: string | null
  external_id: string | null
  anonymous_id: string | null
}

/** `mailboxIds`: the mailboxes whose email events the viewer may see (they can read the mail); 'all' for none hidden. */
export type EventQuery = { domain?: string; type?: EventType; q?: string; before?: number; after?: number; limit: number; mailboxIds: string[] | 'all' }

/** Email events of mailboxes the viewer can't read stay hidden, like the mail itself. */
function emailScope(mailboxIds: string[] | 'all'): { sql: string; args: Binding[] } | null {
  if (mailboxIds === 'all') return null
  if (!mailboxIds.length) return { sql: "e.type <> 'email'", args: [] }
  return { sql: `(e.type <> 'email' OR json_extract(e.properties, '$.mailbox_id') IN (${mailboxIds.map(() => '?').join(', ')}))`, args: mailboxIds }
}
type SegmentRow = { id: string; name: string; icon: SegmentIcon; filter: string; created_at: string; updated_at: string }
type Binding = string | number | null

/** `other`: list the viewer's own auto-saved "Other contacts" instead of the people and contacts lists show. */
export type ListQuery = { segmentId?: string; filter?: Filter; domain?: string; q?: string; other?: boolean; cursor?: string; limit: number; viewer: Viewer }

const toPerson = (r: PersonRow): Person => ({
  id: r.id,
  kind: r.kind,
  domain: r.domain,
  externalId: r.external_id,
  anonymousId: r.anonymous_id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  source: r.source,
  attributes: JSON.parse(r.attributes) as Attributes,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  metrics: JSON.parse(r.metrics || '{}') as Attributes,
  ...(r.kind === 'contact' && { owner: r.owner_member_id }),
})

const toFeedEvent = (r: FeedRow): FeedEvent => ({
  ...toEvent(r),
  path: r.path,
  domain: r.domain,
  person: { id: r.person_id, kind: r.kind, name: r.person_name, email: r.email, externalId: r.external_id, anonymousId: r.anonymous_id },
})

/** The dashboard scopes by the organization's mail domain (acme.com), which covers its sites (www.acme.com). */
const domainMatch = (col: string) => `(${col} = ? OR substr(${col}, -length(?) - 1) = '.' || ?)`

const toEvent = (e: EventRow): AudienceEvent => ({
  id: e.id,
  type: e.type,
  name: e.name,
  properties: JSON.parse(e.properties) as Record<string, unknown>,
  url: e.url,
  sessionId: e.session_id,
  occurredAt: e.occurred_at,
})

const toSegment = (r: SegmentRow): Segment => ({
  id: r.id,
  name: r.name,
  icon: r.icon,
  filter: JSON.parse(r.filter) as Filter,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const daysAgo = (n: number, now = Date.now()) => new Date(now - n * DAY).toISOString()
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`

export class AudienceStore extends DurableObject<Env> {
  private sql: SqlStorage
  private settings: AnalyticsSettings = DEFAULT_SETTINGS
  /** The organization's domains as last stored in `sites`, joined; null until first read. */
  private sitesKey: string | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA)
      const version = (await ctx.storage.get<number>('schema_version')) ?? 0
      for (let v = version; v < UPGRADES.length; v++) {
        ctx.storage.transactionSync(() => UPGRADES[v]!(this.sql))
        await ctx.storage.put('schema_version', v + 1)
      }
      if (this.one<{ n: number }>('SELECT count(*) AS n FROM segments')!.n === 0 && !(await ctx.storage.get('seeded'))) {
        const now = new Date().toISOString()
        STARTER_SEGMENTS.forEach((s, i) =>
          this.sql.exec('INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?)', newId('seg'), s.name, s.icon, JSON.stringify(s.filter), i, now, now),
        )
        await ctx.storage.put('seeded', true)
      }
      this.settings = { ...DEFAULT_SETTINGS, ...(await ctx.storage.get<Partial<AnalyticsSettings>>('analytics_settings')) }
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + DAY)
    })
  }

  private all<T>(query: string, ...bindings: Binding[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[]
  }

  private one<T>(query: string, ...bindings: Binding[]): T | null {
    return (this.sql.exec(query, ...bindings).toArray()[0] as T | undefined) ?? null
  }

  // -------------------------------------------------------------------------------------------------------------
  // Retention: once a day, drop old events and anonymous visitors who haven't come back.

  override async alarm(): Promise<void> {
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM events WHERE occurred_at < ?', daysAgo(EVENT_RETENTION_DAYS, now))
      // Visits outlive events (the Overview compares 90 days with the 90 before), but not their IP addresses.
      this.sql.exec('DELETE FROM sessions WHERE ended_at < ?', daysAgo(SESSION_RETENTION_DAYS, now))
      this.sql.exec('UPDATE sessions SET ip = NULL WHERE ip IS NOT NULL AND ended_at < ?', daysAgo(EVENT_RETENTION_DAYS, now))
      const stale = this.all<{ id: string }>(
        "SELECT id FROM people WHERE kind = 'lead' AND email IS NULL AND phone IS NULL AND last_seen_at < ?",
        daysAgo(ANONYMOUS_RETENTION_DAYS, now),
      )
      for (const { id } of stale) this.removePerson(id)
    })
    await this.ctx.storage.setAlarm(now + DAY)
  }

  private removePerson(id: string) {
    this.sql.exec('DELETE FROM events WHERE person_id = ?', id)
    this.sql.exec('DELETE FROM aliases WHERE person_id = ?', id)
    this.sql.exec('DELETE FROM sessions WHERE person_id = ?', id)
    this.sql.exec('DELETE FROM people WHERE id = ?', id)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Settings

  async getSettings(): Promise<AnalyticsSettings> {
    return this.settings
  }

  /** Turning IP addresses off also removes the ones already kept. */
  async setSettings(patch: Partial<AnalyticsSettings>): Promise<AnalyticsSettings> {
    this.settings = { ...this.settings, ...patch }
    await this.ctx.storage.put('analytics_settings', this.settings)
    if (!this.settings.storeIp) this.sql.exec('UPDATE sessions SET ip = NULL WHERE ip IS NOT NULL')
    return this.settings
  }

  // -------------------------------------------------------------------------------------------------------------
  // Collect: identify, track and page calls from the snippet or the server API.

  async collect(batch: CollectBatch): Promise<{ accepted: number }> {
    let accepted = 0
    this.ctx.storage.transactionSync(() => {
      this.useSites(batch.sites)
      for (const item of batch.items) {
        if (this.collectOne(item, batch)) accepted++
      }
    })
    return { accepted }
  }

  /** The organization's domains changed (or were never stored): keep the new list and move people onto it. */
  private useSites(sites: string[]) {
    const key = sites.join(' ')
    if (key === this.sitesKey) return
    if (this.storedSites().join(' ') !== key) {
      this.sql.exec('DELETE FROM sites')
      for (const name of sites) this.sql.exec('INSERT INTO sites VALUES (?)', name)
      this.rekey(sites)
    }
    this.sitesKey = key
  }

  private storedSites(): string[] {
    return this.all<{ name: string }>('SELECT name FROM sites ORDER BY name').map((r) => r.name)
  }

  /**
   * Moves website people and visitor ids from a hostname (app.acme.com) to its site (acme.com). Where the site
   * already has the same person (same user id, or the same email), the two become one, the user keeping the history
   * of the lead. Two different users who share an email stay where they are, on their hostname.
   */
  private rekey(sites: string[]) {
    const domains = this.all<{ domain: string }>("SELECT DISTINCT domain FROM people WHERE kind <> 'contact' AND domain <> ''")
    for (const { domain } of domains) {
      const site = siteOf(domain, sites)
      if (site === domain) continue
      const ids = this.all<{ id: string }>("SELECT id FROM people WHERE kind <> 'contact' AND domain = ? ORDER BY first_seen_at", domain)
      for (const { id } of ids) {
        const current = this.one<PersonRow>('SELECT * FROM people WHERE id = ?', id)
        if (!current) continue
        const twins = this.all<PersonRow>(
          `SELECT * FROM people WHERE domain = ? AND kind <> 'contact'
           AND ((external_id IS NOT NULL AND external_id = ?) OR (email IS NOT NULL AND email = ?))`,
          site,
          current.external_id,
          current.email,
        )
        const group = [current, ...twins]
        const users = group.filter((p) => p.kind === 'user')
        if (new Set(users.map((u) => u.external_id)).size > 1) continue
        const byAge = (a: PersonRow, b: PersonRow) => (a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : 0)
        const keeper = (users.length ? users : group).slice().sort(byAge)[0]!
        for (const p of group) {
          if (p.id === keeper.id) continue
          this.merge(this.one<PersonRow>('SELECT * FROM people WHERE id = ?', p.id)!, this.one<PersonRow>('SELECT * FROM people WHERE id = ?', keeper.id)!)
        }
        this.sql.exec('UPDATE people SET domain = ? WHERE id = ?', site, keeper.id)
      }
      // A visitor id seen on both the hostname and the site keeps the site's person.
      this.sql.exec('UPDATE OR IGNORE aliases SET domain = ? WHERE domain = ?', site, domain)
      this.sql.exec('DELETE FROM aliases WHERE domain = ?', domain)
    }
  }

  private collectOne(item: CollectItem, batch: CollectBatch): boolean {
    const person = item.type === 'identify' ? this.identify(item, batch) : this.resolve(item, batch)
    if (!person) return false
    if (item.type === 'page_leave') {
      this.pageLeave(person.id, item)
      this.sql.exec('UPDATE people SET last_seen_at = max(last_seen_at, ?) WHERE id = ?', item.at, person.id)
      return true
    }
    const visit = this.visit(person.id, item)
    const name = item.type === 'page' ? PAGEVIEW : item.type === 'identify' ? IDENTIFY : item.event!
    // identify() keeps what it was told (traits) as the event's properties.
    const properties = item.type === 'identify' ? item.traits : item.properties
    this.sql.exec(
      'INSERT INTO events (person_id, type, name, properties, url, domain, session_id, path, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      person.id,
      item.type,
      name,
      JSON.stringify(properties),
      item.url,
      item.domain,
      visit.id,
      item.context.path ?? null,
      item.at,
    )
    this.sql.exec(
      'INSERT INTO event_names VALUES (?, 1, ?) ON CONFLICT (name) DO UPDATE SET total = total + 1, last_at = max(last_at, excluded.last_at)',
      name,
      item.at,
    )
    this.creditRevenue(person.id, item, visit.id)
    const current = this.one<{ metrics: string }>('SELECT metrics FROM people WHERE id = ?', person.id)!
    const metrics = applyEvent(JSON.parse(current.metrics) as Metrics, item, { newSession: visit.created })
    this.sql.exec('UPDATE people SET last_seen_at = max(last_seen_at, ?), metrics = ? WHERE id = ?', item.at, JSON.stringify(metrics), person.id)
    return true
  }

  /**
   * Revenue (a numeric "revenue" property) counts on the visit it happened in. A server call has no visit, so its
   * order counts on the person's latest visit from the 30 days before: that's the visit that brought them.
   */
  private creditRevenue(personId: string, item: CollectItem, visitId: string | null) {
    if (item.type !== 'track' || item.properties.revenue === undefined || item.properties.revenue === '') return
    const revenue = Number(item.properties.revenue)
    if (!Number.isFinite(revenue)) return
    const target =
      visitId ??
      this.one<{ id: string }>(
        'SELECT id FROM sessions WHERE person_id = ? AND started_at <= ? AND started_at >= ? ORDER BY started_at DESC LIMIT 1',
        personId,
        item.at,
        new Date(Date.parse(item.at) - 30 * DAY).toISOString(),
      )?.id
    if (target) this.sql.exec('UPDATE sessions SET revenue = revenue + ?, orders = orders + 1 WHERE id = ?', revenue, target)
  }

  /**
   * The visit an event belongs to, opened on first sight. A session id that already belongs to someone else (a
   * forged or reused id) is ignored rather than mixing two people's visits.
   */
  private visit(personId: string, item: CollectItem): { id: string | null; created: boolean } {
    const ctx = item.context
    if (!ctx.sessionId) return { id: null, created: false }
    const existing = this.one<SessionRow>('SELECT id, person_id FROM sessions WHERE id = ?', ctx.sessionId)
    const page = item.type === 'page' ? 1 : 0
    if (existing) {
      if (existing.person_id !== personId) return { id: null, created: false }
      this.sql.exec(
        `UPDATE sessions SET ended_at = max(ended_at, ?), started_at = min(started_at, ?), pageviews = pageviews + ?, events = events + 1,
         exit_path = CASE WHEN ? = 1 AND ? >= ended_at THEN ? ELSE exit_path END WHERE id = ?`,
        item.at,
        item.at,
        page,
        page,
        item.at,
        ctx.path ?? null,
        ctx.sessionId,
      )
      return { id: ctx.sessionId, created: false }
    }
    const c = ctx.campaign
    this.sql.exec(
      `INSERT INTO sessions (id, person_id, domain, started_at, ended_at, pageviews, events, landing_path, exit_path, channel, referrer,
         referring_domain, utm_source, utm_medium, utm_campaign, utm_term, utm_content, click_id, ip, country, region, city, postal_code,
         timezone, latitude, longitude, continent, asn, as_org, browser, browser_version, os, os_version, device_type, screen, viewport,
         locale, library)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.sessionId,
      personId,
      item.domain,
      item.at,
      item.at,
      page,
      page ? (ctx.path ?? null) : null,
      page ? (ctx.path ?? null) : null,
      ctx.channel ?? 'Direct',
      ctx.referrer ?? null,
      ctx.referringDomain ?? null,
      c?.source ?? null,
      c?.medium ?? null,
      c?.name ?? null,
      c?.term ?? null,
      c?.content ?? null,
      ctx.clickId ?? null,
      this.settings.storeIp ? (ctx.ip ?? null) : null,
      ctx.country ?? null,
      ctx.region ?? null,
      ctx.city ?? null,
      ctx.postalCode ?? null,
      ctx.timezone ?? null,
      ctx.latitude ?? null,
      ctx.longitude ?? null,
      ctx.continent ?? null,
      ctx.asn ?? null,
      ctx.asOrganization ?? null,
      ctx.browser ?? null,
      ctx.browserVersion ?? null,
      ctx.os ?? null,
      ctx.osVersion ?? null,
      ctx.deviceType ?? null,
      ctx.screen ?? null,
      ctx.viewport ?? null,
      ctx.locale ?? null,
      ctx.library ?? null,
    )
    return { id: ctx.sessionId, created: true }
  }

  /**
   * Time on a page and scroll depth, from the snippet when the visitor leaves it. Updates the latest view of that
   * page in the visit; the snippet may send it more than once (tab hidden, then closed), so only growth counts.
   */
  private pageLeave(personId: string, item: CollectItem) {
    const ctx = item.context
    const ms = Math.min(Math.max(0, Math.round(Number(item.properties.duration_ms) || 0)), 6 * 3_600_000)
    const scroll = Math.min(100, Math.max(0, Math.round(Number(item.properties.scroll_depth) || 0)))
    if (!ctx.sessionId || !ctx.path) return
    const view = this.one<{ id: number; ms: number | null; scroll: number | null }>(
      `SELECT id, json_extract(properties, '$.duration_ms') AS ms, json_extract(properties, '$.scroll_depth') AS scroll FROM events
       WHERE session_id = ? AND person_id = ? AND name = ? AND path = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      ctx.sessionId,
      personId,
      PAGEVIEW,
      ctx.path,
    )
    if (!view) return
    const added = ms - (view.ms ?? 0)
    if (added <= 0 && scroll <= (view.scroll ?? 0)) return
    this.sql.exec(
      "UPDATE events SET properties = json_set(properties, '$.duration_ms', CAST(? AS INTEGER), '$.scroll_depth', CAST(? AS INTEGER)) WHERE id = ?",
      Math.max(ms, view.ms ?? 0),
      Math.max(scroll, view.scroll ?? 0),
      view.id,
    )
    if (added > 0) {
      this.sql.exec('UPDATE sessions SET engaged_ms = engaged_ms + ?, ended_at = max(ended_at, ?) WHERE id = ?', added, item.at, ctx.sessionId)
      const current = this.one<{ metrics: string }>('SELECT metrics FROM people WHERE id = ?', personId)!
      this.sql.exec('UPDATE people SET metrics = ? WHERE id = ?', JSON.stringify(addEngagement(JSON.parse(current.metrics) as Metrics, added)), personId)
    }
  }

  private byExternal(domain: string, externalId: string) {
    return this.one<PersonRow>('SELECT * FROM people WHERE domain = ? AND external_id = ?', domain, externalId)
  }

  private byAlias(domain: string, anonymousId: string) {
    return this.one<PersonRow>(
      'SELECT p.* FROM aliases a JOIN people p ON p.id = a.person_id WHERE a.domain = ? AND a.anonymous_id = ?',
      domain,
      anonymousId,
    )
  }

  private byEmail(domain: string, email: string) {
    return this.one<PersonRow>('SELECT * FROM people WHERE domain = ? AND email = ?', domain, email)
  }

  private alias(domain: string, anonymousId: string | null, personId: string) {
    if (!anonymousId) return
    this.sql.exec(
      'INSERT INTO aliases VALUES (?, ?, ?) ON CONFLICT (domain, anonymous_id) DO UPDATE SET person_id = excluded.person_id',
      domain,
      anonymousId,
      personId,
    )
  }

  private create(fields: {
    kind: 'user' | 'lead' | 'contact'
    domain: string
    externalId?: string | null
    anonymousId?: string | null
    email?: string | null
    source: string
    at: string
    ownerMemberId?: string | null
  }): PersonRow {
    const id = newId('per')
    const now = new Date().toISOString()
    this.sql.exec(
      `INSERT INTO people (id, kind, domain, external_id, anonymous_id, email, source, first_seen_at, last_seen_at, created_at, updated_at, owner_member_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      fields.kind,
      fields.domain,
      fields.externalId ?? null,
      fields.anonymousId ?? null,
      fields.email ?? null,
      fields.source,
      fields.at,
      fields.at,
      now,
      now,
      fields.ownerMemberId ?? null,
    )
    this.alias(fields.domain, fields.anonymousId ?? null, id)
    return this.one<PersonRow>('SELECT * FROM people WHERE id = ?', id)!
  }

  /** The person a track or page call is about, created as an anonymous lead if new. */
  private resolve(item: CollectItem, batch: CollectBatch): PersonRow | null {
    const { site: domain, anonymousId, userId, email } = item
    if (userId) {
      const user = this.byExternal(domain, userId) ?? this.create({ kind: 'user', domain, externalId: userId, anonymousId, source: batch.source, at: item.at })
      this.alias(domain, anonymousId, user.id)
      return user
    }
    if (anonymousId) return this.byAlias(domain, anonymousId) ?? this.create({ kind: 'lead', domain, anonymousId, source: batch.source, at: item.at })
    if (email && batch.trusted) return this.byEmail(domain, email) ?? this.create({ kind: 'lead', domain, email, source: batch.source, at: item.at })
    return null
  }

  /**
   * identify(): ties a visitor to a known user (when userId is trusted) and records traits. A lead that becomes a
   * user keeps its history; if that user already exists, the lead's history moves to it and the lead is deleted.
   */
  private identify(item: CollectItem, batch: CollectBatch): PersonRow | null {
    const { site: domain, anonymousId, userId, at } = item
    let person: PersonRow | null
    if (userId) {
      const user = this.byExternal(domain, userId)
      const lead = anonymousId ? this.byAlias(domain, anonymousId) : null
      if (user && lead && lead.id !== user.id && lead.kind === 'lead') {
        this.merge(lead, user)
        person = user
      } else if (user) {
        person = user
      } else if (lead && lead.kind === 'lead') {
        const metrics = JSON.stringify(identified(JSON.parse(lead.metrics) as Metrics, at, lead.first_seen_at))
        this.sql.exec("UPDATE people SET kind = 'user', external_id = ?, metrics = ?, updated_at = ? WHERE id = ?", userId, metrics, new Date().toISOString(), lead.id)
        person = { ...lead, kind: 'user', external_id: userId, metrics }
      } else {
        person = this.create({ kind: 'user', domain, externalId: userId, anonymousId, source: this.sourceOf(item, batch), at })
      }
      this.alias(domain, anonymousId, person.id)
    } else {
      person = this.resolve(item, batch)
      if (!person) return null
    }
    // A browser without a user hash can describe its own anonymous lead, but not change who a user is.
    const canChangeContact = batch.trusted || !!userId || person.kind === 'lead'
    this.applyTraits(person, item.traits, canChangeContact, batch.trusted)
    return person
  }

  private sourceOf(item: CollectItem, batch: CollectBatch): string {
    const s = item.traits.source
    return typeof s === 'string' && s.trim() ? s.trim().slice(0, 40) : batch.source
  }

  private merge(from: PersonRow, into: PersonRow) {
    this.sql.exec('UPDATE events SET person_id = ? WHERE person_id = ?', into.id, from.id)
    this.sql.exec('UPDATE aliases SET person_id = ? WHERE person_id = ?', into.id, from.id)
    this.sql.exec('UPDATE sessions SET person_id = ? WHERE person_id = ?', into.id, from.id)
    const metrics = mergeMetrics(JSON.parse(from.metrics) as Metrics, JSON.parse(into.metrics) as Metrics, from.first_seen_at < into.first_seen_at)
    const attrs = { ...(JSON.parse(from.attributes) as Attributes), ...(JSON.parse(into.attributes) as Attributes) }
    this.sql.exec('DELETE FROM people WHERE id = ?', from.id)
    this.sql.exec(
      `UPDATE people SET name = coalesce(name, ?), phone = coalesce(phone, ?), attributes = ?, first_seen_at = min(first_seen_at, ?),
       last_seen_at = max(last_seen_at, ?), metrics = ?, updated_at = ? WHERE id = ?`,
      from.name,
      from.phone,
      JSON.stringify(attrs),
      from.first_seen_at,
      from.last_seen_at,
      JSON.stringify(metrics),
      new Date().toISOString(),
      into.id,
    )
    if (from.email && !into.email && !this.byEmail(into.domain, from.email)) this.sql.exec('UPDATE people SET email = ? WHERE id = ?', from.email, into.id)
  }

  private applyTraits(person: PersonRow, traits: Record<string, unknown>, canChangeContact: boolean, trusted: boolean) {
    const fields: PersonFields = { attributes: {} }
    for (const [key, raw] of Object.entries(traits)) {
      if (key === 'source' || key === 'userId' || key === 'anonymousId') continue
      if (key === 'name' || key === 'email' || key === 'phone') {
        if (!canChangeContact || (raw !== null && typeof raw !== 'string')) continue
        const value = typeof raw === 'string' ? raw.trim().slice(0, key === 'name' ? 200 : 254) : null
        if (key === 'email') {
          const email = value?.toLowerCase() ?? null
          if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue
          fields.email = email
        } else fields[key] = value || null
        continue
      }
      if (!/^[A-Za-z0-9_ .-]{1,64}$/.test(key)) continue
      if (raw === null || typeof raw === 'number' || typeof raw === 'boolean') fields.attributes![key] = raw as never
      else if (typeof raw === 'string') fields.attributes![key] = raw.slice(0, 500)
    }
    // An email that belongs to someone else is left alone: only the server may merge people.
    if (fields.email && fields.email !== person.email && this.byEmail(person.domain, fields.email)) delete fields.email
    if (!trusted && fields.email === null) delete fields.email
    this.update(person, fields)
  }

  private update(person: PersonRow, fields: PersonFields) {
    const attrs = JSON.parse(person.attributes) as Attributes
    for (const [key, value] of Object.entries(fields.attributes ?? {})) {
      if (value === null) delete attrs[key]
      else if (key in attrs || Object.keys(attrs).length < MAX_ATTRIBUTES) {
        attrs[key] = value
        this.sql.exec(
          'INSERT INTO attribute_defs VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING',
          key,
          typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string',
          new Date().toISOString(),
        )
      }
    }
    this.sql.exec(
      'UPDATE people SET name = ?, email = ?, phone = ?, attributes = ?, updated_at = ? WHERE id = ?',
      fields.name === undefined ? person.name : fields.name,
      fields.email === undefined ? person.email : fields.email,
      fields.phone === undefined ? person.phone : fields.phone,
      JSON.stringify(attrs),
      new Date().toISOString(),
      person.id,
    )
  }

  // -------------------------------------------------------------------------------------------------------------
  // Email: mail between the organization's mailboxes and people already in the audience (audience/email.ts).

  /**
   * Records `$email_<kind>` on every website person with one of these addresses (on any of the organization's
   * sites). Addresses nobody has are ignored: mail alone never adds anyone. Properties name the mailbox, never
   * the subject or body. Returns how many events were recorded.
   */
  async recordEmail(input: EmailActivity): Promise<number> {
    const name = `$email_${input.kind}`
    const addresses = [...new Set(input.addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))].slice(0, 50)
    if (!addresses.length) return 0
    const properties: Record<string, unknown> = { mailbox: input.mailbox, mailbox_id: input.mailboxId }
    if (input.emailId) properties.email_id = input.emailId
    if (input.detail) properties.detail = input.detail.slice(0, 200)
    // Mail from the person is them being active; mail to them isn't.
    const active = input.kind === 'received' || input.kind === 'replied'
    let n = 0
    this.ctx.storage.transactionSync(() => {
      const people = this.all<PersonRow>(
        `SELECT * FROM people WHERE kind <> 'contact' AND email IN (${addresses.map(() => '?').join(', ')})`,
        ...addresses,
      )
      for (const p of people) {
        if (
          input.emailId &&
          this.one("SELECT 1 FROM events WHERE person_id = ? AND name = ? AND json_extract(properties, '$.email_id') = ?", p.id, name, input.emailId)
        ) continue
        this.sql.exec(
          "INSERT INTO events (person_id, type, name, properties, url, domain, session_id, path, occurred_at) VALUES (?, 'email', ?, ?, NULL, ?, NULL, NULL, ?)",
          p.id,
          name,
          JSON.stringify({ ...properties, address: p.email }),
          p.domain,
          input.at,
        )
        this.sql.exec(
          'INSERT INTO event_names VALUES (?, 1, ?) ON CONFLICT (name) DO UPDATE SET total = total + 1, last_at = max(last_at, excluded.last_at)',
          name,
          input.at,
        )
        const metrics = JSON.stringify(applyEmail(JSON.parse(p.metrics) as Metrics, input.kind, input.at))
        if (active) this.sql.exec('UPDATE people SET metrics = ?, last_seen_at = max(last_seen_at, ?) WHERE id = ?', metrics, input.at, p.id)
        else this.sql.exec('UPDATE people SET metrics = ? WHERE id = ?', metrics, p.id)
        n++
      }
    })
    return n
  }

  // -------------------------------------------------------------------------------------------------------------
  // Overview (overview.ts). Results are kept a minute: the page asks for the same thing on every tab switch.

  private overviewCache = new Map<string, { at: number; value: unknown }>()

  private cached<T>(key: string, compute: () => T): T {
    const hit = this.overviewCache.get(key)
    if (hit && Date.now() - hit.at < 60_000) return hit.value as T
    const value = compute()
    if (this.overviewCache.size > 100) this.overviewCache.clear()
    this.overviewCache.set(key, { at: Date.now(), value })
    return value
  }

  /** Totals for the period and the one before, a series for the chart and sparklines, and visitors right now. */
  async trafficOverview(q: { range: OverviewRange; tzOffset: number; domain?: string; filters: OverviewFilter[] }) {
    return this.cached(`o|${JSON.stringify(q)}`, () => {
      const p = periodOf(q.range, q.tzOffset)
      type Totals = { visitors: number; visits: number; pageviews: number; bounces: number; seconds: number; revenue: number; orders: number }
      type Bucket = Totals & { b: string }
      const kpis = (t: Totals) => ({
        visitors: t.visitors,
        visits: t.visits,
        pageviews: t.pageviews,
        bounceRate: t.visits ? t.bounces / t.visits : 0,
        avgDuration: t.visits ? Math.round(t.seconds / t.visits) : 0,
        revenue: Math.round(t.revenue * 100) / 100,
        orders: t.orders,
      })
      const totals = (from: string, to: string) => {
        const w = sessionWhere(from, to, q.domain, q.filters)
        const t = totalsQuery(w)
        return kpis(this.one<Totals>(t.sql, ...t.args)!)
      }
      const series = (from: string, to: string, labels: string[]) => {
        const s = seriesQuery(sessionWhere(from, to, q.domain, q.filters), p.bucket, p.shift)
        const rows = new Map(this.all<Bucket>(s.sql, ...s.args).map((r) => [r.b, r]))
        return labels.map((b) => ({ t: b, ...kpis(rows.get(b) ?? { visitors: 0, visits: 0, pageviews: 0, bounces: 0, seconds: 0, revenue: 0, orders: 0 }) }))
      }
      const since = new Date(Date.now() - 5 * 60_000).toISOString()
      const live = this.one<{ n: number }>(
        `SELECT count(DISTINCT person_id) AS n FROM events WHERE occurred_at >= ? AND type IN ('page', 'track')${q.domain ? " AND (domain = ? OR substr(domain, -length(?) - 1) = '.' || ?)" : ''}`,
        since,
        ...(q.domain ? [q.domain, q.domain, q.domain] : []),
      )!.n
      return {
        range: q.range,
        bucket: p.bucket,
        from: p.from,
        to: p.to,
        current: totals(p.from, p.to),
        previous: totals(p.prevFrom, p.prevTo),
        series: series(p.from, p.to, p.buckets),
        previousSeries: series(p.prevFrom, p.prevTo, p.prevBuckets),
        live,
      }
    })
  }

  /** The top values of each dimension (`limit` each), or of one (`dimension`, for View all). Shares are of all visitors. */
  async trafficBreakdown(q: { range: OverviewRange; tzOffset: number; domain?: string; filters: OverviewFilter[]; dimensions: Dimension[]; limit: number }) {
    return this.cached(`b|${JSON.stringify(q)}`, () => {
      const p = periodOf(q.range, q.tzOffset)
      const where = sessionWhere(p.from, p.to, q.domain, q.filters)
      const t = totalsQuery(where)
      const total = this.one<{ visitors: number; visits: number }>(t.sql, ...t.args)!
      type Row = { key: string; visitors: number; visits: number; count?: number; revenue?: number; orders?: number; converted?: number }
      const lists: Partial<Record<Dimension, Row[]>> = {}
      for (const dim of q.dimensions) {
        const b = breakdownQuery(dim, where, q.limit, p.from, p.to)
        lists[dim] = this.all<Row>(b.sql, ...b.args).map((r) => ({ ...r, revenue: r.revenue === undefined ? undefined : Math.round(r.revenue * 100) / 100 }))
      }
      return { visitors: total.visitors, visits: total.visits, lists }
    })
  }

  // -------------------------------------------------------------------------------------------------------------
  // Funnels

  /** Every funnel, with its conversion over the last 30 days (from the cache when fresh) for the side list. */
  async listFunnels(domain?: string): Promise<(Funnel & { conversion: number })[]> {
    return this.all<FunnelRow>('SELECT * FROM funnels ORDER BY position, created_at')
      .map(toFunnel)
      .map((f) => ({ ...f, conversion: this.funnelResult(f, 30, domain).conversion }))
  }

  async getFunnel(id: string): Promise<Funnel | null> {
    const row = this.one<FunnelRow>('SELECT * FROM funnels WHERE id = ?', id)
    return row ? toFunnel(row) : null
  }

  /** Creates a funnel, or replaces one (`id`). Null when that funnel doesn't exist; 'full' at the limit. */
  async saveFunnel(input: FunnelInput & { id?: string }): Promise<Funnel | null | 'full'> {
    const now = new Date().toISOString()
    if (input.id) {
      if (!this.one('SELECT 1 FROM funnels WHERE id = ?', input.id)) return null
      this.sql.exec('UPDATE funnels SET name = ?, steps = ?, window_days = ?, updated_at = ? WHERE id = ?', input.name, JSON.stringify(input.steps), input.windowDays, now, input.id)
      this.sql.exec('DELETE FROM funnel_cache WHERE funnel_id = ?', input.id)
      return this.getFunnel(input.id)
    }
    if (this.one<{ n: number }>('SELECT count(*) AS n FROM funnels')!.n >= MAX_FUNNELS) return 'full'
    const id = newId('fun')
    const position = this.one<{ n: number }>('SELECT coalesce(max(position), -1) + 1 AS n FROM funnels')!.n
    this.sql.exec('INSERT INTO funnels VALUES (?, ?, ?, ?, ?, ?, ?)', id, input.name, JSON.stringify(input.steps), input.windowDays, position, now, now)
    return this.getFunnel(id)
  }

  async deleteFunnel(id: string): Promise<boolean> {
    const found = !!this.one('SELECT 1 FROM funnels WHERE id = ?', id)
    this.sql.exec('DELETE FROM funnels WHERE id = ?', id)
    this.sql.exec('DELETE FROM funnel_cache WHERE funnel_id = ?', id)
    return found
  }

  async computeFunnel(id: string, range: FunnelRange, domain?: string): Promise<{ funnel: Funnel; result: FunnelResult } | null> {
    const funnel = await this.getFunnel(id)
    return funnel ? { funnel, result: this.funnelResult(funnel, range, domain) } : null
  }

  private funnelResult(funnel: Funnel, range: FunnelRange, domain?: string): FunnelResult {
    const key = `${range}|${domain ?? ''}`
    const hit = this.one<{ result: string; computed_at: string }>('SELECT result, computed_at FROM funnel_cache WHERE funnel_id = ? AND key = ?', funnel.id, key)
    if (hit && Date.now() - Date.parse(hit.computed_at) < FUNNEL_CACHE_MS) return JSON.parse(hit.result) as FunnelResult
    const q = funnelQuery(funnel, daysAgo(range), domain)
    const result = summarize(this.all<Record<string, string | null>>(q.sql, ...q.args), funnel.steps.length, range)
    this.sql.exec(
      'INSERT INTO funnel_cache VALUES (?, ?, ?, ?) ON CONFLICT (funnel_id, key) DO UPDATE SET result = excluded.result, computed_at = excluded.computed_at',
      funnel.id,
      key,
      JSON.stringify(result),
      result.computedAt,
    )
    return result
  }

  /** What the funnel editor offers: event names seen (yours, not xstate's own), and the most viewed paths. */
  async funnelOptions(): Promise<{ events: string[]; paths: string[] }> {
    const events = this.all<{ name: string }>("SELECT name FROM event_names WHERE name NOT LIKE '$%' ORDER BY total DESC LIMIT 200").map((r) => r.name)
    const paths = this.all<{ path: string }>(
      "SELECT path, count(*) AS n FROM events WHERE name = '$pageview' AND path IS NOT NULL AND occurred_at >= ? GROUP BY path ORDER BY n DESC LIMIT 100",
      daysAgo(30),
    ).map((r) => r.path)
    return { events, paths }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Analytics: the event feed. Website events only (contacts never have events), so no viewer is needed.

  /** Whether any event has arrived yet (the install screen), and when the latest did. */
  async analyticsStatus(domain?: string): Promise<{ lastEventAt: string | null }> {
    const scope = domain ? `WHERE ${domainMatch('domain')}` : ''
    const row = this.one<{ at: string }>(`SELECT occurred_at AS at FROM events ${scope} ORDER BY id DESC LIMIT 1`, ...(domain ? [domain, domain, domain] : []))
    return { lastEventAt: row?.at ?? null }
  }

  /**
   * Events, newest first. `after`: only those that arrived after that id (the live feed's polling); `before`: the
   * page after that id. `recent` is how many events happened in the last five minutes.
   */
  async listEvents(query: EventQuery): Promise<{ events: FeedEvent[]; recent: number; nextBefore: number | null }> {
    const parts: string[] = []
    const args: Binding[] = []
    const scope = emailScope(query.mailboxIds)
    if (scope) {
      parts.push(scope.sql)
      args.push(...scope.args)
    }
    if (query.domain) {
      parts.push(domainMatch('e.domain'))
      args.push(query.domain, query.domain, query.domain)
    }
    if (query.type) {
      parts.push('e.type = ?')
      args.push(query.type)
    }
    const term = query.q?.trim().toLowerCase()
    if (term) {
      parts.push(
        `(instr(lower(e.name), ?) > 0 OR instr(lower(coalesce(e.path, '')), ?) > 0 OR instr(lower(coalesce(p.name, '')), ?) > 0
          OR instr(coalesce(p.email, ''), ?) > 0 OR instr(lower(coalesce(p.external_id, '')), ?) > 0 OR instr(lower(coalesce(p.anonymous_id, '')), ?) > 0)`,
      )
      args.push(term, term, term, term, term, term)
    }
    const filters = [...parts]
    const filterArgs = [...args]
    if (query.after !== undefined) {
      parts.push('e.id > ?')
      args.push(query.after)
    }
    if (query.before !== undefined) {
      parts.push('e.id < ?')
      args.push(query.before)
    }
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : ''
    const rows = this.all<FeedRow>(
      `SELECT e.id, e.type, e.name, e.properties, e.url, e.session_id, e.occurred_at, e.path, e.domain, e.person_id,
         p.kind, p.name AS person_name, p.email, p.external_id, p.anonymous_id
       FROM events e JOIN people p ON p.id = e.person_id ${where} ORDER BY e.id DESC LIMIT ?`,
      ...args,
      query.limit + 1,
    )
    const more = rows.length > query.limit
    const events = rows.slice(0, query.limit).map(toFeedEvent)
    const since = new Date(Date.now() - 5 * 60_000).toISOString()
    const recentWhere = [...filters, 'e.occurred_at >= ?'].join(' AND ')
    const recent = this.one<{ n: number }>(
      `SELECT count(*) AS n FROM events e ${term ? 'JOIN people p ON p.id = e.person_id' : ''} WHERE ${recentWhere}`,
      ...filterArgs,
      since,
    )!.n
    return { events, recent, nextBefore: more && query.after === undefined ? (events.at(-1)?.id ?? null) : null }
  }

  /** One event with the visit it belongs to (where it came from, device, location). */
  async getEvent(id: number, mailboxIds: string[] | 'all'): Promise<{ event: FeedEvent; visit: VisitContext | null } | null> {
    const row = this.one<FeedRow>(
      `SELECT e.id, e.type, e.name, e.properties, e.url, e.session_id, e.occurred_at, e.path, e.domain, e.person_id,
         p.kind, p.name AS person_name, p.email, p.external_id, p.anonymous_id
       FROM events e JOIN people p ON p.id = e.person_id WHERE e.id = ?`,
      id,
    )
    if (!row) return null
    if (row.type === 'email' && mailboxIds !== 'all') {
      const mailboxId = (JSON.parse(row.properties) as { mailbox_id?: string }).mailbox_id
      if (!mailboxId || !mailboxIds.includes(mailboxId)) return null
    }
    const session = row.session_id ? this.one<Record<string, string | number | null>>('SELECT * FROM sessions WHERE id = ?', row.session_id) : null
    let visit: VisitContext | null = null
    if (session) {
      visit = {}
      for (const [k, v] of Object.entries(session)) if (v !== null && v !== '' && k !== 'person_id') visit[k] = v
    }
    return { event: toFeedEvent(row), visit }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Dashboard

  async overview(viewer: Viewer, domain?: string) {
    const all = this.where({ match: 'all', conditions: [] }, viewer)
    const scoped = domain ? this.where({ match: 'all', conditions: [] }, viewer, domain) : all
    const total = this.one<{ n: number }>(`SELECT count(*) AS n FROM people p WHERE ${scoped.sql}`, ...scoped.args)!.n
    const domains = this.all<{ domain: string; count: number }>(
      "SELECT domain, count(*) AS count FROM people WHERE kind <> 'contact' GROUP BY domain ORDER BY count DESC",
    )
    const contacts = this.one<{ n: number }>(
      `SELECT count(*) AS n FROM people p WHERE p.kind = 'contact' AND ${all.sql}`,
      ...all.args,
    )!.n
    const none = { match: 'all', conditions: [] } satisfies Filter
    const other = this.where(none, viewer, undefined, undefined, true)
    const otherContacts = this.one<{ n: number }>(`SELECT count(*) AS n FROM people p WHERE ${other.sql}`, ...other.args)!.n
    const segments = this.listSegments().map((s) => ({ ...s, count: this.count(s.filter, viewer, domain) }))
    return { total, domains, contacts, otherContacts, segments }
  }

  private listSegments(): Segment[] {
    return this.all<SegmentRow>('SELECT * FROM segments ORDER BY position, created_at').map(toSegment)
  }

  async schema() {
    return {
      attributes: this.all<{ key: string; type: string }>('SELECT key, type FROM attribute_defs ORDER BY key'),
      events: this.all<{ name: string; total: number; lastAt: string }>(
        'SELECT name, total, last_at AS lastAt FROM event_names ORDER BY total DESC LIMIT 200',
      ),
    }
  }

  /** How many people a filter matches (the builder's live count). */
  count(filter: Filter, viewer: Viewer, domain?: string): number {
    const where = this.where(filter, viewer, domain)
    return this.one<{ n: number }>(`SELECT count(*) AS n FROM people p WHERE ${where.sql}`, ...where.args)!.n
  }

  async listPeople(query: ListQuery) {
    const segment = query.segmentId ? this.one<SegmentRow>('SELECT * FROM segments WHERE id = ?', query.segmentId) : null
    if (query.segmentId && !segment) return null
    const filter = segment ? toSegment(segment).filter : (query.filter ?? { match: 'all', conditions: [] })
    const base = this.where(filter, query.viewer, query.domain, query.q, query.other)
    const total = this.one<{ n: number }>(`SELECT count(*) AS n FROM people p WHERE ${base.sql}`, ...base.args)!.n
    let sql = base.sql
    const args = [...base.args]
    if (query.cursor) {
      const [seen, id] = query.cursor.split('|')
      sql = `(${sql}) AND (p.last_seen_at < ? OR (p.last_seen_at = ? AND p.id < ?))`
      args.push(seen ?? '', seen ?? '', id ?? '')
    }
    const rows = this.all<PersonRow>(`SELECT p.* FROM people p WHERE ${sql} ORDER BY p.last_seen_at DESC, p.id DESC LIMIT ?`, ...args, query.limit + 1)
    const more = rows.length > query.limit
    const people = rows.slice(0, query.limit).map(toPerson)
    const last = people.at(-1)
    return { people, total, nextCursor: more && last ? `${last.lastSeenAt}|${last.id}` : null }
  }

  /** A person the viewer may see, or null. */
  private visible(id: string, viewer: Viewer): PersonRow | null {
    const row = this.one<PersonRow>('SELECT * FROM people WHERE id = ?', id)
    if (!row) return null
    if (row.kind === 'contact' && row.owner_member_id && row.owner_member_id !== viewer.memberId) return null
    return row
  }

  /** Website people and shared contacts need the manage permission; a member's own contacts are theirs to change. */
  private canChange(row: PersonRow, viewer: Viewer): boolean {
    if (row.kind === 'contact' && row.owner_member_id) return row.owner_member_id === viewer.memberId
    return viewer.manage
  }

  async getPerson(id: string, viewer: Viewer) {
    const row = this.visible(id, viewer)
    if (!row) return null
    const events = this.all<EventRow>(
      "SELECT id, type, name, properties, url, session_id, occurred_at FROM events WHERE person_id = ? AND type <> 'email' ORDER BY occurred_at DESC, id DESC LIMIT 100",
      id,
    ).map(toEvent)
    const segments = this.listSegments()
      .filter((s) => {
        const where = this.where(s.filter, viewer)
        return !!this.one(`SELECT 1 FROM people p WHERE p.id = ? AND (${where.sql})`, id, ...where.args)
      })
      .map((s) => ({ id: s.id, name: s.name }))
    const person = toPerson(row)
    // Browsers (visitor ids) the person has used; worked out here rather than kept up to date on every event.
    const devices = this.one<{ n: number }>('SELECT count(*) AS n FROM aliases WHERE person_id = ?', id)!.n
    if (devices) person.metrics.devices_used = devices
    return { person, events, segments }
  }

  async addPerson(
    input: { kind: 'lead' | 'contact'; domain: string; source: string; ownerMemberId?: string | null } & PersonFields,
  ): Promise<{ person?: Person; conflict?: string }> {
    const contact = input.kind === 'contact'
    input = { ...input, domain: contact ? '' : siteOf(input.domain, this.storedSites()) }
    if (input.email && !contact && this.byEmail(input.domain, input.email)) return { conflict: 'Someone with that email already exists on this domain' }
    if (input.email && contact && this.contactByEmail(input.ownerMemberId ?? null, input.email)) {
      return { conflict: input.ownerMemberId ? 'You already have a contact with that email' : 'There’s already a shared contact with that email' }
    }
    let person!: PersonRow
    this.ctx.storage.transactionSync(() => {
      const row = this.create({
        kind: input.kind,
        domain: contact ? '' : input.domain,
        email: input.email ?? null,
        source: input.source,
        at: new Date().toISOString(),
        ownerMemberId: contact ? (input.ownerMemberId ?? null) : null,
      })
      this.update(row, { name: input.name, phone: input.phone, attributes: input.attributes })
      person = this.one<PersonRow>('SELECT * FROM people WHERE id = ?', row.id)!
    })
    return { person: toPerson(person) }
  }

  async updatePerson(id: string, fields: PersonFields, viewer: Viewer): Promise<{ person?: Person; conflict?: string; forbidden?: true } | null> {
    const row = this.visible(id, viewer)
    if (!row) return null
    if (!this.canChange(row, viewer)) return { forbidden: true }
    if (fields.email && fields.email !== row.email) {
      const taken = row.kind === 'contact' ? this.contactByEmail(row.owner_member_id, fields.email) : this.byEmail(row.domain, fields.email)
      if (taken) return { conflict: row.kind === 'contact' ? 'There’s already a contact with that email' : 'Someone with that email already exists on this domain' }
    }
    this.ctx.storage.transactionSync(() => this.update(row, fields))
    return { person: toPerson(this.one<PersonRow>('SELECT * FROM people WHERE id = ?', id)!) }
  }

  /** Deletes the people the viewer may change; returns how many. */
  async deletePeople(ids: string[], viewer: Viewer): Promise<number> {
    let n = 0
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        const row = this.visible(id, viewer)
        if (!row || !this.canChange(row, viewer)) continue
        this.removePerson(id)
        n++
      }
    })
    return n
  }

  async saveSegment(input: { id?: string; name: string; icon?: SegmentIcon; filter: Filter }): Promise<Segment | null> {
    const now = new Date().toISOString()
    if (input.id) {
      const row = this.one<SegmentRow>('SELECT * FROM segments WHERE id = ?', input.id)
      if (!row) return null
      this.sql.exec(
        'UPDATE segments SET name = ?, icon = ?, filter = ?, updated_at = ? WHERE id = ?',
        input.name,
        input.icon ?? row.icon,
        JSON.stringify(input.filter),
        now,
        input.id,
      )
      return toSegment(this.one<SegmentRow>('SELECT * FROM segments WHERE id = ?', input.id)!)
    }
    const id = newId('seg')
    const position = this.one<{ n: number }>('SELECT coalesce(max(position), -1) + 1 AS n FROM segments')!.n
    this.sql.exec('INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?)', id, input.name, input.icon ?? 'layers', JSON.stringify(input.filter), position, now, now)
    return toSegment(this.one<SegmentRow>('SELECT * FROM segments WHERE id = ?', id)!)
  }

  async deleteSegment(id: string): Promise<boolean> {
    const found = !!this.one('SELECT 1 FROM segments WHERE id = ?', id)
    this.sql.exec('DELETE FROM segments WHERE id = ?', id)
    return found
  }

  /** Everyone a list view shows, for CSV export (capped). */
  // -------------------------------------------------------------------------------------------------------------
  // Contacts

  private contactByEmail(ownerMemberId: string | null, email: string) {
    return this.one<PersonRow>(
      "SELECT * FROM people WHERE kind = 'contact' AND coalesce(owner_member_id, '') = ? AND email = ?",
      ownerMemberId ?? '',
      email,
    )
  }

  /**
   * Adds contacts for one member (an import). A contact whose email the member already has is merged into it:
   * empty fields are filled and attributes added, nothing the member typed is overwritten. Returns one id per input.
   */
  async importContacts(
    ownerMemberId: string,
    contacts: { name: string | null; email: string | null; phone: string | null; attributes: Attributes }[],
    source: string,
  ): Promise<string[]> {
    const ids: string[] = []
    const at = new Date().toISOString()
    this.ctx.storage.transactionSync(() => {
      for (const c of contacts) {
        const email = c.email?.trim().toLowerCase() || null
        const existing = email ? this.contactByEmail(ownerMemberId, email) : null
        const row = existing ?? this.create({ kind: 'contact', domain: '', email, source, at, ownerMemberId })
        const attrs = JSON.parse(row.attributes) as Attributes
        const add = Object.fromEntries(Object.entries(c.attributes).filter(([k]) => !(k in attrs)))
        // A real contact found again among "Other contacts" stays a real contact.
        if (existing && !attrs.other) delete add.other
        if (existing && attrs.other && !c.attributes.other) add.other = false
        this.update(row, { name: row.name ?? c.name, phone: row.phone ?? c.phone, attributes: add })
        ids.push(row.id)
      }
    })
    return ids
  }

  /** Contacts the viewer can see whose name or email contains `q`, for compose: real contacts first. */
  /**
   * Which of these addresses are the organization's contacts (any member's, or shared), for the spam decision of
   * received mail (mailbox/spam.ts, layer 3). Contacts only: leads and identified users come from forms and sign-ups,
   * which anyone can fill in with their own address. Says only yes or no, so it needs no viewer.
   */
  async knows(addresses: string[]): Promise<string[]> {
    const list = [...new Set(addresses.map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 50)
    if (!list.length) return []
    return this.all<{ email: string }>(
      `SELECT DISTINCT email FROM people WHERE kind = 'contact' AND email IN (${list.map(() => '?').join(', ')})`,
      ...list,
    ).map((r) => r.email)
  }

  async suggest(viewer: Viewer, q: string, limit: number): Promise<{ name: string | null; email: string }[]> {
    const term = q.trim().toLowerCase()
    if (!term) return []
    return this.all<{ name: string | null; email: string }>(
      `SELECT name, email FROM people
       WHERE kind = 'contact' AND email IS NOT NULL AND (owner_member_id IS NULL OR owner_member_id = ?)
         AND (instr(lower(coalesce(name, '')), ?) > 0 OR instr(email, ?) > 0)
       ORDER BY coalesce(json_extract(attributes, '$.other'), 0), instr(email, ?) <> 1, name IS NULL, name COLLATE NOCASE
       LIMIT ?`,
      viewer.memberId,
      term,
      term,
      term,
      limit,
    )
  }

  async exportPeople(query: Omit<ListQuery, 'cursor' | 'limit'>): Promise<Person[] | null> {
    const result = await this.listPeople({ ...query, limit: 50_000 })
    return result?.people ?? null
  }

  // -------------------------------------------------------------------------------------------------------------
  // Filters → SQL. Every value is a bound parameter; attribute keys go into a JSON path that is itself bound.

  private where(filter: Filter, viewer: Viewer, domain?: string, q?: string, other = false): { sql: string; args: Binding[] } {
    // Other members' contacts are never shown, and auto-saved "Other contacts" stay out of lists and counts unless
    // asked for: then only the viewer's own (they're never shared).
    const parts: string[] = [
      other
        ? "(p.kind = 'contact' AND p.owner_member_id = ? AND coalesce(json_extract(p.attributes, '$.other'), 0) = 1)"
        : "(p.kind <> 'contact' OR ((p.owner_member_id IS NULL OR p.owner_member_id = ?) AND coalesce(json_extract(p.attributes, '$.other'), 0) = 0))",
    ]
    const args: Binding[] = [viewer.memberId]
    if (filter.conditions.length) {
      const compiled = filter.conditions.map((c) => this.compile(c))
      parts.push(`(${compiled.map((c) => `(${c.sql})`).join(filter.match === 'any' ? ' OR ' : ' AND ')})`)
      for (const c of compiled) args.push(...c.args)
    }
    if (domain) {
      // The dashboard scopes by the organization's mail domain (acme.com), which covers its sites (www.acme.com).
      parts.push("(p.domain = ? OR substr(p.domain, -length(?) - 1) = '.' || ?)")
      args.push(domain, domain, domain)
    }
    const term = q?.trim().toLowerCase()
    if (term) {
      parts.push(
        "(instr(lower(coalesce(p.name, '')), ?) > 0 OR instr(coalesce(p.email, ''), ?) > 0 OR instr(lower(coalesce(p.external_id, '')), ?) > 0 OR instr(lower(coalesce(p.anonymous_id, '')), ?) > 0 OR instr(coalesce(p.phone, ''), ?) > 0)",
      )
      args.push(term, term, term, term, term)
    }
    return { sql: parts.join(' AND '), args }
  }

  private compile(c: Condition): { sql: string; args: Binding[] } {
    switch (c.kind) {
      case 'date': {
        const col = { last_seen: 'p.last_seen_at', first_seen: 'p.first_seen_at', created: 'p.created_at' }[c.field]
        const cutoff = daysAgo(c.days)
        return c.op === 'within' ? { sql: `${col} >= ?`, args: [cutoff] } : { sql: `${col} < ?`, args: [cutoff] }
      }
      case 'type':
        return { sql: c.op === 'is' ? 'p.kind = ?' : 'p.kind <> ?', args: [c.value] }
      case 'text': {
        const col = `p.${c.field}`
        return textOp(`coalesce(${col}, '')`, c.op, c.value)
      }
      case 'attribute':
      case 'metric': {
        // Metrics (metrics.ts) are worked out by xstate and kept apart from the customer's attributes.
        const path = `$."${c.key}"`
        const val = c.kind === 'metric' ? 'json_extract(p.metrics, ?)' : 'json_extract(p.attributes, ?)'
        switch (c.op) {
          case 'is_set':
            return { sql: `${val} IS NOT NULL`, args: [path] }
          case 'not_set':
            return { sql: `${val} IS NULL`, args: [path] }
          case 'is_true':
            return { sql: `${val} = 1`, args: [path] }
          case 'is_false':
            return { sql: `coalesce(${val}, 0) = 0`, args: [path] }
          case 'gt':
            return { sql: `CAST(${val} AS REAL) > ?`, args: [path, Number(c.value)] }
          case 'lt':
            return { sql: `CAST(${val} AS REAL) < ?`, args: [path, Number(c.value)] }
          default: {
            const t = textOp(`lower(coalesce(CAST(${val} AS TEXT), ''))`, c.op, String(c.value))
            return { sql: t.sql, args: [path, ...t.args] }
          }
        }
      }
      case 'event': {
        const since = daysAgo(c.days)
        return c.op === 'at_least'
          ? { sql: '(SELECT count(*) FROM events e WHERE e.person_id = p.id AND e.name = ? AND e.occurred_at >= ?) >= ?', args: [c.name, since, c.count] }
          : { sql: 'NOT EXISTS (SELECT 1 FROM events e WHERE e.person_id = p.id AND e.name = ? AND e.occurred_at >= ?)', args: [c.name, since] }
      }
    }
  }
}

function textOp(expr: string, op: 'is' | 'is_not' | 'contains' | 'is_set' | 'not_set', value: string): { sql: string; args: Binding[] } {
  const v = value.trim().toLowerCase()
  switch (op) {
    case 'is':
      return { sql: `lower(${expr}) = ?`, args: [v] }
    case 'is_not':
      return { sql: `lower(${expr}) <> ?`, args: [v] }
    case 'contains':
      return { sql: `instr(lower(${expr}), ?) > 0`, args: [v] }
    case 'is_set':
      return { sql: `${expr} <> ''`, args: [] }
    case 'not_set':
      return { sql: `${expr} = ''`, args: [] }
  }
}
