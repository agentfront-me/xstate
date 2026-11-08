// One Durable Object per organization (AUDIENCE.idFromName(organizationId)) holding that organization's audience in
// its own SQLite: people, their events, saved segments, and the attribute and event names seen so far.
//
// Why a Durable Object and not D1: tracking writes on every page view of every customer's website. Kept apart per
// organization, one busy site can't slow sign-in or mail for everyone else, and no single database has to hold all
// of it. Access checks happen in the Worker (audience/service.ts); this class trusts its callers.

import { DurableObject } from 'cloudflare:workers'
import {
  ANONYMOUS_RETENTION_DAYS,
  type AudienceEvent,
  type Attributes,
  type CollectBatch,
  type CollectItem,
  type Condition,
  EVENT_RETENTION_DAYS,
  type Filter,
  PAGEVIEW,
  type Person,
  type PersonFields,
  type Segment,
  type SegmentIcon,
} from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,                 -- 'user' (identified with a user id) or 'lead'
  domain         TEXT NOT NULL,                 -- the website's hostname, without www.
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
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS people_external ON people (domain, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS people_email ON people (domain, email) WHERE email IS NOT NULL;
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

/** Segments every organization starts with. They're ordinary segments: rename or delete them freely. */
const STARTER_SEGMENTS: { name: string; icon: SegmentIcon; filter: Filter }[] = [
  { name: 'Leads', icon: 'target', filter: { match: 'all', conditions: [{ kind: 'type', op: 'is', value: 'lead' }] } },
  { name: 'Active this week', icon: 'clock', filter: { match: 'all', conditions: [{ kind: 'date', field: 'last_seen', op: 'within', days: 7 }] } },
  { name: 'New this month', icon: 'star', filter: { match: 'all', conditions: [{ kind: 'date', field: 'created', op: 'within', days: 30 }] } },
]

const MAX_ATTRIBUTES = 100
const DAY = 86_400_000

type PersonRow = {
  id: string
  kind: 'user' | 'lead'
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
}
type SegmentRow = { id: string; name: string; icon: SegmentIcon; filter: string; created_at: string; updated_at: string }
type Binding = string | number | null

export type ListQuery = { segmentId?: string; filter?: Filter; domain?: string; q?: string; cursor?: string; limit: number }

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(SCHEMA)
      if (this.one<{ n: number }>('SELECT count(*) AS n FROM segments')!.n === 0 && !(await ctx.storage.get('seeded'))) {
        const now = new Date().toISOString()
        STARTER_SEGMENTS.forEach((s, i) =>
          this.sql.exec('INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?)', newId('seg'), s.name, s.icon, JSON.stringify(s.filter), i, now, now),
        )
        await ctx.storage.put('seeded', true)
      }
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
    this.sql.exec('DELETE FROM people WHERE id = ?', id)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Collect: identify, track and page calls from the snippet or the server API.

  async collect(batch: CollectBatch): Promise<{ accepted: number }> {
    let accepted = 0
    this.ctx.storage.transactionSync(() => {
      for (const item of batch.items) {
        if (this.collectOne(item, batch)) accepted++
      }
    })
    return { accepted }
  }

  private collectOne(item: CollectItem, batch: CollectBatch): boolean {
    const person = item.type === 'identify' ? this.identify(item, batch) : this.resolve(item, batch)
    if (!person) return false
    if (item.type !== 'identify') {
      const name = item.type === 'page' ? PAGEVIEW : item.event!
      this.sql.exec(
        'INSERT INTO events (person_id, name, properties, url, occurred_at) VALUES (?, ?, ?, ?, ?)',
        person.id,
        name,
        JSON.stringify(item.properties),
        item.url,
        item.at,
      )
      this.sql.exec(
        'INSERT INTO event_names VALUES (?, 1, ?) ON CONFLICT (name) DO UPDATE SET total = total + 1, last_at = max(last_at, excluded.last_at)',
        name,
        item.at,
      )
    }
    this.sql.exec('UPDATE people SET last_seen_at = max(last_seen_at, ?) WHERE id = ?', item.at, person.id)
    return true
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

  private create(fields: { kind: 'user' | 'lead'; domain: string; externalId?: string | null; anonymousId?: string | null; email?: string | null; source: string; at: string }): PersonRow {
    const id = newId('per')
    const now = new Date().toISOString()
    this.sql.exec(
      `INSERT INTO people (id, kind, domain, external_id, anonymous_id, email, source, first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    )
    this.alias(fields.domain, fields.anonymousId ?? null, id)
    return this.one<PersonRow>('SELECT * FROM people WHERE id = ?', id)!
  }

  /** The person a track or page call is about, created as an anonymous lead if new. */
  private resolve(item: CollectItem, batch: CollectBatch): PersonRow | null {
    const { domain, anonymousId, userId, email } = item
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
    const { domain, anonymousId, userId, at } = item
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
        this.sql.exec("UPDATE people SET kind = 'user', external_id = ?, updated_at = ? WHERE id = ?", userId, new Date().toISOString(), lead.id)
        person = { ...lead, kind: 'user', external_id: userId }
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
    const attrs = { ...(JSON.parse(from.attributes) as Attributes), ...(JSON.parse(into.attributes) as Attributes) }
    this.sql.exec('DELETE FROM people WHERE id = ?', from.id)
    this.sql.exec(
      `UPDATE people SET name = coalesce(name, ?), phone = coalesce(phone, ?), attributes = ?, first_seen_at = min(first_seen_at, ?),
       last_seen_at = max(last_seen_at, ?), updated_at = ? WHERE id = ?`,
      from.name,
      from.phone,
      JSON.stringify(attrs),
      from.first_seen_at,
      from.last_seen_at,
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
  // Dashboard

  async overview() {
    const total = this.one<{ n: number }>('SELECT count(*) AS n FROM people')!.n
    const domains = this.all<{ domain: string; count: number }>('SELECT domain, count(*) AS count FROM people GROUP BY domain ORDER BY count DESC')
    const segments = this.listSegments().map((s) => ({ ...s, count: this.count(s.filter) }))
    return { total, domains, segments }
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
  count(filter: Filter, domain?: string): number {
    const where = this.where(filter, domain)
    return this.one<{ n: number }>(`SELECT count(*) AS n FROM people p WHERE ${where.sql}`, ...where.args)!.n
  }

  async listPeople(query: ListQuery) {
    const segment = query.segmentId ? this.one<SegmentRow>('SELECT * FROM segments WHERE id = ?', query.segmentId) : null
    if (query.segmentId && !segment) return null
    const filter = segment ? toSegment(segment).filter : (query.filter ?? { match: 'all', conditions: [] })
    const base = this.where(filter, query.domain, query.q)
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

  async getPerson(id: string) {
    const row = this.one<PersonRow>('SELECT * FROM people WHERE id = ?', id)
    if (!row) return null
    const events = this.all<{ id: number; name: string; properties: string; url: string | null; occurred_at: string }>(
      'SELECT * FROM events WHERE person_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 100',
      id,
    ).map((e): AudienceEvent => ({ id: e.id, name: e.name, properties: JSON.parse(e.properties) as Record<string, unknown>, url: e.url, occurredAt: e.occurred_at }))
    const segments = this.listSegments()
      .filter((s) => {
        const where = this.where(s.filter)
        return !!this.one(`SELECT 1 FROM people p WHERE p.id = ? AND (${where.sql})`, id, ...where.args)
      })
      .map((s) => ({ id: s.id, name: s.name }))
    return { person: toPerson(row), events, segments }
  }

  async addPerson(input: { domain: string; source: string } & PersonFields): Promise<{ person?: Person; conflict?: string }> {
    if (input.email && this.byEmail(input.domain, input.email)) return { conflict: 'Someone with that email already exists on this domain' }
    let person!: PersonRow
    this.ctx.storage.transactionSync(() => {
      const row = this.create({ kind: 'lead', domain: input.domain, email: input.email ?? null, source: input.source, at: new Date().toISOString() })
      this.update(row, { name: input.name, phone: input.phone, attributes: input.attributes })
      person = this.one<PersonRow>('SELECT * FROM people WHERE id = ?', row.id)!
    })
    return { person: toPerson(person) }
  }

  async updatePerson(id: string, fields: PersonFields): Promise<{ person?: Person; conflict?: string } | null> {
    const row = this.one<PersonRow>('SELECT * FROM people WHERE id = ?', id)
    if (!row) return null
    if (fields.email && fields.email !== row.email && this.byEmail(row.domain, fields.email)) {
      return { conflict: 'Someone with that email already exists on this domain' }
    }
    this.ctx.storage.transactionSync(() => this.update(row, fields))
    return { person: toPerson(this.one<PersonRow>('SELECT * FROM people WHERE id = ?', id)!) }
  }

  async deletePeople(ids: string[]): Promise<number> {
    let n = 0
    this.ctx.storage.transactionSync(() => {
      for (const id of ids) {
        if (!this.one('SELECT 1 FROM people WHERE id = ?', id)) continue
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
  async exportPeople(query: Omit<ListQuery, 'cursor' | 'limit'>): Promise<Person[] | null> {
    const result = await this.listPeople({ ...query, limit: 50_000 })
    return result?.people ?? null
  }

  // -------------------------------------------------------------------------------------------------------------
  // Filters → SQL. Every value is a bound parameter; attribute keys go into a JSON path that is itself bound.

  private where(filter: Filter, domain?: string, q?: string): { sql: string; args: Binding[] } {
    const parts: string[] = []
    const args: Binding[] = []
    if (filter.conditions.length) {
      const compiled = filter.conditions.map((c) => this.compile(c))
      parts.push(`(${compiled.map((c) => `(${c.sql})`).join(filter.match === 'any' ? ' OR ' : ' AND ')})`)
      for (const c of compiled) args.push(...c.args)
    }
    if (domain) {
      parts.push('p.domain = ?')
      args.push(domain)
    }
    const term = q?.trim().toLowerCase()
    if (term) {
      parts.push(
        "(instr(lower(coalesce(p.name, '')), ?) > 0 OR instr(coalesce(p.email, ''), ?) > 0 OR instr(lower(coalesce(p.external_id, '')), ?) > 0 OR instr(lower(coalesce(p.anonymous_id, '')), ?) > 0 OR instr(coalesce(p.phone, ''), ?) > 0)",
      )
      args.push(term, term, term, term, term)
    }
    return { sql: parts.length ? parts.join(' AND ') : '1', args }
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
      case 'attribute': {
        const path = `$."${c.key}"`
        const val = 'json_extract(p.attributes, ?)'
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
