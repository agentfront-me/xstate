// What the Google Workspace migration wizard works with: the shapes the migration API returns
// (apps/api/src/migration/service.ts). ./api.ts calls the API when signed in and simulates everything in demo mode.

export type Permission = 'directory' | 'gmail' | 'contacts' | 'drive' | 'calendar'

export type Stage = 'connect' | 'discover' | 'plan' | 'review' | 'copying' | 'switch' | 'final' | 'finish' | 'done'

/** The eight steps in the step bar, in order. `done` is the final screen after step 8. */
export const STEPS: { stage: Exclude<Stage, 'done'>; label: string }[] = [
  { stage: 'connect', label: 'Connect' },
  { stage: 'discover', label: 'Discover' },
  { stage: 'plan', label: 'Plan' },
  { stage: 'review', label: 'Review' },
  { stage: 'copying', label: 'Copying' },
  { stage: 'switch', label: 'Switch' },
  { stage: 'final', label: 'Final sync' },
  { stage: 'finish', label: 'Finish' },
]

export const stepIndex = (stage: Stage) => (stage === 'done' ? STEPS.length : STEPS.findIndex((s) => s.stage === stage))

export type Connection = {
  adminEmail: string
  checks: Record<Permission, boolean>
  verifiedAt: string
}

export type GoogleUser = {
  id: string
  name: string
  email: string
  suspended: boolean
  mailBytes: number
  driveBytes: number
  /** Null when Google wouldn't say (suspended people can't be read) or counting failed. */
  messages: number | null
  contacts: number | null
  files: number | null
  /** Why a count is missing. */
  countNote?: string
  /** The xstate mailbox with the same address, when there already is one. */
  existingMailbox?: string
}

export type GoogleGroup = { id: string; email: string; members: number; note?: string }
/** Size and file count are null until copying counts them (Google has no cheap way to ask). */
export type SharedDrive = { id: string; name: string; bytes: number | null; members: number | null; files: number | null }
export type WorkspaceDomain = { name: string; kind: 'primary' | 'secondary' | 'alias'; inXstate: boolean }

export type Discovery = {
  domain: string
  users: GoogleUser[]
  groups: GoogleGroup[]
  drives: SharedDrive[]
  domains: WorkspaceDomain[]
  aliases: number
}

export type Action = 'create' | 'existing' | 'shared' | 'skip'
export type Part = 'mail' | 'contacts' | 'drive' | 'calendar'

export type UserPlan = { action: Action; existing?: string; mail: boolean; contacts: boolean; drive: boolean; calendar: boolean }
export type MailRange = 'all' | '5y' | '3y' | '1y'

export type Plan = {
  users: Record<string, UserPlan>
  groups: Record<string, boolean>
  drives: Record<string, boolean>
  mailRange: MailRange
}

export type Count = { done: number; total: number }

export type UserState = 'waiting' | 'copying' | 'slowed' | 'attention' | 'paused' | 'done'

export type UserProgress = {
  user: GoogleUser
  action: Action
  mail: Count | null
  contacts: Count | null
  drive: Count | null
  /** Calendar events: Google gives no total up front, so `total` is what's been handled (plus one while copying). */
  calendar?: Count | null
  /** Drive is counted in bytes for very large drives, so the column reads "1.2 TB of 2.0 TB". */
  driveBytes?: Count
  state: UserState
  issue?: string
  /** From the API: what needs attention, in words. */
  issueText?: string
  /** Planned parts this version doesn't copy yet (contacts and Drive until phases 3 and 4). */
  later?: Part[]
}

export type CopyStatus = {
  users: UserProgress[]
  percent: number
  doneUsers: number
  /** Seconds left, roughly. */
  remaining: number
  paused: boolean
  /** Google stopped accepting xstate's access while copying. */
  accessLost: boolean
  pausedAt?: string
  finished: boolean
  totals: { messages: number; contacts: number; files: number; events?: number }
}

export type DnsRecordRow = { type: 'MX' | 'TXT' | 'CNAME' | string; name: string; value: string; found: boolean; required?: boolean }

export type SwitchStatus = {
  ttlDone: boolean
  records: DnsRecordRow[]
  detectedAt?: string
  provider: string | null
  /** From the API: every required record of every domain is found (optional ones may still be missing). */
  detected?: boolean
  /** One-click setup at the DNS host (Domain Connect), when it supports it. */
  applyUrl?: string | null
}

/** A part of the final sync. From the API, `done` is the changes copied so far and `people` how many are finished. */
export type FinalPart = Count & { running?: boolean; people?: Count }

export type FinalStatus = {
  mail: FinalPart
  contacts: FinalPart
  calendar?: FinalPart
  drive: FinalPart
  finished: boolean
  rerunAt: string
}

export type ReportRow = { name: string; shared: boolean; messages: number; contacts: number | null; events?: number | null; files: number }
export type Skipped = { count: number; label: string; reason: string }

export type FinishStatus = {
  accessRemoved: boolean
  accessRemovedAt?: string | null
  /** When xstate checks again whether its Google access is gone. */
  nextCheckAt: string
  invitesSent: boolean
  /** `sendTo`: the personal address their invite goes to; without one, the admin gets their link to pass on. */
  newMembers: { name: string; email: string; sendTo?: string | null }[]
  report: ReportRow[]
  skipped: Skipped[]
  /** The list of skipped items is deleted 30 days after finishing (the counts stay). */
  skippedKeptUntil?: string | null
  skippedDeleted?: boolean
}

/** Everything the wizard shows. One per organization. */
export type Migration = {
  stage: Stage
  startedBy: { name: string; email: string }
  /** When the admin last opened the wizard (for the "welcome back" note). */
  lastSeenAt: string
  connection: Connection | null
  discovery: Discovery | null
  plan: Plan | null
  finishedAt?: string | null
  /** From the API (not in demo mode): background progress of discovery and of Start. */
  discoveryStatus?: { state: 'idle' | 'running' | 'done' | 'failed'; error: string | null; partsDone: number; counted: number; total: number }
  apply?: { state: 'idle' | 'running' | 'done' | 'failed'; error: string | null; done: number; failed: number; total: number }
  google?: { clientId: string | null; configured: boolean; scopes: { id: Permission; scopes: string[] }[] }
}
