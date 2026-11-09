// The email to the admin who started a Google Workspace import, once everything is copied (./watchdog.ts).

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

  const e = escapeHtml
  const p = (s: string, extra = '') => `<p style="margin:0 0 14px;font-size:14px;line-height:1.55${extra}">${e(s)}</p>`
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a19">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e6e6e2;border-radius:10px;padding:28px">
<p style="margin:0 0 20px;font-weight:600;font-size:15px">xstate</p>
${p(greeting)}
${p(copied)}
${attention ? p(attention, ';color:#8a4b00') : ''}
${p(next, ';margin-bottom:22px')}
<p style="margin:0"><a href="${e(v.url)}" style="display:inline-block;background:#1a1a19;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 18px;border-radius:7px">Open the import</a></p>
</div>
</body></html>`

  return { subject, text, html }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
