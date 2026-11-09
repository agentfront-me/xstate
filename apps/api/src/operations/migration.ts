import { z } from 'zod'
import {
  cancel,
  checkAccess,
  copyStatus,
  fixUser,
  getMigration,
  pause,
  resume,
  savePlan,
  setStage,
  start,
  startDiscovery,
  startNew,
  STAGES,
  verify,
} from '../migration/service'
import { finalStatus, finishStatus, markTtlDone, reportCsv, sendInvites, startFinal, switchStatus } from '../migration/cutover'
import { accessReminder } from '../migration/watchdog'
import { defineOperation } from './define'

const organizationId = z.string().min(1).max(64)
const userPlan = z.object({
  action: z.enum(['create', 'existing', 'shared', 'skip']),
  existing: z.string().max(254).optional(),
  mail: z.boolean(),
  contacts: z.boolean(),
  drive: z.boolean(),
})

// The whole migration API is kept off MCP: it reads entire Workspace domains and creates members and mailboxes.

export const migrationGet = defineOperation({
  name: 'migration_get',
  description:
    "The organization's Google Workspace import: its step, the Google connection, discovery (users, groups, shared drives, domains with counts) and the plan. Opening it as an admin starts one.",
  input: z.object({ organizationId }),
  http: { method: 'GET', path: '/migration/orgs/:organizationId' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ migration: await getMigration(env, actor, input.organizationId) }),
})

export const migrationSetStage = defineOperation({
  name: 'migration_set_stage',
  description: 'Moves the import wizard to another step.',
  input: z.object({ organizationId, stage: z.enum(STAGES) }),
  http: { method: 'POST', path: '/migration/orgs/:organizationId/stage' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ migration: await setStage(env, actor, input.organizationId, input.stage) }),
})

export const migrationVerify = defineOperation({
  name: 'migration_verify',
  description: 'Checks that Domain-wide delegation lets xstate read the Workspace, acting as this super admin. Returns pass or fail per permission.',
  input: z.object({ organizationId, adminEmail: z.email().max(254) }),
  http: { method: 'POST', path: '/migration/orgs/:organizationId/verify' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ migration: await verify(env, actor, input.organizationId, input.adminEmail) }),
})

export const migrationDiscover = defineOperation({
  name: 'migration_discover',
  description: 'Starts counting what is in the Workspace (users, groups, domains, shared drives, sizes). Runs in the background; poll migration_get.',
  input: z.object({ organizationId }),
  http: { method: 'POST', path: '/migration/orgs/:organizationId/discover' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ migration: await startDiscovery(env, actor, input.organizationId) }),
})

export const migrationSavePlan = defineOperation({
  name: 'migration_save_plan',
  description: 'Saves what happens to each Google user, which groups become shared mailboxes, which shared drives move, and the mail date range.',
  input: z.object({
    organizationId,
    users: z.record(z.string().max(64), userPlan),
    groups: z.record(z.string().max(128), z.boolean()),
    drives: z.record(z.string().max(128), z.boolean()),
    mailRange: z.enum(['all', '5y', '3y', '1y']),
  }),
  http: { method: 'PUT', path: '/migration/orgs/:organizationId/plan' },
  mcp: false,
  run: ({ env, actor }, { organizationId: org, ...plan }) => savePlan(env, actor, org, plan),
})

export const migrationStart = defineOperation({
  name: 'migration_start',
  description: 'Starts the migration: creates the planned members, mailboxes, aliases and shared mailboxes in the background.',
  input: z.object({ organizationId }),
  http: { method: 'POST', path: '/migration/orgs/:organizationId/start' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ migration: await start(env, actor, input.organizationId) }),
})

export const migrationCopyStatus = defineOperation({
  name: 'migration_copy_status',
  description: 'Copying progress: per person, how much mail is copied and whether anything needs attention; overall percent and time left.',
  input: z.object({ organizationId }),
  http: { method: 'GET', path: '/migration/orgs/:organizationId/copy' },
  mcp: false,
  run: ({ env, actor }, input) => copyStatus(env, actor, input.organizationId),
})

const control = (name: string, path: string, description: string, fn: typeof pause) =>
  defineOperation({
    name,
    description,
    input: z.object({ organizationId }),
    http: { method: 'POST', path: `/migration/orgs/:organizationId/${path}` },
    mcp: false,
    run: ({ env, actor }, input) => fn(env, actor, input.organizationId),
  })

