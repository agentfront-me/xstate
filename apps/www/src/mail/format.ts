import type { Address } from '../lib/types'

export function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const days = Math.round((Date.parse(now.toDateString()) - Date.parse(d.toDateString())) / 86_400_000)
  if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function sender(list: Address[]): string {
  const a = list[0]
  return a ? a.name || a.email : '(no sender)'
}

/** A stable colour per sender, so a conversation is easy to follow at a glance. */
export function avatarStyle(email: string) {
  let h = 0
  for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360
  return { background: `hsl(${h} 45% 42%)`, borderColor: 'transparent', color: '#fff' }
}

/** Splits "a@x.com, b@y.com" into addresses, with the invalid ones separately. */
export function parseRecipients(value: string, isEmail: (v: string) => boolean) {
  const all = value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean)
  return { valid: all.filter(isEmail), invalid: all.filter((a) => !isEmail(a)) }
}
