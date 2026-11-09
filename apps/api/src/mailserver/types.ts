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
>

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
