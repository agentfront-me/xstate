// The email that goes out when a mailbox, or a whole organization, has its sending suspended for bounces or spam
// complaints (mailserver/sending.ts). Mail sent through the API counts toward that like any other, so the email
// names the API tokens that sent from there lately: a script mailing bad addresses is the likeliest cause, and the
// person who can fix it needs to know which one. System mail, best effort.

import * as mailboxesDb from '../db/mailboxes'
import { paragraph, systemMailHtml } from '../mailserver/mail-html'
import { sendSystemEmail } from '../mailserver/system-mail'

const SUPPORT = 'support@xstate.io'
const DAYS = 7

type Person = { email: string; name: string | null }

/** Owners and admins, and for one mailbox the people it belongs to. */
async function audience(env: Env, organizationId: string, mailboxId: string | null): Promise<Person[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.email, u.name FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ?1 AND m.status = 'active'
       AND (m.role IN ('owner', 'admin')
         OR EXISTS (SELECT 1 FROM mailbox_access ma WHERE ma.member_id = m.id AND ma.mailbox_id = ?2 AND ma.access = 'owner'))
     LIMIT 20`,
  )
    .bind(organizationId, mailboxId)
    .all<Person>()
  return results
}

/** The tokens that sent mail through the API from this mailbox (or anywhere in the organization) in the last week. */
async function recentTokens(env: Env, organizationId: string, mailboxId: string | null): Promise<string[]> {
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString()
  const { results } = await env.DB.prepare(
    `SELECT t.name, u.name AS person, u.email, COUNT(*) AS sent FROM api_emails e
     JOIN api_tokens t ON t.id = e.token_id JOIN users u ON u.id = t.user_id
     WHERE e.organization_id = ?1 AND (?2 IS NULL OR e.mailbox_id = ?2) AND e.created_at >= ?3
     GROUP BY t.id ORDER BY sent DESC LIMIT 10`,
  )
    .bind(organizationId, mailboxId, since)
    .all<{ name: string; person: string | null; email: string; sent: number }>()
  return results.map((t) => `"${t.name}" (${t.person || t.email}, ${t.sent} ${t.sent === 1 ? 'message' : 'messages'})`)
}

/** Tells the people who can act that sending has just been suspended. `mailboxId` is the mailbox the last event was about. */
export async function notifySuspension(env: Env, organizationId: string, mailboxId: string, scope: 'mailbox' | 'organization'): Promise<void> {
  const mailbox = scope === 'mailbox' ? await mailboxesDb.find(env.DB, mailboxId) : null
  const target = scope === 'mailbox' ? mailboxId : null
  const [people, tokens] = await Promise.all([audience(env, organizationId, target), recentTokens(env, organizationId, target)])
  if (!people.length) return

  const who = mailbox ? mailbox.address : 'Your organization'
  const lines = [
    `${who} can’t send email right now, because too much of its recent mail bounced or was marked as spam. This covers mail sent in xstate, from mail apps and through the API. Reading mail still works.`,
    ...(tokens.length
      ? [
          `Part of that mail was sent through the API in the last ${DAYS} days, with ${tokens.length === 1 ? 'this token' : 'these tokens'}: ${tokens.join(', ')}. If a script is sending to addresses that don’t exist or didn’t ask for the mail, fix it first, or sending will be paused again.`,
        ]
      : []),
    `To have it reviewed and sending turned back on, write to ${SUPPORT}.`,
  ]
  const url = `${env.APP_URL.replace(/\/+$/, '')}/app/#/settings/api-keys`
  const subject = mailbox ? `Sending is paused for ${mailbox.address}` : 'Sending is paused for your organization'
  const text = `${lines.join('\n\n')}\n\nOpen API keys:\n${url}\n`
  const html = systemMailHtml({ paragraphs: lines.map((l) => paragraph(l)), button: { text: 'Open API keys', url } })
  for (const p of people) {
    await sendSystemEmail(env, { to: p, subject, text, html }).catch((err) => console.error('suspension email failed', err))
  }
}
