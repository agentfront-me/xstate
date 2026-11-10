// Approvals: a tool call that waits for a person (docs/agents-plan.md, Phase 3). The run creates the row and waits on
// a Workflow event (agents/run.ts); deciding here updates the row and sends that event. Rows live in D1 so the agent
// list and the Approvals tab can show them without waking each agent.
//
// Who can decide: owners and admins always; otherwise the agent's approvers, or anyone who can manage agents when
// the list is empty.

import type { Actor } from '../auth/types'
import * as db from '../db/agents'
import { ApiError } from '../errors'
import { isAdmin, loadMember } from '../mailserver/access'
import { parseConfig, type AgentConfig } from './config'
import { emailManagers } from './notices'
import { agentContext, publishedConfig } from './service'
import { toolLabel } from './tools'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired'

type Row = {
  id: string
  agent_id: string
  organization_id: string
  run_id: string
  step_key: string
  tool: string
  input: string
  edited_input: string | null
  reason: string
  status: ApprovalStatus
  note: string | null
  decided_by: string | null
  decided_by_name: string | null
  decided_at: string | null
  created_at: string
  expires_at: string
}

export type Approval = {
  id: string
  agentId: string
  runId: string
  tool: string
  toolLabel: string
  input: unknown
  editedInput: unknown
  reason: string
  status: ApprovalStatus
  note: string | null
  decidedBy: string | null
  decidedAt: string | null
  createdAt: string
  expiresAt: string
}

const present = (r: Row): Approval => ({
  id: r.id,
  agentId: r.agent_id,
  runId: r.run_id,
  tool: r.tool,
  toolLabel: toolLabel(r.tool),
  input: JSON.parse(r.input) as unknown,
  editedInput: r.edited_input ? (JSON.parse(r.edited_input) as unknown) : null,
  reason: r.reason,
  status: r.status,
  note: r.note,
  decidedBy: r.decided_by_name,
  decidedAt: r.decided_at,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
})

const SELECT = 'SELECT a.*, u.name AS decided_by_name FROM agent_approvals a LEFT JOIN users u ON u.id = a.decided_by'

// ---------------------------------------------------------------------------------------------------------------
// From runs

/** Creates the approval for a tool call. Returns false when it already existed (a retried step). */
export async function create(
  env: Env,
  a: { id: string; agentId: string; organizationId: string; runId: string; stepKey: string; tool: string; input: unknown; reason: string; waitHours: number },
): Promise<boolean> {
  const now = Date.now()
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO agent_approvals (id, agent_id, organization_id, run_id, step_key, tool, input, reason, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(a.id, a.agentId, a.organizationId, a.runId, a.stepKey, a.tool, JSON.stringify(a.input), a.reason.slice(0, 2000), new Date(now).toISOString(), new Date(now + a.waitHours * 3_600_000).toISOString())
    .run()
  return result.meta.changes > 0
}

/** Nobody decided in time. */
export async function expire(env: Env, id: string) {
  await env.DB.prepare("UPDATE agent_approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'").bind(new Date().toISOString(), id).run()
}

/**
 * Emails the people who can decide. `reminder`: the call is still waiting after the agent's timeout and the agent
 * keeps waiting (onTimeout "wait"). Best effort: a failure here never stops the run.
 */
export async function notify(
  env: Env,
  agentId: string,
  approval: { tool: string; input: unknown; reason: string },
  config: AgentConfig,
  reminder?: { waitedHours: number; leftHours: number },
) {
  if (!config.approvals.notifyEmail) return
  const what = describe(approval.tool, approval.input)
  const lower = `${what.charAt(0).toLowerCase()}${what.slice(1)}`
  await emailManagers(env, agentId, {
    to: config.approvals.approvers,
    subject: (name) => (reminder ? `Still waiting: ${name} needs your approval to ${lower}` : `${name} needs your approval: ${what}`),
    lines: (name) => [
      reminder ? `${name} has been waiting ${reminder.waitedHours} hours for someone to approve this: ${lower}.` : `${name} wants to ${lower}.`,
      approval.reason ? `It said: “${approval.reason.slice(0, 400)}”` : '',
    ],
    button: { text: 'Review', tab: 'approvals' },
    footnote: reminder
      ? `It waits ${reminder.leftHours} more hours, then the request is refused.`
      : `It waits ${config.approvals.onTimeout === 'wait' ? `${config.approvals.timeoutHours} hours, then reminds you and waits up to 7 days in all` : `${config.approvals.timeoutHours} hours, then the request is refused`}.`,
  })
}

/** "Send an email to a@b.com: Subject" and the like, for notifications and lists. */
export function describe(tool: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  const to = Array.isArray(i.to) ? (i.to as { email?: string }[]).map((a) => a.email).filter(Boolean).join(', ') : ''
  if (tool === 'email_send') return `Send an email${to ? ` to ${to}` : ''}${i.subject ? `: ${String(i.subject)}` : ''}`
  if (tool === 'calendar_create_event') return `Create the event ${String(i.title ?? '')}`.trim()
  return toolLabel(tool)
}

// ---------------------------------------------------------------------------------------------------------------
// For people

async function canDecide(env: Env, actor: Actor, organizationId: string, config: AgentConfig): Promise<boolean> {
  const member = await loadMember(env, organizationId, actor.userId)
  if (isAdmin(member)) return true
  if (config.approvals.approvers.length) return config.approvals.approvers.includes(actor.userId)
  return member.permissions.org.includes('agents.manage')
}

async function effectiveConfig(env: Env, agent: db.AgentRow) {
  return (await publishedConfig(env, agent))?.config ?? parseConfig(agent.draft)
}

export async function list(env: Env, actor: Actor, agentId: string, status: 'pending' | 'decided') {
  const agent = await agentContext(env, actor, agentId)
  const query =
    status === 'pending'
      ? env.DB.prepare(`${SELECT} WHERE a.agent_id = ? AND a.status = 'pending' ORDER BY a.created_at`).bind(agent.id)
      : env.DB.prepare(`${SELECT} WHERE a.agent_id = ? AND a.status != 'pending' ORDER BY coalesce(a.decided_at, a.created_at) DESC LIMIT 50`).bind(agent.id)
  const { results } = await query.all<Row>()
  return { approvals: results.map(present), canDecide: await canDecide(env, actor, agent.organization_id, await effectiveConfig(env, agent)) }
}

/** Pending approvals per agent in an organization, for the agent list. */
export async function pendingCounts(env: Env, organizationId: string): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT agent_id, COUNT(*) AS n FROM agent_approvals WHERE organization_id = ? AND status = 'pending' GROUP BY agent_id",
  )
    .bind(organizationId)
    .all<{ agent_id: string; n: number }>()
  return new Map(results.map((r) => [r.agent_id, r.n]))
}

