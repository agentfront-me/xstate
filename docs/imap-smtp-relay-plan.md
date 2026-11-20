# Plan: mail apps and calendar apps (IMAP, SMTP, CalDAV)

Status: **draft, 2026-11-20.** The four open questions were answered the same day (§12), and a review the same day
changed the plan in 13 places (§13). **Phases 0, 1 and 2 are built and deployed (2026-11-20; §14–§16), and
tested in production through deepo (§17).** Mail apps are released to the main organization only (`MAIL_APPS`). Not
done yet: the mail ports aren't open to the internet and the bridge has a temporary self-signed certificate (§17).
**Phase 3 (reading mail over IMAP) is built and tested locally (2026-11-20; §18), committed but not pushed:** pushing
would replace the session code under the 12-hour idle test that is running until 20:57 UTC.

This plan lets people use their own mail apps and calendar apps (Apple Mail, Outlook, Thunderbird, the iOS and
Android mail and calendar apps) with xstate. It keeps one rule: **the mailbox store is the only place mail and
calendars live.** IMAP, SMTP and CalDAV are only ways in and out of the store. Nothing on the way keeps a copy.

---

## 1. Decisions so far

- **No second mail store.** No Dovecot, no Stalwart, no cache on disk. Every IMAP command, SMTP message and CalDAV
  request becomes a call to the mailbox store (`MailboxStore`, `apps/api/src/mailbox/store.ts`) or the existing send
  path (`mailbox/outbound.ts`).
- **The protocol work runs in Workers and Durable Objects.** Something has to speak IMAP and SMTP, because the store
  doesn't. That translator is stateless and lives in our Worker, next to the store.
- **A byte-only bridge on deepo, for now.** Workers can't accept raw TCP from the internet yet. Cloudflare's docs
  (updated October 2026) say direct inbound TCP is "coming soon"; a Worker's `connect()` handler only takes
  connections forwarded from another Worker. So a small program on deepo listens on the mail ports and passes the
  bytes to the Worker over a WebSocket. It doesn't understand IMAP or SMTP and writes nothing to disk. deepo stays
  for as long as it runs the bridge (user, 2026-11-20).
- **When Cloudflare opens inbound TCP, the bridge goes away.** DNS moves to the Worker; the IMAP and SMTP code
  doesn't change.
- **CalDAV needs no bridge.** It runs over HTTPS, which Workers already accept.
- **Every plan.** Mail apps and calendar apps work on Free, Growth and Custom alike (user, 2026-11-20).
- **One server name: `mail.xstate.com`** for IMAP, SMTP and calendars (user, 2026-11-20). See 3.2.
- **Order:** SMTP, then IMAP, then CalDAV (user, 2026-11-20).
- **Read-only shared mailboxes show in mail apps as read-only** (user, 2026-11-20). See 6.8.

## 2. Will it work for both email and calendars?

Yes, with three different protocols:

| What | Protocol | Apps | Path |
|---|---|---|---|
| Reading mail | IMAP | All mail apps | Bridge on deepo → Worker |
| Sending mail | SMTP submission | All mail apps, printers, scanners, older software | Bridge on deepo → Worker → SES |
| Calendars | CalDAV | Apple Calendar (macOS, iOS), Thunderbird, DAVx⁵ on Android | Straight to the Worker over HTTPS |

Limits to know about:
- **Outlook** (Windows, Mac, mobile) doesn't support CalDAV. Outlook users get mail over IMAP and SMTP, but not
  calendars. Only Exchange (EWS or ActiveSync) would give them calendars, and that is out of scope.
- **Google's Calendar app** only shows Google calendars. Android users would use DAVx⁵ or another CalDAV app.
- **Invitations work through mail anyway.** An invitation sent from a mail app goes out over SMTP like any email.
  An invitation received shows up in IMAP like any email, and the store already adds it to the calendar
  (`mailbox/calendar-in.ts`).
- **Contacts (CardDAV)** are out of scope. Contacts live in `AudienceStore`, not the mailbox store; it could be a
  later plan.

## 3. How it fits together

```
                       deepo (bridge only)                       Cloudflare
Mail app ──993 IMAPS──▶ ┐                                     ┌──▶ ImapSession DO ──▶ MailboxStore DO
Mail app ──465 SMTPS──▶ ├─ TLS ends here, bytes go ─WebSocket─┤                       ▲      │
Mail app ──587 STARTTLS▶┘  out over one WebSocket each        └──▶ SmtpSession DO ────┘      ▼
                                                                         │               R2 (raw messages)
                                                                         ▼
                                                                  outbound.ts → SES
Calendar app ──HTTPS (CalDAV)──────────────────────────────────▶ Worker /dav/* ──▶ MailboxStore DO (calendars)
```

### 3.1 The bridge (deepo)

- **One small program** (Go, one binary, about 150 lines), run by systemd. It listens on 993 (IMAP over TLS),
  465 (SMTP over TLS) and 587 (SMTP with STARTTLS).
- **TLS:** a certificate for `mail.xstate.com` from Let's Encrypt with certbot, which is already on deepo. On 587 the bridge answers the opening `EHLO` and `STARTTLS` itself (the only SMTP it speaks),
  then passes bytes like the other ports.
- **For each connection** it opens `wss://api.xstate.com/relay/{imap|smtp}` with a shared secret header and the
  client's IP, then copies bytes in both directions until either side closes.
- **Stores nothing.** No logs of content, no temp files. Mail passes through its memory in plain text, because TLS
  ends there. This goes into `security.md` and `privacy.md`.
