// Emails about an agent to the people who look after it: approval requests and reminders, the spend cap. System
// mail, best effort: a failure is logged and never stops a run.

import * as db from '../db/agents'
import { paragraph, systemMailHtml } from '../mailserver/mail-html'
import { sendSystemEmail } from '../mailserver/system-mail'

type Person = { id: string; email: string; name: string | null }

/**
 * Who hears about an agent: the listed user ids if any (owners and admins among them or not), otherwise owners,
 * admins and members with the agents permission.
 */
export async function managers(env: Env, organizationId: string, listed: string[] = []): Promise<Person[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, m.role, json(m.permissions) AS permissions FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ? AND m.status = 'active'`,
  )
    .bind(organizationId)
    .all<Person & { role: string; permissions: string }>()
  return results
    .filter((p) =>
      listed.length ? listed.includes(p.id) : p.role === 'owner' || p.role === 'admin' || (JSON.parse(p.permissions || '{}') as { org?: string[] }).org?.includes('agents.manage'),
    )
    .slice(0, 20)
}

/** A link into the agent's page, on a tab. */
export const agentUrl = (env: Env, agentId: string, tab: string) => `${env.APP_URL.replace(/\/+$/, '')}/app/#/agents?agent=${agentId}&tab=${tab}`

export async function emailManagers(
  env: Env,
  agentId: string,
  mail: { subject: (agentName: string) => string; lines: (agentName: string) => string[]; button: { text: string; tab: string }; footnote?: string; to?: string[] },
) {
  const agent = await db.findAgent(env.DB, agentId)
  if (!agent) return
  const people = await managers(env, agent.organization_id, mail.to)
  const url = agentUrl(env, agent.id, mail.button.tab)
  const lines = mail.lines(agent.name).filter(Boolean)
  const subject = mail.subject(agent.name)
  for (const p of people) {
    const text = `${lines.join('\n\n')}\n\n${mail.button.text}:\n${url}\n${mail.footnote ? `\n${mail.footnote}\n` : ''}`
    const html = systemMailHtml({ paragraphs: lines.map((l) => paragraph(l)), button: { text: mail.button.text, url }, footnote: mail.footnote })
    await sendSystemEmail(env, { to: { name: p.name, email: p.email }, subject, text, html }).catch((err) => console.error('agent email failed', err))
  }
}