/**
 * Pending approvals across the organization, for the rail badge and desktop notifications. People who don't manage
 * agents get 0 rather than an error, so every page can ask.
 */
export async function pendingTotal(env: Env, actor: Actor, organizationId: string): Promise<{ count: number }> {
  try {
    const member = await loadMember(env, organizationId, actor.userId)
    if (!isAdmin(member) && !member.permissions.org.includes('agents.manage')) return { count: 0 }
  } catch {
    return { count: 0 }
  }
  let count = 0
  for (const n of (await pendingCounts(env, organizationId)).values()) count += n
  return { count }
}

/**
 * Approves (optionally with changed input) or rejects a waiting tool call, and wakes the run. A rejection's note goes
 * back to the agent, which decides what to do instead.
 */
export async function decide(
  env: Env,
  actor: Actor,
  agentId: string,
  approvalId: string,
  input: { decision: 'approve' | 'reject'; note?: string; input?: unknown },
): Promise<Approval> {
  const agent = await agentContext(env, actor, agentId)
  const row = await env.DB.prepare(`${SELECT} WHERE a.id = ? AND a.agent_id = ?`).bind(approvalId, agent.id).first<Row>()
  if (!row) throw new ApiError('not_found', 'No such approval', 404)
  if (!(await canDecide(env, actor, agent.organization_id, await effectiveConfig(env, agent)))) {
    throw new ApiError('forbidden', "You're not one of this agent's approvers", 403)
  }
  const approved = input.decision === 'approve'
  const edited = approved && input.input !== undefined ? JSON.stringify(input.input) : null
  const note = input.note?.trim().slice(0, 2000) || null
  const now = new Date().toISOString()
  const update = await env.DB.prepare(
    "UPDATE agent_approvals SET status = ?, note = ?, edited_input = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(approved ? 'approved' : 'rejected', note, edited, actor.userId, now, row.id)
    .run()
  if (!update.meta.changes) {
    throw new ApiError('already_decided', row.status === 'expired' ? 'This request ran out of time' : 'Someone already decided this', 409)
  }
  try {
    await env.AGENT_RUN.get(row.run_id).then((run) =>
      run.sendEvent({ type: `approval-${row.step_key}`, payload: { approved, note, inputJson: edited ?? undefined, by: actor.userId } }),
    )
  } catch (err) {
    console.error('approval: waking the run failed', err)
    throw new ApiError('run_gone', 'The run stopped waiting (it may have ended). Run the agent again.', 409)
  }
  return present((await env.DB.prepare(`${SELECT} WHERE a.id = ?`).bind(row.id).first<Row>())!)
}