- **Limits:** a cap on open connections per IP and in total, and an idle timeout (30 minutes, as IMAP requires for
  IDLE).
- **Flow control:** data goes in binary frames of at most 64 KB. The session sends at most 1 MB ahead, then waits
  for a short text frame from the bridge saying how much the mail app has taken. Without this, a slow mail app
  downloading large messages would fill the session's memory. The bridge still doesn't read IMAP or SMTP.
- **Kept apart from the PHP app.** deepo also runs `api.hireninja.com`, and app passwords and mail pass through
  the bridge's memory in plain text. So the bridge runs as its own system user under systemd's sandboxing
  (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, no shell), and only that user can read the certificate
  key and the bridge secret. This lowers the risk but doesn't remove it: a root-level break-in on deepo would still
  expose them. A separate small instance would be safer, and is the fallback if this ever worries us.
- **deepo today:** t3.micro (1 GB plus 2 GB swap) running nginx, php-fpm, horizon, redis and Postgres for
  `api.hireninja.com`. The bridge needs tens of KB per connection (two TLS connections' buffers), and mail apps open 3 to 5
  connections per account, so 1 GB holds a few thousand connections at most. Phase 0 measures the real ceiling. Ports 993, 465 and 587 must be opened in its
  security group. deepo's IP must stay fixed (Elastic IP); check this in phase 0.
- **If deepo is down,** mail apps can't connect. Mail is still received, sent from the web app, and kept, because
  nothing depends on deepo. Worth saying on the status page and in the docs.

### 3.2 One name: `mail.xstate.com`

People type `mail.xstate.com` for incoming mail, outgoing mail and calendars. A DNS name points at one place,
though: the mail ports need deepo, and CalDAV should run on Cloudflare.

- **DNS:** `mail.xstate.com` is an A record for deepo's fixed IP, set to **DNS only** (grey cloud). Cloudflare's
  proxy would not carry ports 993, 465 and 587.
- **Calendars:** on port 443, deepo's nginx answers only `/.well-known/caldav` and `/` with a permanent redirect to
  `https://dav.xstate.com/dav/`, a Worker custom domain. Calendar apps follow this redirect when they look for the
  server (RFC 6764), then talk to Cloudflare directly. Calendar traffic never passes through deepo after that first
  redirect.
  - Apple's `.mobileconfig` profile and Thunderbird's autoconfig point at `dav.xstate.com` directly, so most
    people never touch the redirect.
- **People only ever see `mail.xstate.com`.** `dav.xstate.com` is internal and shows up only in an app's account
  details.
- **When Cloudflare opens inbound TCP,** `mail.xstate.com` moves to the Worker, which serves all three, and the
  redirect goes away. Saved settings keep working because the name doesn't change.

### 3.3 Sessions in Durable Objects

- `/relay/imap` and `/relay/smtp` check the bridge's secret and hand the WebSocket to a new `ImapSession` or
  `SmtpSession` Durable Object, one per connection.
- **The WebSocket hibernation API** means an idle IMAP connection (a mail app sitting in IDLE for hours) costs
  nothing while nothing happens.
- **The session holds only connection state:** who logged in, the selected folder, and that folder's list of UIDs
  (to turn message sequence numbers into UIDs). No message contents.
- **That state is kept in the session object's own SQLite storage, not in memory.** Hibernation resets memory, and
  the per-socket attachment holds only 16 KB, too small for a big folder's UID list. The attachment holds just the
  login and the selected folder's id.
- **Cleanup:** the storage is deleted when the connection closes. An alarm deletes it after 24 hours without
  activity, for the case where the bridge dies without closing.
- **New mail during IDLE:** a session entering IDLE registers its id with the mailbox's store (new table
  `watchers`); the store calls the session directly (`changed()`) when something changes, and the session asks what
  changed since its last `modseq`. Sessions do not connect to the live hub: an outgoing WebSocket from a Durable
  Object never hibernates, so every idle connection would be billed all day, and the hub tags sockets by user, not
  by mailbox. A watcher that can't be reached is dropped from the table.
- **Other sessions' changes:** the same call tells a session when another app deleted or moved mail, so it can send
  the `EXPUNGE` and `FETCH` updates IMAP requires. It finds removals by comparing its stored UID list with the
  store's.

## 4. Signing in: app passwords

Mail and calendar apps can't do our web sign-in, so people need **app passwords**.

- **New table** `app_passwords` (D1 migration): person, organization, name ("iPhone Mail"), SHA-256 hash, the
  mailboxes it may use, created, last used, revoked. It's built like personal API tokens (`auth/api-tokens.ts`):
  - It can never do more than its owner can do at that moment.
  - It's revoked when the owner leaves the organization.
  - It's refused while the member is suspended.
- **Shown once,** in Settings → Security → App passwords, as four groups of four letters.
- **Username = the mailbox address.**
  - A person's own mailbox: their address.
  - A shared mailbox: the shared address with the same app password. It's added as a second account in the mail
    app. That's simpler for apps than IMAP shared namespaces, and each account shows its own unread count.
  - `read` access to a shared mailbox opens folders read-only: changes are refused with `NO [READ-ONLY]`.
- **Throttling:** failed logins counted per address with `auth/throttle.ts`, then a lockout. The per-IP count is
  much looser, because some apps connect from their maker's servers and many people share those IPs (see §9).
