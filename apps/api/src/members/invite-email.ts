// The invite email: plain text and a simple HTML version with one button.

import { paragraph, systemMailHtml } from '../mailserver/mail-html.ts'

export function inviteEmail(v: { url: string; organization: string; inviter: string; inviteeName: string | null; days: number }) {
  const greeting = v.inviteeName ? `Hi ${v.inviteeName.split(' ')[0]},` : 'Hi,'
  const subject = `${v.inviter} invited you to ${v.organization} on xstate`
  const line = `${v.inviter} invited you to join ${v.organization} on xstate, where your team shares email, files and agents.`
  const expires = `The link works for ${v.days} days. If you weren't expecting this, you can ignore this email.`

  const text = `${greeting}

${line}

Accept the invite:
${v.url}

${expires}
`
  const html = systemMailHtml({ paragraphs: [paragraph(greeting), paragraph(line, ';margin-bottom:22px')], button: { text: 'Accept invite', url: v.url }, footnote: expires })
  return { subject, text, html }
}
