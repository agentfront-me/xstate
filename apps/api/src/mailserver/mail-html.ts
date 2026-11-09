// The HTML of the emails xstate sends itself (invites, "your copy is ready"). No imports, so unit tests can load it
// under Node (which needs the .ts in the import path; tsconfig allows that).

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * The look of every email xstate sends itself: a card with the name on top, some paragraphs (each already escaped by
 * `paragraph`), one button, and small print under it.
 */
export function systemMailHtml(parts: { paragraphs: string[]; button: { text: string; url: string }; footnote?: string }): string {
  const e = escapeHtml
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a19">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e6e6e2;border-radius:10px;padding:28px">
<p style="margin:0 0 20px;font-weight:600;font-size:15px">xstate</p>
${parts.paragraphs.join('\n')}
<p style="margin:${parts.footnote ? '0 0 22px' : '0'}"><a href="${e(parts.button.url)}" style="display:inline-block;background:#1a1a19;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 18px;border-radius:7px">${e(parts.button.text)}</a></p>
${parts.footnote ? `<p style="margin:0;font-size:12px;line-height:1.5;color:#77776f">${e(parts.footnote)}</p>` : ''}
</div>
</body></html>`
}

/** One body paragraph, escaped. `extra` is more inline CSS (a colour, say). */
export const paragraph = (text: string, extra = '') => `<p style="margin:0 0 14px;font-size:14px;line-height:1.55${extra}">${escapeHtml(text)}</p>`
