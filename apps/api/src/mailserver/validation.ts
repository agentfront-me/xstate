import { EmailError } from './errors'

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
// No '+': sub-addressing is on, so 'asif+news@' already delivers to 'asif@'.
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

export function normalizeDomain(name: string): string {
  const domain = name.trim().toLowerCase().replace(/\.$/, '')
  if (!DOMAIN_RE.test(domain)) throw new EmailError('invalid_domain', `${name} is not a valid domain name`)
  return domain
}

export function normalizeLocalPart(localPart: string): string {
  const value = localPart.trim().toLowerCase()
  if (!LOCAL_PART_RE.test(value) || value.includes('..')) {
    throw new EmailError('invalid_local_part', `${localPart} is not a valid address name (letters, digits, . _ -)`)
  }
  return value
}

export function validatePassword(password: string | undefined): asserts password is string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw new EmailError('invalid_password', 'Password must be 8 to 256 characters')
  }
}

export function validateQuota(quotaBytes: number | null | undefined): void {
  if (quotaBytes != null && (!Number.isSafeInteger(quotaBytes) || quotaBytes <= 0)) {
    throw new EmailError('invalid_quota', 'Quota must be a positive number of bytes')
  }
}

export function generatePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