- **Off switch for admins:** an organization setting, "Allow mail and calendar apps" (on by default). Turning it
  off refuses every app-password login for that organization and ends its open sessions.
- **Allowed only over TLS.** The bridge never lets a password cross in plain text.
- **2-step verification:** app passwords are how services with 2-step sign-in let mail apps in, so they will still
  work once 2-step verification exists (`security-gaps`).

## 5. SMTP submission

- **Commands:** EHLO, AUTH PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT. Extensions: SIZE (35 MB:
  the app's 25 MB of attachments once encoded), 8BITMIME, PIPELINING, ENHANCEDSTATUSCODES. No BDAT/CHUNKING in the first version.
- **MAIL FROM** must be an address the signed-in mailbox may send as (same check as `checkOutgoing` in
  `mailserver/messages.ts`). The `From:` header is checked the same way.
- **Same limits as the app** (`mailserver/messages.ts`): at most 50 recipients (`MAX_RECIPIENTS`, also SES's limit
  per send), so the 51st `RCPT TO` is refused with `452 4.5.3`; attachments over 25 MB in total
  (`MAX_ATTACHMENTS_BYTES`) are refused with `552 5.3.4`.
- **The message is never held whole in memory.** A Durable Object has 128 MB, and our spike measured `postal-mime`
  needing about 126 MB for a 35 MB message. DATA is streamed to R2 as it arrives (multipart upload), and the
  message is inspected with our own part locator (`mailbox/mime.ts`) and ranged reads. Phase 2 confirms that
  `ses-send.ts` can stream its request body from R2.
- **After DATA,** a new `sendRawFromStore` (next to `sendFromStore` in `mailbox/outbound.ts`):
  1. Locate the parts with `mime.ts` and run the attachment file-type rules (`security/attachments`).
  2. Run `reserveSend`: suspension, hourly and daily caps, plan limits.
  3. Take the `Bcc:` header out and send through `ses-send.ts` with the RCPT TO addresses as destinations.
  4. Keep the Sent copy in R2 and the store, with the Message-ID SES assigns, so replies thread as they do today.
  5. Write the delivery log lines and queue the mail events, like any other send.
- **Reply only after SES accepts.** `250 OK` comes back once SES has the message, so nothing waits in a queue.
  Errors map to SMTP codes: limits and suspension `550 5.7.1`, SES unavailable `451 4.3.0` (the app retries later).
- **The client's own Message-ID** is saved on the Sent copy as `client_message_id`. Section 6.5 explains why.

## 6. IMAP

### 6.1 What we support

IMAP4rev1 with: IDLE, UIDPLUS, MOVE, CONDSTORE, SPECIAL-USE, NAMESPACE, ENABLE, ID, LITERAL+, UNSELECT, QUOTA.
That's what current Apple Mail, Outlook, Thunderbird and the Android apps use.

**Later:** QRESYNC (faster resync of deleted messages). It needs a record of removed UIDs, which the store doesn't
keep yet. Without it, apps find deletions with `UID SEARCH`, which works but is slower on big folders.

**Not planned:** ACL, METADATA, custom keywords beyond the ones below, IMAP4rev2-only features.

### 6.2 What the store already has

The store was built with IMAP in mind (`docs/mailbox-store-plan.md`, "IMAP later"):
- Each folder has `uid_validity`, `uid_next` and `highest_modseq`.
- Each placement has a `uid`, and each message a `modseq` that changes with every flag change or move.
- Flags exist for seen, pinned, answered, forwarded and draft.
- The raw message is in R2, and `mime.ts` finds each MIME part's byte range.

### 6.3 Mapping

| IMAP | Store |
|---|---|
| Folders with `\Inbox \Sent \Drafts \Archive \Junk \Trash` | The six role folders (SPECIAL-USE) |
| Other folders | Named folders (`importFolders` exists; CREATE, RENAME and DELETE need new store methods) |
| `\Seen` | `seen` |
| `\Flagged` | `pinned` |
| `\Answered`, `$Forwarded`, `\Draft` | `answered`, `forwarded`, `is_draft` |
| `$Junk` / `$NotJunk` | Move to or from Junk, so spam layer 3 learns from it as it does from the web app's buttons |
| `\Deleted` | New `deleted` column (see 6.4) |
| UID, UIDVALIDITY, MODSEQ | `placements.uid`, `folders.uid_validity`, `messages.modseq`; needs a new index on `placements (folder_id, uid)`, because IMAP looks messages up by UID constantly and there is none today |
| Sequence numbers | Kept in the session, from the folder's UID list at SELECT |

### 6.4 Deleting

IMAP marks a message `\Deleted`, then removes it with EXPUNGE.
- **In Trash,** EXPUNGE removes the message for good (store row and raw copy), like emptying Trash in the web app.
- **In Drafts,** EXPUNGE also removes the message for good, as the web app's `removeDraft` does. Mail apps save a
  new draft every few seconds and expunge the old one; moving each to Trash would fill it with draft versions.
- **When a copy is already in Trash,** EXPUNGE just removes the original. Some apps delete by copying to Trash and
  then expunging; moving the original as well would leave two copies. A copy is recognised by sharing the same raw
  object (see COPY in 6.7).
- **In any other folder,** EXPUNGE moves the message to Trash, where the 30-day purge (`mailbox/trash.ts`) removes
  it later. This protects people from apps that expunge without asking, and matches what the web app does.
- `\Deleted` is kept in the store, not the session, so another app sees it.

### 6.5 Reading messages (FETCH)

- **ENVELOPE and BODYSTRUCTURE** need more headers than the store keeps (Cc, Reply-To, Sender, Date, MIME
  structure). Mail apps ask for them for every message on first sync. Plan: an `imap_meta` JSON column, written at
  delivery, from the header block and `mime.ts`. Older mail is filled by a background job (like the threading
  backfill, `store-threading`) that runs for every mailbox before IMAP is switched on, not on first FETCH: a first
  sync of a 53,000-message mailbox would otherwise wait on 53,000 R2 reads. FETCH still fills any row the job
  missed. It uses about 1 KB
  per message, so 53,000 messages need about 50 MB, within the store's limits.
- **BODY[], BODY[HEADER], RFC822.SIZE:** read from the raw copy in R2, streamed.
- **BODY[1.2] and other parts:** a ranged R2 read using the part's byte offsets, as attachments are read today.
- **BODY.PEEK[HEADER.FIELDS (...)]:** from the header block, the first few KB of the raw copy.

### 6.6 Search

`SEARCH` and `UID SEARCH` go to the store's query (`mailbox/query.ts`): sender, recipient, subject, dates, flags, and
FTS5 for `BODY` and `TEXT`. Criteria the store can't answer (for example arbitrary `HEADER` fields) are checked
against `imap_meta`, or narrowed by the other criteria first.

### 6.7 Adding messages (APPEND, COPY)

- **APPEND to Drafts:** saved as a draft, through the same code the web app's drafts use.
- **APPEND to Sent:** many apps save a copy of what they sent, but our SMTP path has already saved one. If the
  appended message's Message-ID matches a `client_message_id` sent in the last 24 hours, the APPEND succeeds
  without adding anything, and the UID of the existing copy is returned. That way nothing shows up twice.
  - It works in both directions. Some apps save their Sent copy before the SMTP send finishes, so when the send
    arrives second and finds an appended copy with its Message-ID, it replaces that copy and doesn't add another.
- **APPEND anywhere else** (people moving old mail in from another account): the raw message goes to R2 and a store
  row is added, through the same import path the Google Workspace migration uses. Storage limits apply.
- **COPY:** a new store row pointing at the same raw object. The raw object is removed only when no row uses it.

### 6.8 Read-only shared mailboxes

IMAP has read-only mode built in, and every mail app handles it.

- **The check:** at SELECT, the session asks `mailContext(..., 'write')` (`mailserver/access.ts`), the same check
  the web app uses. If that fails but `'read'` passes, the folder opens read-only.
- **What the app sees:** `SELECT` answers `OK [READ-ONLY]` and lists no permanent flags
  (`[PERMANENTFLAGS ()]`).
- **What's refused:** STORE, MOVE, COPY *into* the mailbox, APPEND, EXPUNGE and CREATE/RENAME/DELETE, each with
  `NO [READ-ONLY]`. COPY *out of* it into a mailbox they can change is allowed, the same as downloading.
- **Reading doesn't mark mail read.** In read-only mode IMAP never sets `\Seen`, so a person with read access
  doesn't change the unread state for the owners. Some apps keep their own local "read" mark, which only that app
  sees.
- **No sending from it.** SMTP refuses `MAIL FROM` with a read-only mailbox's address (`550 5.7.1`).
- **Access is checked on every SELECT, not only at login.** If someone's access drops from full to read while
  their app is connected, the next SELECT opens read-only. If access is removed, the next command ends the session
  with `BYE`.
- **What people notice:** Apple Mail and Outlook show an error if someone tries to delete or move mail in a
  read-only mailbox. Thunderbird shows those folders with a lock. The "Use your mail app" docs page will say this.

## 7. CalDAV

- **Routes on the API Worker:** `/.well-known/caldav` and `/dav/*` on the custom domain `dav.xstate.com`. People
  reach it from `mail.xstate.com` (see 3.2). Basic auth with an app password.
- **Methods:**
  - OPTIONS, PROPFIND and PROPPATCH (calendar names and colours).
  - REPORT: `calendar-query`, `calendar-multiget`, `sync-collection`.
  - GET, PUT and DELETE on `.ics` events.
  - MKCALENDAR to create a calendar.
- **Data:** events stay JSCalendar in the store. iCalendar goes in and out through the converters we already have
  (`ical-out.ts`, `ical-in.ts`, `ical.js`).
- **Store additions:**
  - An ETag per event (its own change counter).
  - A calendar-wide sync token, plus a short list of deleted event ids so `sync-collection` can report removals.
- **Invitations:** a PUT that adds guests sends invitations from the server (`SCHEDULE-AGENT=SERVER`, through
  `scheduling.ts` and `invite-send.ts`), as the web app does. The app doesn't send them itself.
- **Free/busy and the scheduling inbox/outbox** are later. Apple Calendar works without them.

## 8. Setup in mail apps

- **One server name for every domain:** `mail.xstate.com`, for incoming mail, outgoing mail and calendars,
  whatever the customer's domain.
- **Manual setup** with `mail.xstate.com`, the mailbox address and an app password works in every app, and is what
  the docs page shows.
- **Apple:** a `.mobileconfig` profile downloaded from Settings → App passwords. It sets up mail and calendar in one
  step on iPhone and Mac.
- **SRV records** (`_imaps._tcp`, `_submission._tcp`, `_caldavs._tcp`) are optional extra rows on the Domains page.
- **Later: Thunderbird autoconfig and Outlook autodiscover.** They look up `autoconfig.<customer domain>` and
  `autodiscover.<customer domain>`, which needs DNS records and a certificate for every customer domain: the same
  custom-hostname work deferred for MTA-STS. They are served for our own domains only until that exists.
- **Docs:** a "Use your mail app" page in `apps/web/content/docs`, plus updates to `security.md`, `privacy.md` and
  the FAQ.

## 9. Security notes

- TLS only on every port. AUTH and LOGIN are refused before TLS.
- Only hashes of app passwords are stored. Every login checks the owner's access at that moment.
- The bridge's WebSocket needs a secret only deepo has. The Worker refuses `/relay/*` without it.
- No message content in logs, on deepo or in the Worker. Only counts, sizes and result codes.
- Sending through SMTP passes every check the web app's sending does: limits, suspension, file types, delivery log.
- New attack surface: password guessing on 993, 465 and 587. Throttling and lockout cover it. Watch the logs after
  launch.
- deepo is shared with the hireninja PHP app; the bridge is kept apart from it as far as one machine allows (3.1).
- **Some mail apps copy mail to their maker's servers.** The new Outlook, and Outlook on phones, sync IMAP accounts
  through Microsoft's cloud, which keeps the app password and a copy of the mail. We can't prevent it. `privacy.md`
  and the "Use your mail app" page say so, and the admin off switch (§4) is the control for organizations that
  don't want it.

## 10. Phases

| Phase | What | Done when |
|---|---|---|
| 0. Spike | Bridge on deepo for one port, as its own sandboxed user; a WebSocket into a hibernating DO with its state in storage; an IDLE connection kept 12 hours; flow control with a 30 MB download on a slow link; check deepo's IP is fixed; open test connections until memory runs short | A test connection survives a night; costs and the connection ceiling measured |
| 1. App passwords | D1 table, API, Settings screen, throttling, the admin off switch | Created, used, revoked; refused for suspended members and when the organization has it off |
| 2. SMTP | Bridge on 465 and 587, `SmtpSession`, `sendRawFromStore`, `client_message_id` | Apple Mail, Thunderbird and Outlook send; Sent copy appears once; limits apply |
| 3. IMAP read | LOGIN, CAPABILITY, LIST, SELECT/EXAMINE, FETCH, UID, SEARCH, IDLE, CONDSTORE; `imap_meta` and its backfill job; the `placements (folder_id, uid)` index; `watchers` | Big mailbox (hireninja, 53k messages) syncs in Apple Mail and Thunderbird; new mail shows in seconds |
| 4. IMAP write | STORE, MOVE, COPY, EXPUNGE, APPEND, CREATE/RENAME/DELETE, `\Deleted` | Changes made in a mail app show in the web app and the other way round; `imaptest` passes its main checks |
| 5. CalDAV | Routes, ETags, sync tokens, server-sent invitations | Apple Calendar and Thunderbird show, add, change and delete events; invitations go out once |
| 6. Setup and docs | `.mobileconfig`, SRV rows, docs pages | A new user sets up iPhone Mail and Calendar from one download |
| Later | QRESYNC; drop the bridge when Cloudflare supports inbound TCP; CardDAV; autoconfig and autodiscover on customer domains | |

**Tested with:** Apple Mail and Calendar (macOS and iOS), Thunderbird, Outlook (Windows and Mac, mail only), the
Gmail app on Android with an IMAP account, Thunderbird for Android, DAVx⁵, and Dovecot's `imaptest` for protocol
correctness.

## 11. Costs (rough)

- **deepo:** already paid for. The bridge adds a little traffic (EC2 egress about $0.09/GB; a full first sync of a
  5 GB mailbox is about $0.45 once).
- **Durable Objects:** one per open connection, hibernating while idle, so mostly the requests made.
- **R2:** reads for message bodies on first sync. 53,000 messages is about 100,000 reads, roughly $0.04. Egress is
  free.

## 12. Decisions (user, 2026-11-20)

1. **Plans:** mail apps on every plan, Free included. `limits/` needs no new limit. Sending through SMTP already
   counts against the plan's sending limits, and APPEND against storage.
2. **Server name:** one name, `mail.xstate.com`, for everything (3.2).
3. **Order:** SMTP, then IMAP, then CalDAV, as in §10.
4. **Read-only shared access:** shown in mail apps as read-only (6.8).

## 13. Review, 2026-11-20

Checked against the store code and Cloudflare's docs. What changed:

| # | Issue | Now |
|---|---|---|
| 1 | Session state in memory is lost on hibernation; the socket attachment holds 16 KB | State in the session's SQLite storage (3.3) |
| 2 | Registering with the live hub over a WebSocket would stop sessions hibernating | The store calls watching sessions directly (3.3) |
| 3 | `postal-mime` needs about 126 MB for a 35 MB message; a Durable Object has 128 MB | Stream to R2, inspect with `mime.ts`; bridge flow control (3.1, §5) |
| 4 | "Expunge moves to Trash" duplicated copy-then-delete and filled Trash with drafts | Two exceptions (6.4) |
| 5 | 40 MB and no recipient cap didn't match the app's 25 MB and 50 | Same limits as the app (§5) |
| 6 | No index for UID lookups | `placements (folder_id, uid)` (6.3) |
| 7 | Lazy `imap_meta` made first sync wait on one R2 read per message | Background backfill first (6.5) |
| 8 | deepo also runs the hireninja PHP app | Bridge as its own sandboxed user (3.1) |
| 9 | Some apps sync through their maker's cloud | Said in the docs; looser per-IP throttle (§4, §9) |
| 10 | No way for an organization to turn mail apps off | Admin off switch (§4) |
| 11 | "A few MB per connection" was wrong | Tens of KB; ceiling measured in phase 0 (3.1) |
| 12 | Autoconfig on customer domains needs per-domain DNS and certificates | Moved to later (§8) |
| 13 | Sent-copy matching missed apps that save before sending | Matches in both directions (6.7) |

## 14. Phase 0 as built (2026-11-20)

**Built**
- `services/mail-bridge/` (Go, one static binary): ports 993, 465 and 587, TLS with certificate reload, the STARTTLS
  lines on 587, one WebSocket per connection, flow-control acks every 256 KB, pings every 50 seconds, connection
  caps, a `stats` log line every minute. `mail-bridge.service` is the sandboxed systemd unit; `README.md` has the
  install steps.
- `apps/api/src/relay/route.ts`: `GET /relay/imap` (and `/relay/smtp` from phase 2), refused with 404 unless the
  caller sends `RELAY_SECRET`. `POST /relay/poke/:id` is a spike-only hook to wake or inspect one session.
- `apps/api/src/relay/imap-session.ts`: the `ImapSession` Durable Object, a spike that speaks just enough IMAP to
  test the design (CAPABILITY, LOGIN, SELECT, IDLE, NOOP, LOGOUT, and two test commands). Phase 3 replaces its
  command handling.
- DNS: `mail.xstate.com` A → 3.130.37.150 (deepo), DNS only, added 2026-11-20.

**Tested locally** (`apps/api/scripts/relay-spike-test.mjs`: this script as the mail app → bridge with a self-signed
certificate → `wrangler dev`), all passing:
- The session hibernates during IDLE (memory reset, socket kept) and its UID list is still in storage afterwards.
- A call from outside reaches the idle session and the mail app gets `* 5001 EXISTS`.
- Flow control: with the mail app reading nothing, a 30 MB download stops at exactly 1 MB ahead of the last ack,
  then finishes when reading resumes.
- Logout closes the connection and the session's storage is deleted.
- Port 587: plain-text commands other than EHLO, STARTTLS, NOOP, RSET and QUIT are refused; TLS 1.3 after STARTTLS.

**Found on deepo** (read only, nothing changed there): x86_64, Amazon Linux 2023, 916 MB memory with about 430 MB
available; ports 993, 465 and 587 are free; certbot is installed with no certificates yet; Go isn't needed (static
binary). Its public IP is 3.130.37.150, the same as on 2026-11-18, before and after the resize.

