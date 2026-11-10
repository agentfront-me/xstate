// Estimated cost of a model call, from list prices in USD per million tokens (standard tier, short context, no
// caching discounts). Pure, so it runs under node:test.
//
// Sources: Anthropic's model table (claude-api reference, prices as of 2026-10-06) and OpenAI's pricing page
// (developers.openai.com/api/docs/pricing, read 2026-11-10). Update both when prices change. A model that isn't
// listed is priced at its provider's most expensive listed rate, so a spend cap is never under-counted; the
// estimate is marked as such.

type Price = { input: number; output: number }

const ANTHROPIC: Record<string, Price> = {
  'claude-fable-5-2': { input: 10, output: 50 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  // Claude Haiku 5.5: prompts up to 100K tokens; agent calls stay well under that.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

const OPENAI: Record<string, Price> = {
  'gpt-6-astra': { input: 10, output: 50 },
  'gpt-6.1-sol': { input: 2, output: 10 },
  'gpt-6.1-terra': { input: 1, output: 5 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-5.6-sol': { input: 4, output: 20 },
  'gpt-5.6-terra': { input: 2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'gpt-5.5': { input: 5, output: 30 },
  'gpt-5.5-pro': { input: 30, output: 180 },
  'gpt-5.4': { input: 2.5, output: 15 },
  'gpt-5.4-pro': { input: 30, output: 180 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.2': { input: 1.75, output: 14 },
  'gpt-5.2-pro': { input: 21, output: 168 },
  'gpt-5.1': { input: 1.25, output: 10 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-5-pro': { input: 15, output: 120 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  o3: { input: 2, output: 8 },
  'o3-pro': { input: 20, output: 80 },
}

const TABLES = { anthropic: ANTHROPIC, openai: OPENAI } as const

const priciest = (table: Record<string, Price>): Price =>
  Object.values(table).reduce((max, p) => (p.input + p.output > max.input + max.output ? p : max))

/** The price used for a model, and whether it was a fallback (model not in the table). */
export function priceOf(provider: 'anthropic' | 'openai', model: string): Price & { listed: boolean } {
  const table = TABLES[provider]
  // Dated snapshots ("claude-haiku-4-5-20251001", "gpt-5-2025-08-07") cost the same as their base id.
  const id = model.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, '')
  const price = table[id]
  return price ? { ...price, listed: true } : { ...priciest(table), listed: false }
}

/** Estimated USD for one call. */
export function costOf(provider: 'anthropic' | 'openai', model: string, tokens: { input: number; output: number }): number {
  const p = priceOf(provider, model)
  return (tokens.input * p.input + tokens.output * p.output) / 1_000_000
}

/** "$0.013", "$1.20", "$12": enough precision to be useful at each size. */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
}
