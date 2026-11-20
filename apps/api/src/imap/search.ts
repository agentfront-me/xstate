// IMAP SEARCH (RFC 3501 §6.4.4): the search keys a mail app sends, as a tree, and that tree as SQL over the mailbox
// store's tables (messages `m` joined to placements `p`). Pure: no runtime imports, so the tests run under Node.
//
// What the store can't answer exactly, it answers closely: body words match by stem (the store's word index), the
// sent date is the received date, and a header other than the common ones is looked for anywhere in the headers.

import { parseSet, text, type Token } from './syntax.ts'

export type Flag = 'seen' | 'flagged' | 'answered' | 'draft' | 'forwarded'

export type Criterion =
  | { k: 'all' }
  | { k: 'none' }
  | { k: 'uid'; set: [number, number][] }
  /** A bare sequence set: the session turns it into `uid` before the store sees it. */
  | { k: 'seq'; set: [number, number][] }
  | { k: 'flag'; flag: Flag }
  | { k: 'date'; op: 'before' | 'on' | 'since'; day: number }
  | { k: 'size'; op: 'larger' | 'smaller'; n: number }
  | { k: 'text'; field: 'from' | 'to' | 'subject' | 'body' | 'text' | 'headers' | 'message-id'; value: string }
  | { k: 'modseq'; n: number }
  | { k: 'not'; c: Criterion }
  | { k: 'or'; a: Criterion; b: Criterion }
  | { k: 'and'; list: Criterion[] }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "2-Nov-2026" as the first second of that day, UTC. */
export function parseDate(value: string): number | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value)
  const month = m ? MONTHS.indexOf(m[2]!.toLowerCase()) : -1
  return m && month >= 0 ? Date.UTC(Number(m[3]), month, Number(m[1])) / 1000 : null
}

const not = (c: Criterion): Criterion => ({ k: 'not', c })

/** The search keys of a SEARCH command as one tree. Throws with what was wrong. */
export function parseSearch(tokens: Token[]): Criterion {
  let i = 0
  // CHARSET comes first when given. Strings are read as UTF-8 already, which covers US-ASCII too.
  if (text(tokens[0])?.toUpperCase() === 'CHARSET') {
    const charset = text(tokens[1])?.toUpperCase()
    if (charset !== 'UTF-8' && charset !== 'US-ASCII') throw new Error('[BADCHARSET (UTF-8)] Use UTF-8')
    i = 2
  }
  const string = () => {
    const v = text(tokens[i++])
    if (v === null) throw new Error('A search key is missing its value')
    return v
  }
  const number = () => {
    const n = Number(string())
    if (!Number.isInteger(n) || n < 0) throw new Error('Expected a number')
    return n
  }
  const date = () => {
    const day = parseDate(string())
    if (day === null) throw new Error('Expected a date such as 2-Nov-2026')
    return day
  }
  const one = (): Criterion => {
    const token = tokens[i++]
    if (!token) throw new Error('A search key is missing')
    if (token.t === 'list') return { k: 'and', list: parseAll(token.items) }
    const key = token.v.toUpperCase()
    switch (key) {
      case 'ALL': return { k: 'all' }
      case 'SEEN': return { k: 'flag', flag: 'seen' }
      case 'UNSEEN': return not({ k: 'flag', flag: 'seen' })
      case 'FLAGGED': return { k: 'flag', flag: 'flagged' }
      case 'UNFLAGGED': return not({ k: 'flag', flag: 'flagged' })
      case 'ANSWERED': return { k: 'flag', flag: 'answered' }
      case 'UNANSWERED': return not({ k: 'flag', flag: 'answered' })
      case 'DRAFT': return { k: 'flag', flag: 'draft' }
      case 'UNDRAFT': return not({ k: 'flag', flag: 'draft' })
      // Nothing is ever \Deleted or \Recent here (deleting arrives with phase 4).
      case 'DELETED': case 'RECENT': case 'NEW': return { k: 'none' }
      case 'UNDELETED': case 'OLD': return { k: 'all' }
      case 'KEYWORD': return string().toLowerCase() === '$forwarded' ? { k: 'flag', flag: 'forwarded' } : { k: 'none' }
      case 'UNKEYWORD': return string().toLowerCase() === '$forwarded' ? not({ k: 'flag', flag: 'forwarded' }) : { k: 'all' }
      case 'BEFORE': case 'SENTBEFORE': return { k: 'date', op: 'before', day: date() }
      case 'ON': case 'SENTON': return { k: 'date', op: 'on', day: date() }
      case 'SINCE': case 'SENTSINCE': return { k: 'date', op: 'since', day: date() }
      case 'LARGER': return { k: 'size', op: 'larger', n: number() }
      case 'SMALLER': return { k: 'size', op: 'smaller', n: number() }
      case 'FROM': return { k: 'text', field: 'from', value: string() }
      case 'TO': return { k: 'text', field: 'to', value: string() }
      case 'SUBJECT': return { k: 'text', field: 'subject', value: string() }
      case 'BODY': return { k: 'text', field: 'body', value: string() }
      case 'TEXT': return { k: 'text', field: 'text', value: string() }
      case 'CC': case 'BCC': return { k: 'text', field: 'headers', value: string() }
      case 'HEADER': {
        const name = string().toLowerCase()
        const value = string()
        if (name === 'message-id') return { k: 'text', field: 'message-id', value: value.replace(/^<|>$/g, '') }
        const field = name === 'from' || name === 'to' || name === 'subject' ? name : 'headers'
        // HEADER X "" asks only whether the header exists.
        return { k: 'text', field, value: value || `${name}:` }
      }
      case 'UID': {
        const set = parseSet(string())
        if (!set) throw new Error('Expected a UID set')
        return { k: 'uid', set }
      }
      case 'MODSEQ': return { k: 'modseq', n: number() }
      case 'NOT': return not(one())
      case 'OR': return { k: 'or', a: one(), b: one() }
      default: {
        const set = parseSet(token.v)
        if (set) return { k: 'seq', set }
        throw new Error(`Unknown search key ${key}`)
      }
    }
  }
  const parseAll = (list: Token[]): Criterion[] => {
    const saved = [tokens, i] as const
    tokens = list
    i = 0
    const out: Criterion[] = []
    while (i < tokens.length) out.push(one())
    ;[tokens, i] = saved
    return out
  }
  const list: Criterion[] = []
  while (i < tokens.length) list.push(one())
  return list.length === 1 ? list[0]! : { k: 'and', list }
}

