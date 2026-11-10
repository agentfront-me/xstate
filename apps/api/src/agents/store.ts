// One Durable Object per agent (named by agent id): its runs, their steps and cost, recent trigger events, its
// memory facts, and the alarms behind its schedule triggers and memory retention. Starts each run as an AgentRun Workflow (agents/run.ts), which writes its
// progress back here. Runs stay here, not in D1: they're many, private to one agent, and go away with it.

import { Agent } from 'agents'
import type { AgentConfig } from './config'
import { emailManagers } from './notices'
import { formatUsd } from './prices'
import type { RunParams } from './run'
import { fireSchedule } from './triggers'

export type RunStatus = 'running' | 'waiting_for_approval' | 'done' | 'failed' | 'max_steps' | 'skipped'

export type RunRow = {
  id: string
  status: RunStatus
  trigger_kind: string
  trigger_label: string
  trigger_id: string | null
  sender: string | null
  version: number | null
  dry_run: number
  model: string
  task: string
  started_at: string
  finished_at: string | null
  steps: number
  input_tokens: number
  output_tokens: number
  summary: string | null
  error: string | null
  cost_usd: number
  retried_as: string | null
}

export type FactRow = { id: string; subject: string; fact: string; source_run: string | null; created_at: string; updated_at: string }

export type StepRow = { run_id: string; seq: number; at: string; kind: string; detail: string }
export type TriggerEventRow = { trigger_id: string; at: string; outcome: string; run_id: string | null; detail: string }

/** Trigger events kept per trigger (the "recent payloads" list). */
const EVENTS_KEPT = 20

export type StartResult = { runId: string } | { skipped: string; runId: string }

