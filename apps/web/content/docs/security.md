---
title: Security
description: How xstate protects your accounts, email, files and agents, and what it does with risky attachments.
---

**Last updated:** November 16, 2026

This page describes what xstate actually does to keep your organization's data safe. We update it whenever we
change how something works. Recent changes are listed [at the end](#changes).

## Accounts and sign-in

- **Passwords** are never stored. We keep a salted PBKDF2-SHA256 hash with 100,000 iterations and compare it in
  constant time.
- **Sign-in doesn't reveal accounts.** A wrong password and an unknown email give the same answer, in about the
  same time.
- **Sign-in attempts are limited** to 5 a minute for each email address and 10 a minute from each network, so
  passwords can't be guessed at speed. Sign-ups are limited to 5 a minute from each network. Going over pauses
  attempts for the rest of the minute; accounts are never locked.
- **Sessions** are signed tokens that expire after 7 days. In the mobile app they're kept in the device keychain.
  On the web the token stays on go.xstate.com and is never put in a cookie. xstate.com only sees a `signed_in`
  cookie that says you're signed in, so it can show "Open app"; it holds no token and grants no access.
- **Invitations** use a long random link. We store only a hash of it, and it expires after 14 days. Sending a new
  invitation cancels the old link.

## Who can see what

- Every organization has an **owner**, **admins** and **members**. Members only get the permissions they're given,
  such as managing a domain or its agents. Nobody can remove or demote the owner.
- **Personal mailboxes** can be read only by their owner. Admins can't read members' personal mail.
- **Shared and agent mailboxes** can be read by admins and by the people they're shared with. Read-only access
  can't change anything.
- **Files** in Storage have viewer, editor and manager roles. Access only adds up down a folder tree. Admins
  manage team folders, but can't see anyone's My Files unless they're shared with them.
- If you don't have access to a mailbox, file or organization, xstate says it doesn't exist. That way nobody can
  find out what's there by guessing.

## Email

- **Reading mail.** Messages open in a sandboxed frame with a strict content policy, so scripts in an email never
  run. Remote images are hidden until you choose **Show images**, so senders can't track when you open their mail.
  Links open in a new window.
- **Proving mail is yours.** When you add a domain, xstate asks you to publish SPF and DKIM records, and
  recommends DMARC. Mail you send leaves through Amazon SES, signed with your domain's own DKIM key.
- **Receiving through Amazon SES.** For domains moved to xstate's new mail path (being tried on one test domain
  now), incoming mail is received by Amazon SES, which checks it for viruses and spam, saves it briefly in a
  private Amazon S3 bucket that only SES can write to, and notifies xstate. xstate copies it into your
  organization's own storage within seconds and deletes it from S3; anything left there is deleted after 7 days.
  A message SES finds a virus in is never delivered. Mail for addresses that don't exist is dropped, not bounced,
  so forged senders get no reply.
  Mail goes to Junk when SES flags it as spam, when it fails the sender domain's own DMARC policy (even if it claims
  to come from someone you know), or when it uses the name of someone in your organization from an outside address.
  Mail from people you've written to reaches your Inbox, and marking a sender as junk or not junk applies to their
  next messages.
  xstate publishes an MTA-STS policy for these domains (in enforce mode, starting with xstate.com), so senders that
  support it deliver only over encrypted connections to Amazon SES, with a verified certificate.
- **Delivery log.** For mailboxes on the new mail path, xstate keeps a record of where each message went: delivered
  and to which folder (with the reasons it went to Junk), attachments scanned, sent, accepted or bounced by the
  receiving server, refused, or dropped for an address that doesn't exist. It holds ids, addresses and outcomes,
  never what a message says, is kept 30 days, and only owners and admins can read it.
- **A mailbox's own index.** To make lists and search fast, a mailbox can have its own index of its messages:
  senders, recipients, subjects, folders, flags and body text, with a copy of each whole message (attachments
  included) in your organization's own storage bucket, from which the message and its attachments can be opened.
  It is kept separately for each mailbox, reached only through the same access checks as the mail itself, and
  deleted when the message or the mailbox is deleted. We are turning this on mailbox by mailbox.
  For mailboxes on the new mail path, the calendars are kept the same way, in that mailbox's own store, with the
  same access as the mailbox.
- **Calendar emails.** On the new mail path, an invitation, update, cancellation or answer that arrives by email
  changes the calendar only when its sender is proven: the message must come from the organizer (or, for an answer,
  from that guest), and Amazon SES must have confirmed the sender's domain with DMARC or a matching DKIM signature.
  New invitations are added on their own only from people in your organization, people you've written to, or your
  contacts; others stay an email you can add from. Nothing in Junk changes the calendar, and nothing is sent back
  automatically.
