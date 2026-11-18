// The virus-scan state of an attachment received into a store-held mailbox (docs/mailbox-store-plan.md, phase 2
// step 4c), and what it means for the reader and for downloads. Pure: no runtime imports, so `pnpm test` runs it
// directly under Node.

import type { Safety } from '../security/attachments'

/** Received: `scanning` until the scanner answers. Sent mail and copies from Stalwart have none (null): not gated. */
export type ScanState = 'scanning' | 'clean' | 'infected' | 'unscannable'

type Mode = 'live' | 'log' | 'fake' | 'off'

/** What the scanner said: a verdict, or that it couldn't be reached. */
export type ScanOutcome = { infected: false } | { infected: true; virus: string } | { unavailable: true }

/**
 * The state to record, or 'retry' to try the scan again later. In `log` mode nothing is ever held back: every
 * attachment ends `clean` (what ClamAV found is logged by the scan itself). In `live` and `fake`, a virus is
 * `infected`; a scanner that stays unreachable until the last try makes the attachment `unscannable`, so mail is
 * never held for long by a broken scanner.
 */
export function scanState(mode: Mode, outcome: ScanOutcome, lastAttempt: boolean): ScanState | 'retry' {
  if (mode === 'off' || mode === 'log') return 'clean'
  if ('unavailable' in outcome) return lastAttempt ? 'unscannable' : 'retry'
  return outcome.infected ? 'infected' : 'clean'
}

/** How a scan state shows on the attachment in the reader (the web app shows `blocked` and `warn` already). */
export function scanSafety(state: ScanState | null, virus: string | null): Safety | null {
  if (state === 'scanning') return { level: 'blocked', code: 'scanning', message: 'Being checked for viruses. Try again in a moment.' }
  if (state === 'infected') return { level: 'blocked', code: 'virus', message: `Contains a virus (${virus ?? 'unknown'}). It can't be downloaded.` }
  if (state === 'unscannable') return { level: 'warn', code: 'unscanned', message: "Couldn't be checked for viruses. Open it only if you trust the sender." }
  return null
}

/** Whether a download may go ahead: never while scanning, never when infected. */
export function scanAllows(state: ScanState | null): { ok: true } | { ok: false; status: 409 | 403; code: string; message: string } {
  if (state === 'scanning') return { ok: false, status: 409, code: 'attachment_scanning', message: 'This attachment is still being checked for viruses. Try again in a moment.' }
  if (state === 'infected') return { ok: false, status: 403, code: 'attachment_blocked', message: 'This attachment contains a virus and can’t be downloaded.' }
  return { ok: true }
}