export class AgentStore extends Agent<Env> {
  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, trigger_kind TEXT NOT NULL, trigger_label TEXT NOT NULL,
      version INTEGER, dry_run INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, task TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, steps INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, summary TEXT, error TEXT)`
    // Added in Phases 2 and 5; ALTER fails harmlessly when the column is already there.
    for (const column of ['trigger_id TEXT', 'sender TEXT', 'cost_usd REAL NOT NULL DEFAULT 0', 'retried_as TEXT']) {
      try {
        this.ctx.storage.sql.exec(`ALTER TABLE runs ADD COLUMN ${column}`)
      } catch {
        // already added
      }
    }
    this.sql`CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at)`
    this.sql`CREATE INDEX IF NOT EXISTS runs_sender ON runs (sender, started_at)`
    this.sql`CREATE TABLE IF NOT EXISTS run_steps (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL,
      PRIMARY KEY (run_id, seq))`
    this.sql`CREATE TABLE IF NOT EXISTS trigger_events (
      trigger_id TEXT NOT NULL, at TEXT NOT NULL, outcome TEXT NOT NULL, run_id TEXT, detail TEXT NOT NULL)`
    this.sql`CREATE INDEX IF NOT EXISTS trigger_events_by ON trigger_events (trigger_id, at)`
    this.sql`CREATE TABLE IF NOT EXISTS trigger_schedules (trigger_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, at TEXT NOT NULL)`
    this.sql`CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, fact TEXT NOT NULL, source_run TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
    this.sql`CREATE INDEX IF NOT EXISTS memory_subject ON memory (subject, updated_at)`
    // Small settings and "already told them" markers (spend notices once a month).
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
  }

  private meta(key: string): string | null {
    return this.sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`[0]?.value ?? null
  }

  private setMeta(key: string, value: string) {
    this.sql`INSERT OR REPLACE INTO meta (key, value) VALUES (${key}, ${value})`
  }

  // -------------------------------------------------------------------------------------------------------------
  // Runs

  /** Real runs started since midnight UTC, for the agent's runs-per-day limit. */
  runsToday(): number {
    const midnight = new Date().toISOString().slice(0, 10)
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM runs WHERE dry_run = 0 AND status != 'skipped' AND started_at >= ${midnight}`[0]?.n ?? 0
  }

  private senderRunsLastHour(sender: string): number {
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM runs WHERE sender = ${sender} AND status != 'skipped' AND started_at >= ${hourAgo}`[0]?.n ?? 0
  }

  /**
   * Starts a run, or records it as skipped when a limit says no (so the Runs tab shows why nothing happened).
   * Limits and the spend cap apply to real runs only; tests still count toward the month's spend.
   */
  async startRun(params: Omit<RunParams, 'runId'>): Promise<StartResult> {
    const runId = crypto.randomUUID()
    const { limits, spend, memory } = params.config
    if (!params.dryRun) {
      if (this.runsToday() >= limits.maxRunsPerDay) {
        return { runId, skipped: this.recordSkip(runId, params, `Reached the limit of ${limits.maxRunsPerDay} runs today`) }
      }
      const sender = params.trigger.sender
      if (sender && this.senderRunsLastHour(sender) >= limits.perSenderPerHour) {
        return { runId, skipped: this.recordSkip(runId, params, `${sender} reached the limit of ${limits.perSenderPerHour} runs an hour`) }
      }
      const cap = spend.monthlyCapUsd
      if (cap !== null && this.monthSpend() >= cap) {
        await this.capReached(params.agentId, params.config)
        if (spend.whenReached === 'pause') {
          return { runId, skipped: this.recordSkip(runId, params, `Reached this month’s spend cap of ${formatUsd(cap)}`) }
        }
      }
    }
    if (memory.enabled) await this.keepMemoryFor(memory.retentionDays)
    this.insertRun(runId, params, 'running')
    await this.runWorkflow('AGENT_RUN', { ...params, runId } satisfies RunParams, { id: runId })
    return { runId }
  }

  /** A run that didn't happen: a limit, the loop guard or an inactive agent. Shown in the Runs tab as Skipped. */
  recordSkip(runId: string, params: Omit<RunParams, 'runId'>, reason: string): string {
    this.insertRun(runId, params, 'skipped')
    this.sql`UPDATE runs SET summary = ${reason}, finished_at = ${new Date().toISOString()} WHERE id = ${runId}`
    return reason
  }

  private insertRun(runId: string, params: Omit<RunParams, 'runId'>, status: RunStatus) {
    const model = params.config.model ? `${params.config.model.provider}:${params.config.model.id}` : ''
    this.sql`INSERT INTO runs (id, status, trigger_kind, trigger_label, trigger_id, sender, version, dry_run, model, task, started_at)
      VALUES (${runId}, ${status}, ${params.trigger.kind}, ${params.trigger.label}, ${params.trigger.triggerId ?? null},
        ${params.trigger.sender ?? null}, ${params.version}, ${params.dryRun ? 1 : 0}, ${model}, ${params.task.slice(0, 4000)},
        ${new Date().toISOString()})`
  }

  logStep(runId: string, kind: string, detail: unknown) {
    const seq = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM run_steps WHERE run_id = ${runId}`[0]?.n ?? 0
    this.sql`INSERT OR IGNORE INTO run_steps (run_id, seq, at, kind, detail)
      VALUES (${runId}, ${seq}, ${new Date().toISOString()}, ${kind}, ${JSON.stringify(detail)})`
  }

  /** Tokens and estimated cost of one model call, added as the run goes (so a long run's cost shows while it runs). */
  addUsage(runId: string, u: { input: number; output: number; cost: number }) {
    this.sql`UPDATE runs SET input_tokens = input_tokens + ${u.input}, output_tokens = output_tokens + ${u.output},
      cost_usd = cost_usd + ${u.cost}, steps = steps + 1 WHERE id = ${runId}`
  }

  setStatus(runId: string, status: RunStatus) {
    this.sql`UPDATE runs SET status = ${status} WHERE id = ${runId} AND finished_at IS NULL`
  }

  finishRun(runId: string, r: { status: RunStatus; summary?: string; error?: string; steps: number; input: number; output: number; cost: number }) {
    this.sql`UPDATE runs SET status = ${r.status}, summary = ${r.summary ?? null}, error = ${r.error ?? null},
      steps = ${r.steps}, input_tokens = ${r.input}, output_tokens = ${r.output}, cost_usd = ${r.cost},
      finished_at = ${new Date().toISOString()} WHERE id = ${runId}`
  }

  listRuns(q: { limit: number; before?: string; trigger?: string; status?: string; since?: string }): RunRow[] {
    const before = q.before ?? '9999'
    const since = q.since ?? ''
    const trigger = q.trigger ?? null
    const status = q.status ?? null
    return this.sql<RunRow>`SELECT * FROM runs
      WHERE started_at < ${before} AND started_at >= ${since}
        AND (${trigger} IS NULL OR trigger_kind = ${trigger})
        AND (${status} IS NULL OR status = ${status})
      ORDER BY started_at DESC LIMIT ${q.limit}`
  }

  getRun(runId: string): { run: RunRow; steps: StepRow[] } | null {
    const run = this.sql<RunRow>`SELECT * FROM runs WHERE id = ${runId}`[0]
    if (!run) return null
    return { run, steps: this.sql<StepRow>`SELECT * FROM run_steps WHERE run_id = ${runId} ORDER BY seq` }
  }

  stats() {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const month = new Date().toISOString().slice(0, 7)
    const week = this.sql<{ runs: number; finished: number; ok: number; tokens: number; cost: number }>`
      SELECT coalesce(sum(CASE WHEN status != 'skipped' THEN 1 END), 0) AS runs,
        coalesce(sum(CASE WHEN finished_at IS NOT NULL AND status != 'skipped' THEN 1 END), 0) AS finished,
        coalesce(sum(CASE WHEN status = 'done' THEN 1 END), 0) AS ok,
        coalesce(sum(input_tokens + output_tokens), 0) AS tokens,
        coalesce(sum(cost_usd), 0) AS cost
      FROM runs WHERE dry_run = 0 AND started_at >= ${weekAgo}`[0]!
    const byModel = this.sql<{ model: string; input: number; output: number; runs: number; cost: number }>`
      SELECT model, sum(input_tokens) AS input, sum(output_tokens) AS output, COUNT(*) AS runs, sum(cost_usd) AS cost
      FROM runs WHERE started_at >= ${month} AND status != 'skipped' GROUP BY model`
    return { week, month: byModel, monthSpend: this.monthSpend() }
  }

  /** Estimated spend this calendar month (UTC), tests included: they use the same key. */
  monthSpend(): number {
    const month = new Date().toISOString().slice(0, 7)
    return this.sql<{ usd: number }>`SELECT coalesce(sum(cost_usd), 0) AS usd FROM runs WHERE started_at >= ${month}`[0]?.usd ?? 0
  }

  /** For the agent list and the error banner: this month's spend and real runs that failed in the last day. */
  health(): { monthSpend: number; failed24h: number; lastError: string | null } {
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
    const failed = this.sql<{ n: number; error: string | null }>`
      SELECT COUNT(*) AS n, (SELECT error FROM runs WHERE dry_run = 0 AND status = 'failed' AND retried_as IS NULL AND started_at >= ${dayAgo}
        ORDER BY started_at DESC LIMIT 1) AS error
      FROM runs WHERE dry_run = 0 AND status = 'failed' AND retried_as IS NULL AND started_at >= ${dayAgo}`[0]
    return { monthSpend: this.monthSpend(), failed24h: failed?.n ?? 0, lastError: failed?.error ?? null }
  }

  /** Real runs that failed in the last day and weren't retried yet, oldest first. */
  failedRuns(limit: number): RunRow[] {
    const dayAgo = new Date(Date.now() - 86_400_000).toISOString()
    return this.sql<RunRow>`SELECT * FROM runs WHERE dry_run = 0 AND status = 'failed' AND retried_as IS NULL AND started_at >= ${dayAgo}
      ORDER BY started_at LIMIT ${limit}`
  }

  markRetried(runId: string, newRunId: string) {
    this.sql`UPDATE runs SET retried_as = ${newRunId} WHERE id = ${runId}`
  }

  /** Tells the admins, once a month, that the cap was reached. */
  private async capReached(agentId: string, config: AgentConfig) {
    const month = new Date().toISOString().slice(0, 7)
    if (this.meta('cap_notice') === month) return
    this.setMeta('cap_notice', month)
    const cap = formatUsd(config.spend.monthlyCapUsd ?? 0)
    const pause = config.spend.whenReached === 'pause'
    await emailManagers(this.env, agentId, {
      subject: (name) => `${name} reached its ${cap} monthly spend cap`,
      lines: (name) => [
        `${name} has used an estimated ${formatUsd(this.monthSpend())} of AI this month, reaching its cap of ${cap}.`,
        pause
          ? 'It skips new runs until next month, or until you raise the cap in its Settings.'
          : 'It keeps running: the cap is set to notify only. You can change that in its Settings.',
      ],
      button: { text: 'Open settings', tab: 'settings' },
      footnote: 'Spend is estimated from token counts and list prices; your AI provider’s bill is the final word.',
    }).catch((err) => console.error('cap notice failed', err))
  }

  // -------------------------------------------------------------------------------------------------------------
  // Trigger events: what each trigger received and what came of it (newest first, a few per trigger)

  logTriggerEvent(triggerId: string, outcome: string, runId: string | null, detail: unknown) {
    this.sql`INSERT INTO trigger_events (trigger_id, at, outcome, run_id, detail)
      VALUES (${triggerId}, ${new Date().toISOString()}, ${outcome}, ${runId}, ${JSON.stringify(detail)})`
    this.sql`DELETE FROM trigger_events WHERE trigger_id = ${triggerId} AND at NOT IN (
      SELECT at FROM trigger_events WHERE trigger_id = ${triggerId} ORDER BY at DESC LIMIT ${EVENTS_KEPT})`
  }

  triggerEvents(triggerId: string, limit = 5): TriggerEventRow[] {
    return this.sql<TriggerEventRow>`SELECT * FROM trigger_events WHERE trigger_id = ${triggerId} ORDER BY at DESC LIMIT ${limit}`
  }

  // -------------------------------------------------------------------------------------------------------------
  // Schedule triggers: one alarm per trigger for its next time; firing works out and arms the one after.

  async armSchedule(triggerId: string, at: string | null) {
    await this.disarmSchedule(triggerId)
    if (!at) return
    const schedule = await this.schedule(new Date(at), 'onScheduleDue', { triggerId })
    this.sql`INSERT OR REPLACE INTO trigger_schedules (trigger_id, schedule_id, at) VALUES (${triggerId}, ${schedule.id}, ${at})`
  }

  async disarmSchedule(triggerId: string) {
    const row = this.sql<{ schedule_id: string }>`SELECT schedule_id FROM trigger_schedules WHERE trigger_id = ${triggerId}`[0]
    if (row) await this.cancelSchedule(row.schedule_id)
    this.sql`DELETE FROM trigger_schedules WHERE trigger_id = ${triggerId}`
  }

  /** Called by the SDK's scheduler when a schedule trigger is due. */
  async onScheduleDue(payload: { triggerId: string }) {
    this.sql`DELETE FROM trigger_schedules WHERE trigger_id = ${payload.triggerId}`
    await fireSchedule(this.env, this, payload.triggerId)
  }

  // -------------------------------------------------------------------------------------------------------------
  // Memory: short facts the agent saves with memory_remember and reads with memory_recall. People can see and edit
  // them in the Memory tab. Facts not updated within the retention period are swept once a day.

  /** Saves a fact, or refreshes it when the same subject already has the same fact. */
  remember(subject: string, fact: string, sourceRun: string | null): FactRow {
    const s = subject.trim().toLowerCase().slice(0, 200)
    const f = fact.trim().slice(0, 1000)
    const now = new Date().toISOString()
    const same = this.sql<FactRow>`SELECT * FROM memory WHERE subject = ${s} AND fact = ${f}`[0]
    if (same) {
      this.sql`UPDATE memory SET updated_at = ${now}, source_run = coalesce(${sourceRun}, source_run) WHERE id = ${same.id}`
      return { ...same, updated_at: now }
    }
    const row: FactRow = { id: crypto.randomUUID(), subject: s, fact: f, source_run: sourceRun, created_at: now, updated_at: now }
    this.sql`INSERT INTO memory (id, subject, fact, source_run, created_at, updated_at)
      VALUES (${row.id}, ${row.subject}, ${row.fact}, ${row.source_run}, ${now}, ${now})`
    return row
  }

  recall(q: { subject?: string; query?: string; limit?: number }): FactRow[] {
    const subject = q.subject?.trim().toLowerCase() || null
    const like = q.query?.trim() ? `%${q.query.trim().replace(/[%_]/g, (c) => `\\${c}`)}%` : null
    return this.sql<FactRow>`SELECT * FROM memory
      WHERE (${subject} IS NULL OR subject = ${subject})
        AND (${like} IS NULL OR fact LIKE ${like} ESCAPE '\\' OR subject LIKE ${like} ESCAPE '\\')
      ORDER BY updated_at DESC LIMIT ${q.limit ?? 20}`
  }

  updateFact(id: string, patch: { subject?: string; fact?: string }): FactRow | null {
    const row = this.sql<FactRow>`SELECT * FROM memory WHERE id = ${id}`[0]
    if (!row) return null
    const next = {
      ...row,
      subject: patch.subject?.trim().toLowerCase().slice(0, 200) || row.subject,
      fact: patch.fact?.trim().slice(0, 1000) || row.fact,
      updated_at: new Date().toISOString(),
    }
    this.sql`UPDATE memory SET subject = ${next.subject}, fact = ${next.fact}, updated_at = ${next.updated_at} WHERE id = ${id}`
    return next
  }

  forget(id: string): boolean {
    const found = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memory WHERE id = ${id}`[0]?.n ?? 0
    this.sql`DELETE FROM memory WHERE id = ${id}`
    return found > 0
  }

  clearMemory(): number {
    const n = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memory`[0]?.n ?? 0
    this.sql`DELETE FROM memory`
    return n
  }

  memoryCount(): number {
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memory`[0]?.n ?? 0
  }

  /** Records the retention to apply (from the config of the latest run or edit) and keeps a daily sweep going. */
  async keepMemoryFor(days: number | null) {
    this.setMeta('retention_days', days === null ? 'never' : String(days))
    await this.scheduleEvery(86_400, 'sweepMemory')
    this.sweepMemory()
  }

  /** Deletes facts not updated within the retention period. Called daily by the scheduler. */
  sweepMemory() {
    const days = this.meta('retention_days')
    if (!days || days === 'never') return
    const cutoff = new Date(Date.now() - Number(days) * 86_400_000).toISOString()
    this.sql`DELETE FROM memory WHERE updated_at < ${cutoff}`
  }

  // -------------------------------------------------------------------------------------------------------------

  /** Deletes the agent's runs, schedules and everything else it stored (the agent was deleted). */
  async wipe() {
    await this.destroy()
  }

  // The runs table is the record; the SDK's own workflow tracking table would only grow.
  async onWorkflowComplete(_name: string, instanceId: string) {
    this.deleteWorkflow(instanceId)
  }

  async onWorkflowError(_name: string, instanceId: string, error: string) {
    this.sql`UPDATE runs SET status = 'failed', error = coalesce(error, ${error}), finished_at = ${new Date().toISOString()}
      WHERE id = ${instanceId} AND finished_at IS NULL`
    this.deleteWorkflow(instanceId)
  }
}
