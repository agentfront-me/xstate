// Approval conditions ("needs approval when amount > 100"). Pure, so it runs under node:test.

export type Condition = { field: string; op: 'gt' | 'lt' | 'eq' | 'contains'; value: string | number }

/** The value at a dotted path in a tool call's input ("amount", "order.total"). */
export function valueAt(input: unknown, path: string): unknown {
  let value: unknown = input
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

/**
 * Whether a call's input matches a condition. A field that's missing or of the wrong type matches, so a call the
 * condition can't judge still asks a person rather than slipping through.
 */
export function matches(condition: Condition, input: unknown): boolean {
  const actual = valueAt(input, condition.field)
  if (actual === undefined || actual === null) return true
  const expected = condition.value
  switch (condition.op) {
    case 'gt':
    case 'lt': {
      const a = typeof actual === 'number' ? actual : Number(actual)
      const b = typeof expected === 'number' ? expected : Number(expected)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return true
      return condition.op === 'gt' ? a > b : a < b
    }
    case 'eq':
      return String(actual).toLowerCase() === String(expected).toLowerCase()
    case 'contains': {
      const haystack = typeof actual === 'string' ? actual : JSON.stringify(actual)
      return haystack.toLowerCase().includes(String(expected).toLowerCase())
    }
  }
}

/** "amount > 100", for the UI and the run log. */
export function describeCondition(c: Condition): string {
  const op = { gt: '>', lt: '<', eq: 'is', contains: 'contains' }[c.op]
  return `${c.field} ${op} ${c.value}`
}

/** A tool name the providers accept ([a-zA-Z0-9_-], 64 at most) for a connector's tool. */
export function connectorToolName(connectorName: string, tool: string, taken: Set<string>): string {
  const slug = connectorName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'connector'
  const base = `${slug}__${tool.replace(/[^a-zA-Z0-9_-]+/g, '_')}`.slice(0, 64)
  let name = base
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 60)}_${i}`
  taken.add(name)
  return name
}
