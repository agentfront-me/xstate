// A Google contact as audience attributes. Pure (tested in contact-rules.test.ts).

import type { Attributes } from '../audience/types'
import type { GContact } from './google/workspace'

/** Attribute values are capped by the audience API. */
const MAX_VALUE = 500

/** A Google contact as audience attributes: only what's set. Labels are names, joined. */
export function contactAttributes(c: GContact, groups: Map<string, string>, other: boolean): Attributes {
  const clip = (s: string) => s.slice(0, MAX_VALUE)
  const labels = c.labels.map((id) => groups.get(id)).filter((x): x is string => !!x)
  const attrs: Attributes = { googleId: clip(c.id) }
  if (c.emails.length > 1) attrs.emails = clip(c.emails.slice(1).join(', '))
  if (c.phones.length > 1) attrs.phones = clip(c.phones.slice(1).join(', '))
  if (c.company) attrs.company = clip(c.company)
  if (c.title) attrs.title = clip(c.title)
  if (c.addresses.length) attrs.address = clip(c.addresses.join('; '))
  if (c.birthday) attrs.birthday = c.birthday
  if (c.notes) attrs.notes = clip(c.notes)
  if (labels.length) attrs.labels = clip(labels.join(', '))
  if (other) attrs.other = true
  return attrs
}
