---
title: Security
description: How xstate protects your accounts, email, files and agents, and what it does with risky attachments.
---

**Last updated:** November 11, 2026

This page describes what xstate actually does to keep your organization's data safe. We update it whenever we
change how something works. Recent changes are listed [at the end](#changes).

## Accounts and sign-in

- **Passwords** are never stored. We keep a salted PBKDF2-SHA256 hash with 100,000 iterations and compare it in
  constant time.
- **Sign-in doesn't reveal accounts.** A wrong password and an unknown email give the same answer, in about the
  same time.
- **Sessions** are signed tokens that expire after 7 days. In the mobile app they're kept in the device keychain.
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

## Keys and webhooks

- **API secret keys** are looked up by a hash and stored encrypted. Only owners and admins can view or roll them.
- **Webhooks** xstate receives are checked before they're trusted. Mail-server events must carry a valid
  HMAC-SHA256 signature, and Amazon SES notifications must have a valid signature from AWS.
- **Agent webhook triggers** check a secret or an HMAC signature in constant time, and are rate limited.

## Desktop app

The desktop app runs pages with context isolation and the sandbox on, and without Node.js access. Pop-ups are
blocked, and outside links open in your own browser.

## Reporting a problem

If you think you've found a security issue, email [hello@xstate.com](mailto:hello@xstate.com). Please include the
steps to reproduce it, and give us a reasonable time to fix it before sharing it publicly.

## Changes

- **November 11, 2026:** File-type rules for attachments: programs, disguised programs and risky archives are
  blocked. Macros and archives that can't be checked get a warning.
