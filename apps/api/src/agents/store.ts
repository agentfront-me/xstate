// One Durable Object per agent (named by agent id): its runs, their steps, and usage. Starts each run as an AgentRun
// Workflow (agents/run.ts), which writes its progress back here. Runs stay here, not in D1: they're many, private to
// one agent, and go away with it.

import { Agent } from 'agents'
import type { RunParams } from './run'

export type RunStatus = 'running' | 'waiting_for_approval' | 'done' | 'failed' | 'max_steps' | 'skipped'

export type RunRow = {
  id: string
  status: RunStatus
  trigger_kind: string
  trigger_label: string
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

export class AgentStore extends Agent<Env> {
  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, trigger_kind TEXT NOT NULL, trigger_label TEXT NOT NULL,
      version INTEGER, dry_run INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL, task TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT, steps INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, summary TEXT, error TEXT)`
    this.sql`CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at)`
    this.sql`CREATE TABLE IF NOT EXISTS run_steps (
      run_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL,
      PRIMARY KEY (run_id, seq))`
  }

  /** Real runs started since midnight UTC, for the agent's runs-per-day limit. */
  runsToday(): number {
    const midnight = new Date().toISOString().slice(0, 10)
    return this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM runs WHERE dry_run = 0 AND started_at >= ${midnight}`[0]?.n ?? 0
  }

  async startRun(params: Omit<RunParams, 'runId'>, maxRunsPerDay: number): Promise<{ runId: string } | { error: string }> {
    if (!params.dryRun && this.runsToday() >= maxRunsPerDay) {
      return { error: `This agent reached its limit of ${maxRunsPerDay} runs today. Change it in the agent's Settings.` }
    }
    const runId = crypto.randomUUID()
    const model = params.config.model ? `${params.config.model.provider}:${params.config.model.id}` : ''
    this.sql`INSERT INTO runs (id, status, trigger_kind, trigger_label, version, dry_run, model, task, started_at)
      VALUES (${runId}, 'running', ${params.trigger.kind}, ${params.trigger.label}, ${params.version}, ${params.dryRun ? 1 : 0},
        ${model}, ${params.task.slice(0, 4000)}, ${new Date().toISOString()})`
    await this.runWorkflow('AGENT_RUN', { ...params, runId } satisfies RunParams, { id: runId })
    return { runId }
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
    // Small table per agent: filter in SQL with optional clauses written out.
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
      SELECT COUNT(*) AS runs,
        coalesce(sum(CASE WHEN finished_at IS NOT NULL AND status != 'skipped' THEN 1 END), 0) AS finished,
        coalesce(sum(CASE WHEN status = 'done' THEN 1 END), 0) AS ok,
        coalesce(sum(input_tokens + output_tokens), 0) AS tokens
      FROM runs WHERE dry_run = 0 AND started_at >= ${weekAgo}`[0]!
    const byModel = this.sql<{ model: string; input: number; output: number; runs: number }>`
      SELECT model, sum(input_tokens) AS input, sum(output_tokens) AS output, COUNT(*) AS runs
      FROM runs WHERE started_at >= ${month} GROUP BY model`
    return { week, month: byModel }
  }

  /** Deletes the agent's runs and everything else it stored (the agent was deleted). */
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
