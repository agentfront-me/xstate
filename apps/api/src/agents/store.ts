// One Durable Object per agent (named by agent id): its runs, their steps, recent trigger events, usage, and the
// alarms behind its schedule triggers. Starts each run as an AgentRun Workflow (agents/run.ts), which writes its
// progress back here. Runs stay here, not in D1: they're many, private to one agent, and go away with it.

import { Agent } from 'agents'
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
}

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
    // Added in Phase 2; ALTER fails harmlessly when the column is already there.
    for (const column of ['trigger_id TEXT', 'sender TEXT']) {
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
   * Limits apply to real runs only.
   */
  async startRun(params: Omit<RunParams, 'runId'>, limits: { maxRunsPerDay: number; perSenderPerHour: number }): Promise<StartResult> {
    const runId = crypto.randomUUID()
    if (!params.dryRun) {
      if (this.runsToday() >= limits.maxRunsPerDay) {
        return { runId, skipped: this.recordSkip(runId, params, `Reached the limit of ${limits.maxRunsPerDay} runs today`) }
      }
      const sender = params.trigger.sender
      if (sender && this.senderRunsLastHour(sender) >= limits.perSenderPerHour) {
        return { runId, skipped: this.recordSkip(runId, params, `${sender} reached the limit of ${limits.perSenderPerHour} runs an hour`) }
      }
    }
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

  setStatus(runId: string, status: RunStatus) {
    this.sql`UPDATE runs SET status = ${status} WHERE id = ${runId} AND finished_at IS NULL`
  }

  finishRun(runId: string, r: { status: RunStatus; summary?: string; error?: string; steps: number; input: number; output: number }) {
    this.sql`UPDATE runs SET status = ${r.status}, summary = ${r.summary ?? null}, error = ${r.error ?? null},
      steps = ${r.steps}, input_tokens = ${r.input}, output_tokens = ${r.output}, finished_at = ${new Date().toISOString()}
      WHERE id = ${runId}`
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
    const week = this.sql<{ runs: number; finished: number; ok: number; tokens: number }>`
      SELECT coalesce(sum(CASE WHEN status != 'skipped' THEN 1 END), 0) AS runs,
        coalesce(sum(CASE WHEN finished_at IS NOT NULL AND status != 'skipped' THEN 1 END), 0) AS finished,
        coalesce(sum(CASE WHEN status = 'done' THEN 1 END), 0) AS ok,
        coalesce(sum(input_tokens + output_tokens), 0) AS tokens
      FROM runs WHERE dry_run = 0 AND started_at >= ${weekAgo}`[0]!
    const byModel = this.sql<{ model: string; input: number; output: number; runs: number }>`
      SELECT model, sum(input_tokens) AS input, sum(output_tokens) AS output, COUNT(*) AS runs
      FROM runs WHERE started_at >= ${month} AND status != 'skipped' GROUP BY model`
    return { week, month: byModel }
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
