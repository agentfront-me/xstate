// The password reset email an admin sends a member: plain text and a simple HTML version with one button.

import { paragraph, systemMailHtml } from '../mailserver/mail-html.ts'

export function resetEmail(v: { url: string; organization: string; sender: string; name: string | null; email: string; hours: number }) {
  const greeting = v.name ? `Hi ${v.name.split(' ')[0]},` : 'Hi,'
  const subject = `Choose a new password for ${v.email}`
  const line = `${v.sender} at ${v.organization} sent you a link to choose a new password for ${v.email} on xstate.`
  const expires = `The link works for ${v.hours} hours. If you weren't expecting this, you can ignore this email: your password stays the same.`

  const text = `${greeting}

${line}

Choose a new password:
${v.url}

${expires}
`
  const html = systemMailHtml({ paragraphs: [paragraph(greeting), paragraph(line, ';margin-bottom:22px')], button: { text: 'Choose a new password', url: v.url }, footnote: expires })
  return { subject, text, html }
}
