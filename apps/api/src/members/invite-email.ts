// The invite email: plain text and a simple HTML version with one button.

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

  const e = escapeHtml
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a19">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e6e6e2;border-radius:10px;padding:28px">
<p style="margin:0 0 20px;font-weight:600;font-size:15px">xstate</p>
<p style="margin:0 0 12px;font-size:14px;line-height:1.55">${e(greeting)}</p>
<p style="margin:0 0 22px;font-size:14px;line-height:1.55">${e(line)}</p>
<p style="margin:0 0 22px"><a href="${e(v.url)}" style="display:inline-block;background:#1a1a19;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 18px;border-radius:7px">Accept invite</a></p>
<p style="margin:0;font-size:12px;line-height:1.5;color:#77776f">${e(expires)}</p>
</div>
</body></html>`

  return { subject, text, html }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