export const migrationPause = control('migration_pause', 'pause', 'Pauses copying. Nothing is read from Google until resumed.', pause)
export const migrationResume = control('migration_resume', 'resume', 'Resumes copying where it stopped.', resume)
export const migrationCancel = control('migration_cancel', 'cancel', 'Cancels the migration. What was already copied stays in xstate.', cancel)

export const migrationCheckAccess = defineOperation({
  name: 'migration_check_access',
  description: "After Google access was removed mid-copy: checks it again, and resumes copying if it's back.",
  input: z.object({ organizationId }),
  http: { method: 'POST', path: '/migration/orgs/:organizationId/check-access' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ ok: await checkAccess(env, actor, input.organizationId) }),
})

export const migrationFixUser = defineOperation({
  name: 'migration_fix_user',
  description: "Unblocks one person's copy: 'raise' removes their xstate mailbox quota, 'retry' tries again, 'skip' gives up on the part (mail, contacts or Drive) that needs attention.",
  input: z.object({ organizationId, googleId: z.string().min(1).max(64), fix: z.enum(['raise', 'retry', 'skip']) }),
  http: { method: 'POST', path: '/migration/orgs/:organizationId/users/:googleId/fix' },
  mcp: false,
  run: ({ env, actor }, input) => fixUser(env, actor, input.organizationId, input.googleId, input.fix),
})

const orgOp = <T>(name: string, method: 'GET' | 'POST', path: string, description: string, fn: (env: Env, actor: { userId: string }, org: string) => Promise<T>) =>
  defineOperation({
    name,
    description,
    input: z.object({ organizationId }),
    http: { method, path: `/migration/orgs/:organizationId/${path}` },
    mcp: false,
    run: ({ env, actor }, input) => fn(env, actor, input.organizationId),
  })

export const migrationSwitchStatus = orgOp('migration_switch_status', 'GET', 'switch', "The DNS records that point the Workspace's domains at xstate, checked live, and whether they're all found.", switchStatus)
export const migrationTtlDone = orgOp('migration_switch_ttl_done', 'POST', 'switch/ttl', 'Marks the "lower the MX TTL" step done.', markTtlDone)
export const migrationStartFinal = orgOp('migration_start_final', 'POST', 'final', 'Starts the final sync once the records are found. A second pass runs by itself 24 hours later.', startFinal)
export const migrationFinalStatus = orgOp('migration_final_status', 'GET', 'final', 'Progress of the final sync: changes copied per part, and when the second pass runs.', finalStatus)
export const migrationFinishStatus = orgOp('migration_finish_status', 'GET', 'finish', "Finish: whether xstate's Google access is gone (checked at most once a minute), the new members to invite, and the report.", finishStatus)
export const migrationSendInvites = orgOp('migration_send_invites', 'POST', 'finish/invites', 'Sends the new members their invites at the personal address Google had for them; returns the links of anyone without one.', sendInvites)
export const migrationReport = orgOp('migration_report', 'GET', 'report.csv', 'The report as CSV: counts per person and every skipped item with its reason.', reportCsv)

export const migrationAccessReminder = orgOp(
  'migration_access_reminder',
  'GET',
  'access-reminder',
  "For Settings: whether an import that ended left xstate able to read the organization's Google Workspace (admins only).",
  accessReminder,
)

export const migrationStartNew = defineOperation({
  name: 'migration_start_new',
  description: 'Starts another import once the last one is finished or cancelled (the Done screen). Returns the one in progress if there is one.',
  input: z.object({ organizationId }),
  http: { method: 'POST', path: '/migration/orgs/:organizationId/new' },
  mcp: false,
  run: async ({ env, actor }, input) => ({ migration: await startNew(env, actor, input.organizationId) }),
})

export const migrationOperations = [
  migrationStartNew,
  migrationAccessReminder,
  migrationSwitchStatus,
  migrationTtlDone,
  migrationStartFinal,
  migrationFinalStatus,
  migrationFinishStatus,
  migrationSendInvites,
  migrationReport,
  migrationGet,
  migrationSetStage,
  migrationVerify,
  migrationDiscover,
  migrationSavePlan,
  migrationStart,
  migrationCopyStatus,
  migrationPause,
  migrationResume,
  migrationCancel,
  migrationCheckAccess,
  migrationFixUser,
]