- **Stopping abuse.** Each mailbox and organization has hourly and daily limits on mail to outside addresses.
  Sending is suspended automatically when bounces or spam complaints pass a safe rate. Addresses that bounced or
  complained aren't sent to again.

## Attachments

xstate checks every attachment against file-type rules. This covers mail you receive, mail you send, files you
upload in the composer, and attachments sent by agents.

**Blocked.** These can't be downloaded, sent, forwarded or copied into Storage:

- Files that run programs when opened. This includes `.exe`, `.msi`, `.bat`, `.cmd`, `.scr`, `.com`, `.dll`,
  `.js`, `.vbs`, `.ps1`, `.jar`, `.lnk`, `.hta`, `.reg`, `.iso`, `.img`, `.vhd`, `.dmg`, `.pkg` and similar types.
  The list is close to Gmail's.
- Programs disguised as something else. xstate reads the start of each file, so a Windows, Mac or Linux program,
  a shortcut or a disk image is blocked even if it's named `invoice.pdf`.
- Names that hide their real type with invisible Unicode direction marks. For example, a name can display as
  `invoiceexe.pdf` when the file is really an `.exe`.
- Archives with any of the above inside. Zip, tar and gzip files are opened and checked entry by entry, including
  archives inside archives.

When you forward a message that has a blocked attachment, the blocked file is left out. If you attach a blocked
file yourself, the message isn't sent and xstate tells you why.

**Allowed with a warning.** xstate asks before you download these:

- Office files with **macros**, such as `.xlsm` and `.docm`, and files with a hidden macro project.
- **Password-protected archives**, since nothing inside them can be checked.
- Archives xstate **can't open**, such as `.7z` and `.rar`, and archives too large to check.

**Downloads.** Attachments and files always download as files and are never opened inside xstate's web pages.
Browsers are told not to guess their type, and download links expire after 5 minutes.

These rules aren't a virus scan. They block the file types most malware travels in. They apply in xstate's apps
and API. Mail apps connected over IMAP still receive the original message.

## Files and sharing

- Every organization's files live in **its own storage bucket**.
- **Public links** ("Anyone with the link") can be turned on only by people who manage the file. Each link is a
  random 128-bit token. It stops working when the file goes to the trash, and turning a link off and on again
  makes a new one. Agents can't create public links.
- Deleted items stay in the **trash for 30 days**. Earlier versions of a file are kept for 30 days after they're
  replaced, up to the last 5.

## AI agents

- **Your own AI keys.** Agents use your organization's Anthropic or OpenAI key. The key is encrypted with
  AES-256-GCM. xstate never shows it again (only its last 4 characters) and never gives it to the model.
- **Secrets** for connected tools are encrypted the same way. They're used only when a request is made and never
  enter the model's context.
- **Agents act with a person's access.** A published agent can only do what the person who published it can do,
  and only in the mailboxes it was given. It can't delete anything, create public links or touch API keys.
- **Approvals.** By default, sending, replying, forwarding and creating calendar events wait for a person to
  approve. You can change this per tool. Every decision is recorded with who made it and when.
- **Limits.** Each agent has limits on steps per run, runs per day, runs per sender and, optionally, spend.

## Connected AI apps

You can connect an AI app such as Claude, Cursor or ChatGPT to xstate (over MCP), so it can work with your mail,
calendar, files and contacts.

- **You sign in and approve on xstate.** The app never sees your password. Before anything is granted, xstate shows
  the app's name, whether its publisher's domain could be verified, and where the access will be sent.
- **You choose what it can do.** You pick the organization, the mailboxes, and a level for email (read only, draft
  only, or draft and send), calendar, storage and contacts. Draft only is the default: the app can't send mail
  unless you allow it.
- **It can never do more than you can.** Every action is checked against your own access, then narrowed to what
  you chose. Mail and calendars of mailboxes you didn't pick are out of reach, including through search.
- **Some things are never available to a connected app:** resetting mailbox passwords, giving people access to
  mailboxes, API keys, AI provider keys, secrets, inviting or removing members, and public file links. Managing
  domains and mailboxes is off unless an owner or admin turns it on for that connection.
- **Tokens.** Access tokens last one hour and are stored only as hashes. A connection ends 30 days after its last
  use. If you leave an organization, the app loses access to it straight away.
- **You can disconnect an app at any time** in Settings → Connected apps, which shows what each app may do and
  when it was last active. Owners and admins see every app connected to the organization and can disconnect any
  of them. Access ends at once.
- **Limits and records.** Each connected app can make up to 120 calls a minute. Every call is logged with who made
  it, which app and which tool, but never the contents of your mail or files.

## Personal API tokens