**Still to do for phase 0** (needs a production deploy and AWS access):
1. Push the branch so the Worker has `/relay/imap` and the `ImapSession` class; set the `RELAY_SECRET` secret.
2. `aws login`, then confirm 3.130.37.150 is an Elastic IP and open 993, 465 and 587 in deepo's security group.
3. Install the bridge on deepo (`services/mail-bridge/README.md`): certificate, user, unit.
4. Run the spike test against `mail.xstate.com`, leave one IDLE connection open for 12 hours, and open test
   connections until memory runs short. Write the measured cost per connection into `pricing-plan.md`.

## 15. Phase 1 as built (2026-11-20)

- **Table** `app_passwords` and `organizations.mail_apps_disabled` (migration 0047).
- **Code:** `auth/app-password-rules.ts` (16 letters, shown as four groups; typed with or without dashes, spaces or
  capitals), `db/app-passwords.ts`, `auth/app-passwords.ts`, `operations/app-passwords.ts` (list, create, revoke,
  the organization switch; none of them on MCP).
- **Sign-in** is `authenticateApp(env, address, password, ip)`: 10 tries a minute per address and 300 per IP (new
  rate limiters), then the checks in §4. It answers with the mailbox and whether it may be changed. The spike IMAP
  session already signs in with it.
- **Screen:** Settings → Apps and API → App passwords (`apps/app/src/settings/AppPasswords.tsx`): your app
  passwords, the server settings to type into a mail app, and for owners and admins everyone's app passwords and
  the "Allow mail and calendar apps" switch.
