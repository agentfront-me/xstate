// Mail server operations for the /email API.
//
// Every function takes the acting user, checks their access in D1, changes Stalwart (the source of truth for
// mail), then mirrors the change in D1. If the D1 write fails after Stalwart changed, the Stalwart change is
// undone so the two don't drift. Import from here, not from the files inside this folder.
//
// Layers: the files here are services that orchestrate; stalwart/ holds every JMAP call and payload shape;
// ../db/ holds the SQL, with write helpers returning prepared statements so a service can batch them atomically.

export { addAlias, removeAlias } from './aliases'
export {
  addDomain,
  checkDomain,
  checkOwnership,
  ownershipRecord,
  domainConnectUrl,
  getDomain,
  getDomainDnsRecords,
  listDomains,
  removeDomain,
  setDomainEnabled,
  verifyDomain,
} from './domains'
export type { DnsProvider, DnsRecord } from './dns'
export { EmailError } from './errors'
export {
  createMailbox,
  deleteMailbox,
  getMailbox,
  listMailboxes,
  setMailboxPassword,
  updateMailbox,
  type CreateMailboxInput,
} from './mailboxes'
export {
  getAttachment,
  getMailState,
  getThread,
  listFolders,
  listMessages,
  messagesWith,
  sendMessage,
  updateMessage,
  uploadAttachment,
  MAX_RECIPIENTS,
  MAX_UPLOAD_BYTES,
  type Attachment,
  type Folder,
  type FolderView,
  type MailboxFolders,
  type Message,
  type MessageSummary,
} from './messages'
export {
  applyInvite,
  createEvent,
  deleteEvent,
  getEvent,
  getInvite,
  listCalendars,
  listEvents,
  respondToEvent,
  setUpCalendars,
  updateEvent,
  MAX_GUESTS,
  type Calendar,
  type CalendarEvent,
  type EventInput,
  type Guest,
  type GuestStatus,
  type Invite,
  type Repeat,
} from './calendar'
export { evaluateSender, sendingHourly, sendingStatus } from './sending'
export { grantMailboxAccess, listMailboxAccess, revokeMailboxAccess } from './sharing'
export type {
  Actor,
  Domain,
  DomainAccess,
  EmailEnv,
  Mailbox,
  MailboxAccessEntry,
  MailboxKind,
  OrgPermission,
  Permissions,
} from './types'
