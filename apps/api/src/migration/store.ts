// One Durable Object per organization (MIGRATION_STORE.idFromName(organizationId)): which Google items were copied
// and what they became in xstate, and the items that were skipped or failed (for the report). Per organization, not
// per migration, so a cancelled migration started again later doesn't copy anything twice.
//
// Why not D1: a 50-person domain is millions of rows written in bursts while copying. Kept per migration, an import
// can't slow sign-in or mail for everyone else. Access checks happen in the Worker; this class trusts its callers.
//
// Copying is claim-then-record. A job claims the ids it's about to copy; ids claimed by another job are skipped, so
// two overlapping jobs (a retry, a resumed chain) never import the same message twice. A claim that wasn't recorded
// within CLAIM_STALE_MS (its job died) can be claimed again.
//
// Attempts find the item that kills a job. A job counts an attempt on an item just before working on it and takes it
// back when the job stops normally (an error it caught included). A job the Worker kills (out of memory or time)
// can't take it back, so the count only grows for items that were in flight when a job died. mail.ts copies those
// one at a time, and skips one that was in flight alone when a job died.

import { DurableObject } from 'cloudflare:workers'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  kind        TEXT NOT NULL,                  -- 'message', 'label' (Gmail label → folder), later 'contact', 'file'
  owner       TEXT NOT NULL,                  -- the Google user id (or a shared drive id)
  source_id   TEXT NOT NULL,                  -- Google's id
  target_id   TEXT,                           -- what it became in xstate; NULL while claimed and not yet copied
  claim       TEXT,                           -- the job that claimed it
  claimed_at  INTEGER,
  PRIMARY KEY (kind, owner, source_id)
);
CREATE TABLE IF NOT EXISTS problems (
  kind        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,                  -- 'too_large', 'chat', 'import_failed', …
  detail      TEXT,
  at          TEXT NOT NULL,
  PRIMARY KEY (kind, owner, source_id)
);
CREATE TABLE IF NOT EXISTS attempts (
  kind        TEXT NOT NULL,
  owner       TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  n           INTEGER NOT NULL,               -- times a job started on it without finishing (it died with it)
  PRIMARY KEY (kind, owner, source_id)
);
`

/** Longer than a queue job can run (15 minutes), so a live job's claim is never taken over mid-import. */
const CLAIM_STALE_MS = 20 * 60_000


export type Problem = { sourceId: string; reason: string; detail?: string }

export class MigrationStore extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(SCHEMA)
  }

  /**
   * Claims the ids not yet copied, skipped or held by another live claim, for `claim` (a job id). Ids this same
   * claim already holds are returned again, so a retried job carries on. Returns the ids the caller should copy
   * (`mine`), and how many are held by another claim (`held`): the caller must come back to those later rather than
   * move past them, or they'd never be copied if that other job died.
   */
  claim(kind: string, owner: string, ids: string[], claim: string): { mine: string[]; held: number } {
    const now = Date.now()
    const mine: string[] = []
    let held = 0
    for (const id of ids) {
      if (this.sql.exec('SELECT 1 FROM problems WHERE kind = ? AND owner = ? AND source_id = ?', kind, owner, id).toArray().length) continue
      const row = this.sql
        .exec<{ target_id: string | null; claim: string | null; claimed_at: number | null }>(
          'SELECT target_id, claim, claimed_at FROM items WHERE kind = ? AND owner = ? AND source_id = ?',
          kind,
          owner,
          id,
        )
        .toArray()[0]
      if (row?.target_id) continue
      if (row && row.claim !== claim && now - (row.claimed_at ?? 0) < CLAIM_STALE_MS) {
        held++
        continue
      }
      this.sql.exec(
        `INSERT INTO items (kind, owner, source_id, claim, claimed_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (kind, owner, source_id) DO UPDATE SET claim = excluded.claim, claimed_at = excluded.claimed_at`,
        kind,
        owner,
        id,
        claim,
        now,
      )
      mine.push(id)
    }
    return { mine, held }
  }

  /** Records what claimed items became. */
  record(kind: string, owner: string, rows: { sourceId: string; targetId: string }[]): void {
    for (const r of rows) {
      this.sql.exec(
        `INSERT INTO items (kind, owner, source_id, target_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, owner, source_id) DO UPDATE SET target_id = excluded.target_id, claim = NULL, claimed_at = NULL`,
        kind,
        owner,
        r.sourceId,
        r.targetId,
      )
      this.sql.exec('DELETE FROM attempts WHERE kind = ? AND owner = ? AND source_id = ?', kind, owner, r.sourceId)
    }
  }

  /** Unfinished attempts for these ids, for the ones with any. */
  attempts(kind: string, owner: string, ids: string[]): Record<string, number> {
    const out: Record<string, number> = {}
    for (const id of ids) {
      const row = this.sql.exec<{ n: number }>('SELECT n FROM attempts WHERE kind = ? AND owner = ? AND source_id = ?', kind, owner, id).toArray()[0]
      if (row?.n) out[id] = row.n
    }
    return out
  }

  /** Counts an attempt on each id (`by` 1), or takes one back (`by` -1) when a job stops without dying. */
  attempt(kind: string, owner: string, ids: string[], by: 1 | -1): void {
    for (const id of ids) {
      this.sql.exec(
        `INSERT INTO attempts (kind, owner, source_id, n) VALUES (?, ?, ?, MAX(?, 0))
         ON CONFLICT (kind, owner, source_id) DO UPDATE SET n = MAX(n + ?, 0)`,
        kind,
        owner,
        id,
        by,
        by,
      )
    }
    this.sql.exec('DELETE FROM attempts WHERE n = 0')
  }

  /** Items that won't be copied, with why. Clears their claim. */
  skip(kind: string, owner: string, rows: Problem[]): void {
    const at = new Date().toISOString()
    for (const r of rows) {
      this.sql.exec(
        `INSERT INTO problems (kind, owner, source_id, reason, detail, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (kind, owner, source_id) DO UPDATE SET reason = excluded.reason, detail = excluded.detail, at = excluded.at`,
        kind,
        owner,
        r.sourceId,
        r.reason,
        r.detail ?? null,
        at,
      )
      this.sql.exec('DELETE FROM items WHERE kind = ? AND owner = ? AND source_id = ? AND target_id IS NULL', kind, owner, r.sourceId)
      this.sql.exec('DELETE FROM attempts WHERE kind = ? AND owner = ? AND source_id = ?', kind, owner, r.sourceId)
    }
  }

  /** Lets go of claimed ids that weren't copied (a job stopping early), so the next job takes them. */
  release(kind: string, owner: string, ids: string[], claim: string): void {
    for (const id of ids) {
      this.sql.exec('DELETE FROM items WHERE kind = ? AND owner = ? AND source_id = ? AND target_id IS NULL AND claim = ?', kind, owner, id, claim)
    }
  }

  /** source → target for every copied item of a kind and owner (labels → folders: small). */
  map(kind: string, owner: string): Record<string, string> {
    const rows = this.sql
      .exec<{ source_id: string; target_id: string }>('SELECT source_id, target_id FROM items WHERE kind = ? AND owner = ? AND target_id IS NOT NULL', kind, owner)
      .toArray()
    return Object.fromEntries(rows.map((r) => [r.source_id, r.target_id]))
  }

  /** What these Google ids became, for the ones copied (the final pass: labels changed, files edited). */
  targets(kind: string, owner: string, ids: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (const id of ids) {
      const row = this.sql
        .exec<{ target_id: string | null }>('SELECT target_id FROM items WHERE kind = ? AND owner = ? AND source_id = ?', kind, owner, id)
        .toArray()[0]
      if (row?.target_id) out[id] = row.target_id
    }
    return out
  }

  /** Skipped items grouped by kind and reason, for the report's summary. */
  problemCounts(): { kind: string; reason: string; count: number }[] {
    return this.sql.exec<{ kind: string; reason: string; count: number }>('SELECT kind, reason, COUNT(*) AS count FROM problems GROUP BY kind, reason ORDER BY count DESC').toArray()
  }

  /** Copied and skipped counts for one owner. */
  counts(kind: string, owner: string): { copied: number; skipped: number } {
    const copied = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM items WHERE kind = ? AND owner = ? AND target_id IS NOT NULL', kind, owner).one().n
    const skipped = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM problems WHERE kind = ? AND owner = ?', kind, owner).one().n
    return { copied, skipped }
  }

  /**
   * Deletes everything: 30 days after the migration finished (the hourly job in ./watchdog.ts). The empty tables are
   * made again so a later import in this organization starts clean.
   */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll()
    this.sql.exec(SCHEMA)
  }

  /** Skipped and failed items, newest first, for the report. */
  problems(limit = 50_000): (Problem & { kind: string; owner: string; at: string })[] {
    return this.sql
      .exec<{ kind: string; owner: string; source_id: string; reason: string; detail: string | null; at: string }>(
        'SELECT * FROM problems ORDER BY at DESC LIMIT ?',
        limit,
      )
      .toArray()
      .map((r) => ({ kind: r.kind, owner: r.owner, sourceId: r.source_id, reason: r.reason, detail: r.detail ?? undefined, at: r.at }))
  }
}

export const migrationStore = (env: Pick<Env, 'MIGRATION_STORE'>, organizationId: string) =>
  env.MIGRATION_STORE.get(env.MIGRATION_STORE.idFromName(organizationId))