- **Housekeeping:** revoked when a member is removed or deleted; revoked ones are purged after 30 days (hourly job);
  an email to the owner when one is created.

**Changed from the plan**
- **An app password isn't limited to chosen mailboxes.** It works for every mailbox its owner can open, at their
  access level at that moment. The address typed as the username picks the mailbox. This keeps the create dialog to
  one field, and matches how Fastmail and Google do it.
- **A release switch, `MAIL_APPS`** (a Worker var: `off`, `on`, or organization ids). It is `off` in production, so
  the App passwords tab is hidden and no app password works until mail apps are ready. Set it to the main
  organization's id to test in production.
- **Ending open sessions when the switch goes off** comes with the real IMAP session in phase 3 (each session
  re-checks access on SELECT).
- `security.md` and `privacy.md` are unchanged for now: nothing is released while `MAIL_APPS` is `off`. They change
  at launch (phase 6).

**Tested locally** (`apps/api/scripts/app-password-test.mjs`, 21 checks, all passing): create, list (never the
password), sign in to an own mailbox, a read-only shared mailbox (signs in read-only) and someone else's (refused);
wrong password; typed in capitals without dashes; last-used; the organization switch (member refused, owner allowed,
sign-ins refused while off); owner sees everyone's; revoke; throttling after 10 tries. The Settings screen was
checked in the browser: create, copy dialog, revoke.