/** Replaces every bare sequence set with the UIDs it stands for. */
export function resolveSequences(c: Criterion, toUids: (set: [number, number][]) => number[]): Criterion {
  switch (c.k) {
    case 'seq': {
      const uids = toUids(c.set)
      return uids.length ? { k: 'uid', set: uids.map((u) => [u, u]) } : { k: 'none' }
    }
    case 'not': return { k: 'not', c: resolveSequences(c.c, toUids) }
    case 'or': return { k: 'or', a: resolveSequences(c.a, toUids), b: resolveSequences(c.b, toUids) }
    case 'and': return { k: 'and', list: c.list.map((x) => resolveSequences(x, toUids)) }
    default: return c
  }
}

const FLAG_SQL: Record<Flag, string> = {
  seen: 'm.seen = 1',
  flagged: 'm.pinned = 1',
  answered: 'COALESCE(m.answered, 0) = 1',
  draft: 'COALESCE(m.is_draft, 0) = 1',
  forwarded: 'COALESCE(m.forwarded, 0) = 1',
}
const TOP = 4294967295
const contains = (column: string) => `instr(lower(${column}), lower(?)) > 0`

/** The tree as a SQL condition and its parameters. */
export function searchSql(c: Criterion): { sql: string; params: (string | number)[] } {
  switch (c.k) {
    case 'all': return { sql: '1', params: [] }
    case 'none': case 'seq': return { sql: '0', params: [] }
    case 'flag': return { sql: FLAG_SQL[c.flag], params: [] }
    case 'uid': {
      if (!c.set.length) return { sql: '0', params: [] }
      return { sql: `(${c.set.map(() => 'p.uid BETWEEN ? AND ?').join(' OR ')})`, params: c.set.flatMap(([a, b]) => [Math.min(a, TOP), Math.min(b, TOP)]) }
    }
    case 'date':
      if (c.op === 'before') return { sql: 'm.received_s < ?', params: [c.day] }
      if (c.op === 'since') return { sql: 'm.received_s >= ?', params: [c.day] }
      return { sql: 'm.received_s >= ? AND m.received_s < ?', params: [c.day, c.day + 86400] }
    case 'size': return { sql: `COALESCE(m.raw_size, m.size) ${c.op === 'larger' ? '>' : '<'} ?`, params: [c.n] }
    case 'modseq': return { sql: 'COALESCE(m.modseq, 0) >= ?', params: [c.n] }
    case 'text': {
      if (c.field === 'from') return { sql: contains('m.from_json'), params: [c.value] }
      if (c.field === 'to') return { sql: contains('m.to_json'), params: [c.value] }
      if (c.field === 'subject') return { sql: contains('m.subject'), params: [c.value] }
      if (c.field === 'message-id') return { sql: contains('m.message_id'), params: [c.value] }
      if (c.field === 'headers') return { sql: contains('m.imap_meta'), params: [c.value] }
      // The word index has no positions, so a phrase is its words, all of them.
      const words = c.value.match(/[\p{L}\p{N}]+/gu) ?? []
      const body = words.length
        ? { sql: 'm.n IN (SELECT rowid FROM text_fts WHERE text_fts MATCH ?)', params: [words.map((w) => `"${w}"`).join(' AND ')] }
        : { sql: '1', params: [] }
      if (c.field === 'body') return body
      return { sql: `(${body.sql} OR ${contains('m.subject')} OR ${contains('m.from_json')} OR ${contains('m.to_json')})`, params: [...body.params, c.value, c.value, c.value] }
    }
    case 'not': {
      const inner = searchSql(c.c)
      return { sql: `NOT (${inner.sql})`, params: inner.params }
    }
    case 'or': {
      const a = searchSql(c.a)
      const b = searchSql(c.b)
      return { sql: `((${a.sql}) OR (${b.sql}))`, params: [...a.params, ...b.params] }
    }
    case 'and': {
      if (!c.list.length) return { sql: '1', params: [] }
      const parts = c.list.map(searchSql)
      return { sql: `(${parts.map((p) => `(${p.sql})`).join(' AND ')})`, params: parts.flatMap((p) => p.params) }
    }
  }
}
