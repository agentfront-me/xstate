// The rule that keeps Stalwart from delivering mail for store-held domains to its own old accounts
// (docs/mailbox-store-plan.md, "Mail from Stalwart mailboxes to store-held ones"). Stalwart picks where queued mail
// goes with expressions in x:MtaOutboundStrategy (`route`, `schedule`): a list of `if`/`then` rules tried in order,
// then `else`. Our rule goes first and sends these domains the way mail for outside domains goes (the expression's
// own `else`), so it reaches the domain's MX (SES receiving) and the store. It is recognised by a term that is always
// true, `!is_empty('xstate:store-held')`, so other rules are never touched. Pure: `pnpm test` runs it under Node.

export type StalwartExpression = { match: Record<string, { if: string; then: string }>; else: string }

export const STORE_RULE_MARKER = "!is_empty('xstate:store-held')"

/** The expression with our rule for these domains first (or without it, for none). Everything else kept in order. */
export function withStoreRule(expr: StalwartExpression, domains: string[]): StalwartExpression {
  const others = Object.keys(expr.match ?? {})
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => expr.match[k]!)
    .filter((rule) => !rule.if.includes(STORE_RULE_MARKER))
  const names = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+$/.test(d) && d.includes('.')))].sort()
  const rules = names.length ? [{ if: `${STORE_RULE_MARKER} && (${names.map((d) => `rcpt_domain == '${d}'`).join(' || ')})`, then: expr.else }, ...others] : others
  return { match: Object.fromEntries(rules.map((r, i) => [String(i), r])), else: expr.else }
}

/** The domains our rule currently covers in an expression (empty when there is no rule). */
export function storeRuleDomains(expr: StalwartExpression): string[] {
  const rule = Object.values(expr.match ?? {}).find((r) => r.if.includes(STORE_RULE_MARKER))
  return rule ? [...rule.if.matchAll(/rcpt_domain == '([^']+)'/g)].map((m) => m[1]!).sort() : []
}