## 16. Phase 2 as built (2026-11-20)

- **`relay/smtp-session.ts`**, the `SmtpSession` Durable Object, one per connection: EHLO/HELO, AUTH PLAIN and
  AUTH LOGIN with an app password, MAIL FROM (with SIZE), RCPT TO, DATA, RSET, NOOP, VRFY, QUIT. It advertises SIZE
  (35 MB), 8BITMIME, PIPELINING and ENHANCEDSTATUSCODES. Three wrong passwords close the connection.
- **`mailbox/outbound-raw.ts`**, `sendRawFromStore`: checks the From address, the recipient cap and suppression
  list, the file-type rules and the 25 MB attachment cap; reserves against the sending limits; takes the Bcc line
  off; sends through SES; keeps the Sent copy (with SES's Message-ID and a Bcc line) in R2 and the store; queues
  the mail event; writes one delivery-log line per recipient; tells the apps to reload.
- **`mailbox/raw-headers.ts`**: removes and adds header lines without touching the body (unit tests).
- **Bridge:** `/relay/smtp` now reaches the session, on 465 (TLS) and 587 (STARTTLS).

**Changed from the plan**
- **The message is collected in the session's memory, not streamed to R2.** SES needs the whole message in one
  request, so it has to be in memory once anyway. What matters is never holding it twice for long: the parser gets
  it with the files cut out (as received mail already does), and each header rewrite replaces the copy before it.
  The peak is the message plus its base64 form for SES, the same as a send from the web app. If the session is
  reset mid-message (the app silent for a long while), the app is told to send again.
- **`client_message_id` is not stored yet.** It's only needed to match a mail app's own Sent copy (IMAP APPEND),
  so it comes with phase 4.
- **Marking the original as answered** (when the message is a reply) also comes with phase 4, with the IMAP
  `\Answered` flag.

**Tested locally** (`apps/api/scripts/smtp-test.py`: Python's smtplib as the mail app → bridge → `wrangler dev`, SES
in fake mode; 18 checks, all passing):
- A message with Cc, Bcc and an attachment is accepted; a second on the same connection; one over port 587 with
  STARTTLS and AUTH LOGIN.
- Each has exactly one Sent copy, with its text intact (lines starting with dots included), its Bcc and its
  attachment; the delivery log has a line for the Bcc recipient.
- An 18 MB attachment goes through in about 4 seconds; 27 MB of attachments is refused with 552.
- Refused: MAIL before signing in (530), another From address (550), a blocked file type (550, naming the file),
  the 51st recipient (452, the other 50 are sent), a read-only shared mailbox (550), three wrong passwords (closed).
- The hourly limit on outside recipients applies: a run that passed 100 got `451 4.7.1 Sending limit reached`.

**Still to check in production** (after the bridge is on deepo): a real send to Gmail from Apple Mail, Thunderbird
and Outlook; that the Bcc recipient gets the message and the others can't see them; that a reply threads with the
Sent copy.

## 17. Production test (2026-11-20)

**Deployed:** `mail-apps` merged to main and pushed (e6a9b1e): the Worker has `/relay/imap` and `/relay/smtp`, the
`ImapSession` and `SmtpSession` classes, migration 0047 and the two sign-in rate limiters. `RELAY_SECRET` is set.
`MAIL_APPS` is the main organization's id, so only it sees the App passwords tab.

**On deepo:** the bridge runs as the `mail-bridge` user under the sandboxed unit (systemd rates its exposure 2.4,
"OK"), listening on 993, 465 and 587, with the secret in `/etc/mail-bridge/secret`. Its certificate is a
**temporary self-signed one**. The load tool is at `/usr/local/bin/mail-bridge-loadtest`
(`services/mail-bridge/loadtest`).

**Tested through an SSH tunnel to deepo** (so: real bridge, real Worker, real SES; only the public ports missing):
- The spike test passes in production, all 12 checks: sign-in with a real app password, hibernation, the UID list in
  storage, the wake-up during IDLE, flow control on a 30 MB download, clean-up on logout.
- Real sending: two messages from asif@xstate.com to itself, one on 465 with an attachment (4.5 seconds) and one on
  587 with STARTTLS and AUTH LOGIN. Both arrived in the Inbox, and each has exactly one Sent copy. A wrong From
  header and a wrong MAIL FROM were refused with 550.
- The App passwords screen works on go.xstate.com (created there for these tests).

**Memory per connection, measured** (connections opened on deepo itself, held, bridge memory read from `ps`):

| Open connections | Bridge memory | Per connection |
|---|---|---|
| 0 | 11 MB | – |
| 250 | 32 MB | 84 KB |
| 500 | 64 MB | 105 KB |
| 1,000 | 117 MB | 106 KB |

So about **105 KB per connection**, at the top of the estimate. With about 420 MB available on deepo today, the
bridge can hold roughly 3,000 connections before the machine gets tight; a larger instance raises that in step.
All 1,000 opened without a failure.

**Running:** a 12-hour idle test on deepo (unit `mail-bridge-idle-test`, signed in as asif@xstate.com, IDLE renewed
every 25 minutes), started 08:57 UTC, ending 20:57 UTC. Read it with
`sudo journalctl -u mail-bridge-idle-test`; the last line says PASSED or LOST.

**Still to do**
1. **Open ports 993, 465 and 587** in deepo's security group, and confirm 3.130.37.150 is an Elastic IP. Needs
   `aws login` (the session has expired).
2. **A real certificate** for `mail.xstate.com` from Let's Encrypt. deepo has no Let's Encrypt account any more, so
   this means registering one and accepting their terms; it also needs a small nginx server block for
   `mail.xstate.com` on port 80 (today port 80 redirects everything to hireninja).
3. After both: Apple Mail, Thunderbird and Outlook against `mail.xstate.com`, and a send to Gmail with a Bcc.
4. Read the cost of the idle test's Durable Object from Cloudflare's analytics and write the cost per connection
   into `pricing-plan.md`.
5. Revoke the app password "Production test (temporary)" once the idle test has ended.

## 18. Phase 3 as built (2026-11-20)

Reading mail over IMAP. Every folder opens read-only; flags, moves, deletes and saving messages are phase 4.

**Code**
- `imap/syntax.ts`: cuts the byte stream into commands (literals included) and commands into tokens; sequence sets.
- `imap/message.ts`: a raw message as IMAP describes it: ENVELOPE, BODYSTRUCTURE, and where every numbered section
  is in the bytes (`describe`), kept per message as `imap_meta`.
- `imap/search.ts`: SEARCH keys as a tree, and the tree as SQL over the store's tables.
- `imap/names.ts`: folder names in modified UTF-7, and LIST patterns.
- `imap/prepare.ts`: makes a mailbox's old mail ready in the background (batches of 120 on the mail-events queue).
- `relay/imap-session.ts`: the real session, replacing the phase 0 spike.
- `mailbox/store.ts`: the `placements (folder_id, uid)` index, the `imap_meta` column, the `watchers` table, and the
  methods `imapFolders`, `imapOpen`, `imapRows`, `imapSearch`, `imapSetMeta`, `imapMissingMeta`, `watch`, `unwatch`.
- `auth/app-passwords.ts`: `appAccess`, the live check a session makes each time a folder is opened.

**What a mail app can do**
- Sign in with LOGIN or AUTHENTICATE PLAIN (an app password).
- LIST, LSUB, STATUS, NAMESPACE, ID, ENABLE, CAPABILITY.
- SELECT and EXAMINE (both read-only for now), CLOSE, UNSELECT, NOOP, CHECK.
- FETCH and UID FETCH: FLAGS, UID, INTERNALDATE, RFC822.SIZE, ENVELOPE, BODY, BODYSTRUCTURE, MODSEQ, RFC822 and its
  parts, and `BODY[...]` / `BODY.PEEK[...]` for any section, with partial ranges and `CHANGEDSINCE`.
- SEARCH and UID SEARCH: flags, dates, sizes, FROM, TO, CC, BCC, SUBJECT, BODY, TEXT, HEADER, UID, MODSEQ, NOT, OR.
- IDLE, with new mail, removals and flag changes pushed as they happen.
- Refused for now, with a reason: STORE, COPY, MOVE, EXPUNGE, APPEND, CREATE, DELETE, RENAME.

**How it holds together**
- **UID list:** kept in the session's storage as one compact row per 262,144 UIDs, not a row per message, so opening
  a 53,000-message folder writes one row.
- **Headers:** `imap_meta` holds each message's whole header block (up to 32 KB), its structure and its section
  map. Header fetches, ENVELOPE and BODYSTRUCTURE need no R2 read. Bodies and attachments are ranged R2 reads.
- **Old mail** is made ready in the background when an app password is created and when a mail app opens a folder
  with more than 100 messages still to do. Anything not ready yet is made on demand at FETCH.
- **Order and flow control:** one command at a time; answers are sent at most 1 MB ahead of what the mail app has
  taken, with a timer keeping the session awake while it waits.
- **Changes** reach an idle session through the store's `watchers`: every change calls the waiting sessions, once
  per burst.
- **Access** is checked again at every SELECT; lost access ends the session with BYE.

**Changed from the plan**
- **The whole header block is kept**, not about 1 KB of chosen headers: Apple Mail asks for many headers by name,
  and each missing one would cost an R2 read per message. At about 5 KB a message that is roughly 265 MB for 53,000
  messages, well inside the store's limits.
- **Search is close, not exact,** where the store can't be: body words match by stem, the sent date is the received
  date, and CC, BCC and unusual headers are looked for anywhere in the header block.
- **`\Recent` is never set and `BODY` answers like `BODYSTRUCTURE`.** Mail apps don't depend on either.
- **Not built yet:** the cap of about 15 connections per mailbox, and LITERAL+.

**Tested locally** (`apps/api/scripts/imap-test.py`: Python's imaplib as the mail app, 35 checks, all passing; plus
unit tests for the four `imap/` modules, 21 tests):
- Sign-in, folder list with roles, STATUS, opening a folder, UIDs for every message.
- Header fields as written; ENVELOPE; BODYSTRUCTURE; the whole message at exactly the size RFC822.SIZE promised;
  each part, a part's own headers, TEXT, a partial range, a part that doesn't exist.
- An attachment comes back byte for byte. A 24.6 MB message downloads whole in about 3 seconds.
- SEARCH by subject, by body words with a date, for nothing, and with an unknown key.
- After the session sleeps, sequence numbers still map to the same UIDs.
- IDLE: a new message arrives as `EXISTS`; a flag changed in the web app arrives as a `FETCH`; NOOP reports the next.
- STORE, COPY and CREATE are refused.

**Still to check in production:** a first sync of the 53,000-message mailbox (time, and the cost of the
background preparation), then Apple Mail, Thunderbird and Outlook once the ports are open.

