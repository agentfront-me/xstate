// Funnels (docs/analytics-plan.md, phase 4): ordered steps people take, counted per person within a conversion
// window. Shapes, validation and the SQL a funnel compiles to; AudienceStore runs it (store.ts computeFunnel).
//
// Step 1 is the first matching event per person in the date range. Each later step is that person's first matching
// event at or after the previous step, and no later than step 1 + the window. Counts are people (users and
// anonymous visitors). Page steps match the path, with * as a wildcard ("/products/*").

import { z } from 'zod'

export const EMAIL_EVENTS = ['$email_received', '$email_replied', '$email_sent', '$email_bounced', '$email_complained'] as const

export const funnelStep = z.discriminatedUnion('type', [
  z.object({ type: z.literal('page'), match: z.string().trim().min(1).max(300).regex(/^\//, 'Page paths start with /') }),
  z.object({ type: z.literal('track'), match: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal('email'), match: z.enum(EMAIL_EVENTS) }),
])
export type FunnelStep = z.output<typeof funnelStep>

export const funnelInput = z.object({
  name: z.string().trim().min(1).max(60),
  steps: z.array(funnelStep).min(2, 'A funnel needs at least two steps').max(10),
  windowDays: z.number().int().min(1).max(90).default(7),
})
export type FunnelInput = z.output<typeof funnelInput>

export type Funnel = FunnelInput & { id: string; createdAt: string; updatedAt: string }

export const FUNNEL_RANGES = [7, 30, 90] as const
export type FunnelRange = (typeof FUNNEL_RANGES)[number]

export type FunnelStepResult = {
  /** People who reached this step. */
  people: number
  /** Of those who reached the step before; null for the first step. */
  fromPrevious: number | null
  /** Reached the step before but not this one. */
  dropped: number | null
  /** Median time from the previous step, in seconds. */
  medianSeconds: number | null
}

export type FunnelResult = {
  steps: FunnelStepResult[]
  /** People who completed every step, as a share of step 1 (0 to 1). */
  conversion: number
  range: FunnelRange
  computedAt: string
}

type Binding = string | number | null

/** `*` is the only wildcard; GLOB's own [ ] ? are taken literally. */
export function globOf(pattern: string): string {
  return pattern.replace(/[[\]?]/g, (c) => (c === '[' ? '[[]' : c === ']' ? '[]]' : '[?]'))
}

/** The WHERE condition (on events `e`) for one step. */
export function stepCondition(step: FunnelStep): { sql: string; args: Binding[] } {
  switch (step.type) {
    case 'page':
      return step.match.includes('*')
        ? { sql: "e.name = '$pageview' AND e.path GLOB ?", args: [globOf(step.match)] }
        : { sql: "e.name = '$pageview' AND e.path = ?", args: [step.match] }
    case 'track':
      return { sql: "e.name = ? AND e.type = 'track'", args: [step.match] }
    case 'email':
      return { sql: "e.name = ? AND e.type = 'email'", args: [step.match] }
  }
}

/**
 * One query giving, per person who did step 1, the time they reached each step (NULL from where they stopped).
 * `domain` scopes step 1 (a person belongs to one site, so the rest follow).
 */
export function funnelQuery(funnel: Pick<FunnelInput, 'steps' | 'windowDays'>, since: string, domain?: string): { sql: string; args: Binding[] } {
  const args: Binding[] = []
  const ctes: string[] = []
  funnel.steps.forEach((step, i) => {
    const c = stepCondition(step)
    if (i === 0) {
      const scope = domain ? " AND (e.domain = ? OR substr(e.domain, -length(?) - 1) = '.' || ?)" : ''
      ctes.push(`s0 AS (SELECT e.person_id, min(e.occurred_at) AS t, min(e.occurred_at) AS t0 FROM events e WHERE ${c.sql} AND e.occurred_at >= ?${scope} GROUP BY e.person_id)`)
      args.push(...c.args, since, ...(domain ? [domain, domain, domain] : []))
      return
    }
    ctes.push(
      `s${i} AS (SELECT p.person_id, min(e.occurred_at) AS t, p.t0 FROM s${i - 1} p JOIN events e ON e.person_id = p.person_id AND ${c.sql}
        AND e.occurred_at >= p.t AND e.occurred_at <= strftime('%Y-%m-%dT%H:%M:%fZ', p.t0, '+${funnel.windowDays} days') GROUP BY p.person_id)`,
    )
    args.push(...c.args)
  })
  const cols = funnel.steps.map((_, i) => `s${i}.t AS t${i}`).join(', ')
  const joins = funnel.steps
    .slice(1)
    .map((_, j) => `LEFT JOIN s${j + 1} ON s${j + 1}.person_id = s0.person_id`)
    .join(' ')
  return { sql: `WITH ${ctes.join(', ')} SELECT ${cols} FROM s0 ${joins}`, args }
}

const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2)
}

/** Counts, drop-offs and median times from the per-person rows funnelQuery returns. */
export function summarize(rows: Record<string, string | null>[], stepCount: number, range: FunnelRange): FunnelResult {
  const people = Array.from({ length: stepCount }, () => 0)
  const gaps: number[][] = Array.from({ length: stepCount }, () => [])
  for (const row of rows) {
    for (let i = 0; i < stepCount; i++) {
      const t = row[`t${i}`]
      if (!t) break
      people[i]!++
      if (i > 0) gaps[i]!.push((Date.parse(t) - Date.parse(row[`t${i - 1}`]!)) / 1000)
    }
  }
  const steps = people.map((n, i) => ({
    people: n,
    fromPrevious: i === 0 ? null : people[i - 1] ? n / people[i - 1]! : 0,
    dropped: i === 0 ? null : people[i - 1]! - n,
    medianSeconds: i === 0 ? null : median(gaps[i]!),
  }))
  return { steps, conversion: people[0] ? people[stepCount - 1]! / people[0] : 0, range, computedAt: new Date().toISOString() }
}
