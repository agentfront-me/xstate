// Records of moving a domain's mail from Stalwart to the mailbox store (migration 0039; mailserver/domain-switch.ts).

export type SwitchState = 'switching' | 'flipped' | 'rolled_back' | 'cancelled'
export type SwitchStep = { step: string; at: string; ok: boolean; detail?: unknown }

export type DomainSwitchRow = {
  id: string
  domain_id: string
  state: SwitchState
  started_at: string
  started_by: string | null
  mx_seen_at: string | null
  flipped_at: string | null
  ended_at: string | null
  steps: string
}

/** The domain's latest switch, if any. */
export function latest(db: D1Database, domainId: string): Promise<DomainSwitchRow | null> {
  return db.prepare('SELECT * FROM domain_switches WHERE domain_id = ? ORDER BY started_at DESC LIMIT 1').bind(domainId).first<DomainSwitchRow>()
}

export function insert(db: D1Database, row: { id: string; domainId: string; startedBy: string; now: string }): D1PreparedStatement {
  return db
    .prepare("INSERT INTO domain_switches (id, domain_id, state, started_at, started_by) VALUES (?, ?, 'switching', ?, ?)")
    .bind(row.id, row.domainId, row.now, row.startedBy)
}

export function setState(db: D1Database, id: string, state: SwitchState, fields: { flippedAt?: string; endedAt?: string } = {}): D1PreparedStatement {
  return db
    .prepare('UPDATE domain_switches SET state = ?, flipped_at = COALESCE(?, flipped_at), ended_at = COALESCE(?, ended_at) WHERE id = ?')
    .bind(state, fields.flippedAt ?? null, fields.endedAt ?? null, id)
}

/** Appends one step to the record. */
export function addStep(db: D1Database, id: string, step: SwitchStep): D1PreparedStatement {
  return db.prepare("UPDATE domain_switches SET steps = json_insert(steps, '$[#]', json(?)) WHERE id = ?").bind(JSON.stringify(step), id)
}

/** The first time public DNS showed only SES's MX for the domain. */
export function setMxSeen(db: D1Database, id: string, at: string): D1PreparedStatement {
  return db.prepare('UPDATE domain_switches SET mx_seen_at = COALESCE(mx_seen_at, ?) WHERE id = ?').bind(at, id)
}

/** Switches in progress (for the hourly DNS watch). */
export async function switching(db: D1Database): Promise<(DomainSwitchRow & { name: string })[]> {
  const { results } = await db
    .prepare("SELECT s.*, d.name AS name FROM domain_switches s JOIN domains d ON d.id = s.domain_id WHERE s.state IN ('switching', 'rolled_back') AND s.ended_at IS NULL")
    .all<DomainSwitchRow & { name: string }>()
  return results
}

export function setMailPath(db: D1Database, domainId: string, path: 'stalwart' | 'switching' | 'store', now: string): D1PreparedStatement {
  return db.prepare('UPDATE domains SET mail_path = ?, updated_at = ? WHERE id = ?').bind(path, now, domainId)
}
