import type { DomainRow } from '../db/domains'
import type { MailboxKind, MailboxRow } from '../db/mailboxes'
import type { AccessLevel } from '../db/mailbox-access'

export type { DomainAccess, OrgPermission, Permissions } from '../db/members'
export type { MailboxKind }

export type { Actor } from '../auth/types'

export type EmailEnv = Pick<
  Env,
  | 'DB'
  | 'ENVIRONMENT'
  | 'STALWART_URL'
  | 'STALWART_API_KEY'
  | 'AWS_SES_ACCESS_KEY_ID'
  | 'AWS_SES_SECRET_ACCESS_KEY'
  | 'AWS_SES_REGION'
  | 'SES_SNS_TOPIC_ARNS'
  | 'SES_MODE'
  | 'SCAN_MODE'
  | 'SCAN_URL'
  | 'MAILBOX_STORE'
  // Live updates to the apps when mail changes in a mailbox the store holds (mailbox/store.ts).
  | 'LIVE'
  // New-mail events for mailboxes the store holds: filing, search, agents (mailbox/events.ts).
  | 'MAIL_EVENTS'
  // The organization's bucket, where mailboxes read from their store keep raw messages (mailbox/read.ts).
  | 'CLOUDFLARE_ACCOUNT_ID'
  | 'CLOUDFLARE_API_TOKEN'
  | 'R2_ACCESS_KEY_ID'
  | 'R2_SECRET_ACCESS_KEY'
  | 'R2_BUCKET'
  | 'APP_ORIGINS'
> & {
  SCAN_SECRET?: string
  // Sending from mailboxes the store holds, straight through SES (mailbox/ses-send.ts): IAM user xstate-mail-send.
  MAIL_SEND_ACCESS_KEY_ID?: string
  MAIL_SEND_SECRET_ACCESS_KEY?: string
}

export type Domain = {
  id: string
  organizationId: string
  name: string
  /** Receiving: the MX, SPF, DKIM and DMARC records are in place. */
  status: 'pending' | 'verified'
  /** Proven to be the organization's (the ownership TXT record or the mail records), even before mail moves. */
  owned: boolean
  /** Sending to outside addresses: Amazon SES has verified the domain. null when it isn't registered with SES. */
  sending: 'pending' | 'verified' | 'failed' | null
  enabled: boolean
  verifiedAt: string | null
  createdAt: string
  updatedAt: string
}

export type Mailbox = {
  id: string
  organizationId: string
  kind: MailboxKind
  address: string
  domainId: string
  aliases: string[]
  displayName: string | null
  quotaBytes: number | null
  createdAt: string
  updatedAt: string
}

export type MailboxAccessEntry = { memberId: string; userId: string; access: AccessLevel }

export function toDomain(row: DomainRow): Domain {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    status: row.status,
    owned: row.status === 'verified' || !!row.owned_at,
    sending: row.ses_status,
    enabled: row.enabled === 1,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toMailbox(row: MailboxRow): Mailbox {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    address: row.address,
    domainId: row.domain_id,
    aliases: (JSON.parse(row.aliases) as string[]).sort(),
    displayName: row.display_name,
    quotaBytes: row.quota_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
