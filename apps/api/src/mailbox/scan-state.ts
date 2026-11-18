// The virus-scan state of an attachment, from when xstate scanned received attachments itself (until 2026-11-18;
// SES scans received mail now, and mail it flags is never delivered). New attachments have none. Kept so the ones
// found infected then stay blocked. Pure: no runtime imports, so `pnpm test` runs it directly under Node.

import type { Safety } from '../security/attachments'

export type ScanState = 'scanning' | 'clean' | 'infected' | 'unscannable'

/** How a scan state shows on the attachment in the reader (the web app shows `blocked` and `warn` already). */
export function scanSafety(state: ScanState | null, virus: string | null): Safety | null {
  if (state === 'infected') return { level: 'blocked', code: 'virus', message: `Contains a virus (${virus ?? 'unknown'}). It can't be downloaded.` }
  if (state === 'unscannable') return { level: 'warn', code: 'unscanned', message: "Couldn't be checked for viruses. Open it only if you trust the sender." }
  return null
}

/** Whether a download may go ahead: never when infected. `scanning` no longer holds anything back: nothing finishes it. */
export function scanAllows(state: ScanState | null): { ok: true } | { ok: false; status: 403; code: string; message: string } {
  if (state === 'infected') return { ok: false, status: 403, code: 'attachment_blocked', message: 'This attachment contains a virus and can’t be downloaded.' }
  return { ok: true }
}