A personal token lets your own server send email from mailboxes you can send from. See
[Send transactional email](./transactional-email.md).

- **Shown once, stored as a hash.** A token is displayed when you create it and never again. xstate keeps only its
  SHA-256 hash and its last 4 characters, so a copy of the database holds nothing that can be used as a token.
- **It can never do more than you can.** A token acts as the person who created it, in one organization, and only
  for the mailboxes they picked. Every request checks that person's access as it is at that moment: lose access
  to a mailbox and the token can't send from it on the next request. With no mailbox left it stops working.
- **It only sends email.** A token can't read mail, files, calendars or contacts, can't sign in to xstate, and
  can't create, change or list tokens. A sign-in session is refused where a token is expected, and the other way
  round. Agents and connected AI apps can't create or see tokens either.
- **It ends with your membership.** When you leave an organization or are removed, your tokens there are revoked
  for good and the owners and admins are told which ones stopped.
- **Revoking is immediate.** You can revoke your own tokens at any time. Owners and admins see every member's
  tokens (never the token itself), can revoke any of them, and can turn tokens off for the whole organization.
- **You're told about new tokens.** xstate emails you when a token is created on your account, and a week before
  one ends. A token can be set to end after 30 days, 90 days or 1 year.
- **Limits.** A token can make 300 requests a minute, and requests with a wrong token are limited to 20 a minute
  from one address. Mail sent with a token is held to the same sending limits as mail sent by hand, and its
  bounces and spam complaints count against the mailbox in the same way.
- **What is recorded.** For each message sent with a token xstate keeps the sender, the recipients, the subject
  and the delivery status for 30 days, never the body or the attachments. No tracking of opens or clicks is added
  to your email.

## Keys and webhooks

- **Organization secret keys** are looked up by a hash and stored encrypted. Only owners and admins can view or
  roll them. They are for audience tracking and can't send email.
- **Webhooks** xstate receives are checked before they're trusted. Mail-server events must carry a valid
  HMAC-SHA256 signature, Amazon SES notifications (bounces, complaints and received mail) must have a valid
  signature from AWS and come from xstate's own notification topics, and billing events from
  Paddle must come from one of Paddle's published addresses and carry a valid, recent HMAC-SHA256 signature.
- **Payments** happen in Paddle's checkout, never on xstate's servers: xstate doesn't see or store card numbers.
  Only owners and admins can buy, change or cancel a plan, and connected AI apps and agents can't touch billing.
- **Agent webhook triggers** check a secret or an HMAC signature in constant time, and are rate limited.

## Desktop app

The desktop app runs pages with context isolation and the sandbox on, and without Node.js access. Pop-ups are
blocked, and outside links open in your own browser.

## Reporting a problem

If you think you've found a security issue, email [hello@xstate.com](mailto:hello@xstate.com). Please include the
steps to reproduce it, and give us a reasonable time to fix it before sharing it publicly.

## Changes

- **November 18, 2026:** MTA-STS in enforce mode for domains on the new mail path, starting with xstate.com:
  supporting senders deliver only over verified TLS to Amazon SES.
- **November 18, 2026:** On the new mail path, calendar emails update the calendar only when the sender is proven
  by DMARC or DKIM, and new invitations are added on their own only from people you know.
- **November 18, 2026:** Calendars of mailboxes on the new mail path are kept in that mailbox's own store, with the
  same access checks as its mail.
- **November 18, 2026:** A delivery log for mailboxes on the new mail path: where each message went, without its
  content, kept 30 days and readable only by owners and admins.
- **November 18, 2026:** Domains on xstate's new mail path receive through Amazon SES, which scans each message
  for viruses and spam; received mail passes briefly through a private Amazon S3 bucket before it reaches your
  organization's storage. Being tried on one test domain.
- **November 17, 2026:** A mailbox's own index can include a copy of each whole message in your organization's
  storage bucket, and messages and attachments can be opened from it, with the same access checks.
- **November 17, 2026:** A mailbox can have its own index of its messages for faster lists and search, kept per
  mailbox and deleted with the message or the mailbox.
- **November 17, 2026:** Searching mail by meaning (`email_search`) needs only read access to email, not to
  Storage, and covers only the mailboxes an app or agent was given.
- **November 16, 2026:** Personal API tokens for sending email from your own server, stored only as hashes.
- **November 16, 2026:** AI apps can be connected over MCP, with access you choose when you approve them.
- **November 16, 2026:** An agent's search of files and mail now covers only the mailboxes it was given, not every
  mailbox the person it acts for can read.
- **November 11, 2026:** Sign-in and sign-up attempts are rate limited.
- **November 11, 2026:** File-type rules for attachments: programs, disguised programs and risky archives are
  blocked. Macros and archives that can't be checked get a warning.
