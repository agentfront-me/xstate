// The email to the admin who started a Google Workspace import, once everything is copied (./watchdog.ts).

import { paragraph, systemMailHtml } from '../mailserver/mail-html.ts'

export function readyEmail(v: {
  url: string
  organization: string
  domain: string | null
  adminName: string | null
  people: number
  messages: number
  contacts: number
  files: number
  attention: number
}) {
  const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`
  const greeting = v.adminName ? `Hi ${v.adminName.split(' ')[0]},` : 'Hi,'
  const subject = `Your Google Workspace copy is ready${v.domain ? ` (${v.domain})` : ''}`
  const copied = `xstate has copied ${n(v.messages, 'message')}, ${n(v.contacts, 'contact')} and ${n(v.files, 'file')} for ${n(v.people, 'person', 'people')} in ${v.organization}.`
  const attention =
    v.attention > 0
      ? `${n(v.attention, 'person or shared drive', 'people or shared drives')} need${v.attention === 1 ? 's' : ''} your attention first. The import page says what's wrong and how to fix it.`
      : null
  const next =
    'When you are ready, switch your mail over to xstate. The import page walks you through it: change a few DNS records, then xstate copies whatever arrived in Google in the meantime.'

  const text = `${greeting}

${copied}
${attention ? `\n${attention}\n` : ''}
${next}

Open the import:
${v.url}
`

  const html = systemMailHtml({
    paragraphs: [paragraph(greeting), paragraph(copied), ...(attention ? [paragraph(attention, ';color:#8a4b00')] : []), paragraph(next, ';margin-bottom:22px')],
    button: { text: 'Open the import', url: v.url },
  })
  return { subject, text, html }
}
