import type { Address, Person } from './types'

export function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const days = Math.round((Date.parse(now.toDateString()) - Date.parse(d.toDateString())) / 86_400_000)
  if (days === 0) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) })
}

export const longDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

export function relative(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'Just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  const days = Math.floor(s / 86_400)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return longDate(iso)
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** "$0.0017", "$0.013", "$18.40", "$250" (same as the API's formatUsd). */
export function formatUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
}

export function sender(list: Address[]): string {
  const a = list[0]
  return a ? a.name || a.email : '(no sender)'
}

export function initial(name: string | null | undefined): string {
  return (String(name ?? '').trim()[0] ?? '?').toUpperCase()
}

export const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)

export const personName = (p: Person) => p.name || p.email || (p.externalId ? `User ${p.externalId}` : 'Anonymous visitor')

/** "first_name" and "firstName" → "First name". */
export function label(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
