# Plan: Mailboxes without Stalwart

Status: design for review (2026-11-17), revised the same day after a review against the code. Nothing built.
Decisions marked "decided" were made with the user on 2026-11-17; everything else is a proposal.

Today every mailbox lives in Stalwart on one server (deepo: 2 vCPU, 3.7 GB, Postgres 1.3 GB for about 82,000
messages, roughly 16 KB per message, message contents in R2). Mail arrives over SMTP at Stalwart, goes out through
Stalwart's relay to SES, and every read, search and calendar call is a JMAP request to that one server. This plan
moves mail, calendars and search onto Cloudflare and SES and retires Stalwart.

Why now:

- **One server holds everyone's mail.** If deepo is down, mail stops. Its disk fits about 1.2 million more messages,
  and search slows well before that as Postgres's index outgrows memory.
- **Search can't match part of an address.** On a Postgres data store, Stalwart's search uses Postgres full-text
  search, which indexes `mailer@waveapps.com` as one word, so `from: waveapps.com` finds nothing (tested in
  production 2026-11-17; the same query works on the local RocksDB stack).
- **Agents and search already live on Cloudflare.** Mail sync copies every message into Vectorize and drives email
  triggers; the mail itself is the only part still on a server.

**Effort (rough guess, not an estimate):** the spike is days; the whole plan is months of work, most of it in
becoming the mail server (parsing, threading, calendars, moving mail safely).

## Decided

- **Receiving through SES, not Cloudflare Email Routing.** SES receiving works for any customer domain with only an
  MX record (us-east-2 supports it: `inbound-smtp.us-east-2.amazonaws.com`). Email Routing needs the domain's DNS on
  Cloudflare, which most customer domains won't have.
- **Sending stays on SES.** Workers call SES directly instead of going through Stalwart's relay.
- **One object per mailbox ("every mailbox is an agent"),** built on the Agents SDK: its own SQLite database for
  folders, flags, threads, headers, calendars and the search index, plus schedules and live connections. Message
  contents and attachments stay in R2.
- **AI agents are separate objects and can serve several mailboxes.** A mailbox runs no AI unless an agent is
  attached to it, so free mailboxes cost nothing in model usage.
- **Calendars move into the mailbox object.** Invitations are calendar emails through SES, so Stalwart can go
  entirely.
- **No IMAP gateway for now.** Mail is still stored the way IMAP expects (see [IMAP later](#imap-later)), so one can
  be added without every mail app re-downloading everything.

## Proposed decisions

- **The mailbox object starts as a shadow copy.** It is filled from Stalwart (a full copy, then the existing change
  feed) while Stalwart stays in charge. That proves the store on all the real mail before it is trusted with any,
  and lets lists, filters and search be served from it early, which fixes domain search. The copy has to be built
  anyway to move mailboxes, so this is not extra work. (The first draft built the new mail path first; the review
  reversed that.)
- **A domain switches when its MX record does.** `mailboxes.backend` (`stalwart` or `store`) says which side is in
  charge of a mailbox; it flips for all of a domain's mailboxes once the MX points at SES.
- **Moving back is only cheap before the MX switch.** Until then the store is a copy and can be dropped. After it,
  new mail exists only in the store, and going back means copying it into Stalwart.
- **Copied mail keeps its Stalwart ids** (message and thread ids). Vectorize passages (`email:<mailbox>:<id>`),
  attachment records (`files.email_id`), links and agent memory then keep working with no id map and no
  re-embedding. New mail gets ids in a range that can't collide.
- **The operations don't change.** `email_*`, `calendar_*` and `storage_*` keep their names, inputs and results, so
  the web app, mobile app, API customers, MCP and agents keep working. Only `mailserver/` gets a second backend.
- **Mail between xstate mailboxes never leaves Cloudflare.** A message to another xstate mailbox goes straight to
  that mailbox object; only mail for outside addresses goes to SES. This matches today, where mail between xstate
  domains stays on Stalwart and isn't counted against sending caps.
- **Unknown recipients are dropped, not bounced.** SES has already accepted the message by the time we see it, so a
  bounce would go to a possibly forged sender (backscatter). The drop is logged. xstate has no catch-all
  addresses today; one could be added later as a per-domain setting.
- **The raw message in R2 is the record.** Everything in the mailbox object except folders, flags and calendars can
  be rebuilt from it (see [Recovery](#recovery)).

## How it works

### Receiving

```
sender ──SMTP──▶ SES receiving (us-east-2): one rule for all verified domains
                   ├─ raw message ──▶ S3 (temporary)
                   └─ notification with spam, virus, SPF, DKIM, DMARC verdicts ──▶ SNS ──▶ POST /webhooks/ses-inbound
Worker ──▶ MAIL_IN queue ──▶ consumer:
            1. fetch from S3, store the raw message in the organization's R2 bucket, delete it from S3
            2. parse (MIME, character sets, attachments); apply SES verdicts and our file-type rules
            3. find the recipient mailboxes (addresses, aliases, shared mailboxes)
            4. deliver to each mailbox object (idempotent on the SES message id and recipient)
            5. queue attachment scans, search indexing (Vectorize), push notifications and agent events
```

- **Recipients come from the envelope** (the recipients SES reports), never from the To and Cc headers, or mail
  sent by Bcc and to mailing lists would be lost.
- **Verdicts:** a receipt rule can't act on SES's verdicts without a Lambda, so the consumer refuses a message whose
  virus verdict is FAIL (quarantined in S3 for 7 days). The spam, SPF, DKIM and DMARC verdicts feed the spam score
  (see [Spam](#spam)).
- **SES already has every customer domain** as a verified identity (Easy DKIM, `mailserver/ses.ts`), which receiving
  requires. SES allows 10,000 identities per region by default; the limit can be raised.
- **Retries:** the queue retries with backoff, with a dead-letter queue. A message stays in S3 until it is safely in
  R2, and S3 lifecycle deletes anything left after 7 days.
- **To verify in the spike:** the largest message SES accepts with an S3 action, SES receiving prices, and parsing
  speed and memory for large messages in a queue consumer.

### Sending

- `email_send`, replies, forwards and calendar invitations build the MIME message in the Worker and call SES's API
  (`SendEmail` with raw content). That needs an IAM user allowed to send; today's SES user can only manage
  identities.
- Caps, suppression and suspension (`mailserver/sending.ts`) stay as they are. They become the only path out, since
  SMTP sending from mail apps goes away with IMAP.
- **SES replaces the Message-ID** with its own, so the sent copy is stored with the id SES returns (found in the
  spike). Replies will reference that id.
- The sent message is stored in the sender's Sent folder in the mailbox object, and its raw form in R2. The Email
  API's "save to Sent" (`emails/service.ts`) and system mail (`mailserver/system-mail.ts`) use the same path.
- Bounce, complaint and delivery notifications keep arriving at `/webhooks/ses`, as now.

### The mailbox object

One `Mailbox` object per mailbox (a new SQLite-backed class on the Agents SDK, as `AgentStore` already is). It does
fast, small work only: parsing, scanning, embedding and model calls happen in queues and Workers, which hand it the
results.

| Table | Holds |
|---|---|
| `folders` | Inbox, Sent, Drafts, Archive, Junk, Trash and custom folders; per folder `uid_validity`, `uid_next`, `highest_modseq` |
| `messages` | Message id, thread, folder, IMAP-style `uid`, `modseq`, flags, Message-ID, In-Reply-To, References, sender address, **sender domain**, sender name, recipients, subject, sent and received times, size, has-attachment, preview, R2 key, SES verdicts |
| `attachments` | The D1 `files` id, name, type, size, its start, length and encoding inside the raw message, scan status (scanning, clean, infected, unscannable) |
| `threads` | Thread id, subject, latest message, count |
| `message_headers_fts`, `message_text_fts` | Full-text indexes (see [Search](#search)) |
| `calendars`, `events` | See [Calendars](#calendars) |
| `delivery_log` | See [Delivery log](#delivery-log) |
| `rules` | Later: the mailbox's own filters and forwarding |

- **Threading:** the References and In-Reply-To headers first, then the same subject from the same people within a
  window.
- **Size is not known yet.** A Durable Object holds 10 GB. Headers are small, but the full-text index grows with
  body and attachment text, so indexed text is capped per message (proposed 250,000 characters, attachments cut
  first). The spike measures a 53,000-message mailbox; if very large mailboxes could still reach the limit, older
  mail's text index moves to a second object per mailbox.
- **Quota:** a mailbox's storage quota (`quotaBytes`) is checked against the sizes the object records, at delivery.
- **Live updates and push:** after a change the object tells the organization's `LiveHub`, and new mail queues a
  push notification (`push/new-mail.ts`), both as mail sync does today.
- **Schedules:** snooze, send later and reminders use the object's alarms.
- **Deleting a mailbox:** the object's storage, its R2 prefix and, through the existing hourly sweep, its vectors.

### Where mail is stored

| What | Where |
|---|---|
| The raw message, attachments included | R2, one object per message, in the organization's own bucket under the mailbox's prefix |
| Each attachment's place in that object (start, length, encoding), name, type, size, scan status | The mailbox object's `attachments` table |
| Text taken from attachments, for search | The mailbox object's full-text index, and Vectorize |
| A file someone saves from an email into Storage | R2, as a separate file in the organization's bucket, as Storage works today |

- **Attachments are stored once.** Today each is kept twice: inside the message (encoded, about 1.33 times its
  size) and as a separate copy in the organization's bucket for downloads, scanning and search, about 2.3 times in
  all. In the new design a download, a scan or a text extraction reads only the attachment's part of the raw
  message from R2 (a range read) and decodes it as it streams. That saves about 43% of attachment storage.
- **Attachment records stay in D1 with the same ids.** Each `files` row for a mail attachment is kept and pointed at
  the attachment's place in the raw message instead of a separate file. Search passages for attachments are keyed by
  that id (`file:<id>`), so deleting the rows would make the hourly sweep remove their vectors.
- **Nothing is re-embedded.** Email passages are keyed by mailbox and message id, which copied mail keeps, and each
  passage carries its own text, so existing vectors keep working after the move. Only mail that was never indexed or
  failed is embedded, by the existing daily retry.
- **One function reads attachments.** The download route, the scanner, the search indexer and Storage's attachment
  views all go through it instead of opening a file.
- **An attachment inside an attached email** needs the step twice. It is rare; those keep a separate copy.
- **The raw message is never cut up.** Keeping attachment files and removing them from the message would save the
  same space, but the original could no longer be reproduced exactly, which a later IMAP gateway and signature
  checks need.
- **The organization's bucket, not one shared bucket,** so deleting an organization removes all its mail and usage
  can be measured per organization. (Stalwart keeps message contents in one shared bucket, `xstate-mail-blobs`.)
- **S3 is only a stop on the way in.** SES can save received mail only to S3; the receiving consumer copies each
  message to R2 within seconds and deletes it from S3.

### Search

| Question | Answered by |
|---|---|
| Lists and filters: sender, **domain**, recipient, subject, dates, folder, flags, attachments; counts | The `messages` table, with indexes |
| Part of an address, name or subject, such as `waveapps` or `INV-4566` in a subject | `message_headers_fts`: FTS5 with the trigram tokenizer over sender, recipients and subject only (check Durable Object support in the spike) |
| Words in the body or attachments | `message_text_fts`: FTS5 with ordinary word matching and prefixes. Trigrams on bodies would roughly triple the index. |
| Meaning: questions, different wording, inside attachments | Vectorize, as now, with sender and date filters taken from the `messages` table |
| Several mailboxes ("All inboxes", an agent's mailboxes, admin views) | Each mailbox object queried at the same time, merged by date or score |
| Large organizations (hundreds of mailboxes) | Later: an organization-level index of headers, one row per message, so organization-wide lists are one query |

`email_list_messages` and the web app's search run on the first three rows; `email_search` on the fourth.

### Calendars

- Events live in the mailbox object as JSCalendar (what Stalwart and our code already use; iCalendar only for
  invitation emails, see phase 3), plus columns for start, end, recurrence and attendees. A repeating event is stored
  once and expanded when shown. Time zones come from the event.
- **Invitations are calendar emails through SES.** Creating, changing or cancelling an event with guests sends the
  matching email with a `.ics` attached. An incoming invitation arrives like any other mail: the mailbox object
  reads its calendar file, shows it as an invite, and sends the accept or decline reply by email. Replies update the
  organizer's guest list.
- Invitations to outside guests count against sending caps, as now.
- Free/busy and shared calendars read across mailbox objects.
- The web app keeps FullCalendar; only the API behind `calendar_*` changes. The Google Calendar import writes into
  the mailbox object.
- CalDAV (Apple Calendar, Thunderbird) goes away with Stalwart, like IMAP.

### AI agents

- Each AI agent stays its own `AgentStore` object (settings, memory, runs). Agents and mailboxes are many-to-many,
  as configured today.
- **New mail reaches agents through a queue.** After storing a message, the mailbox object puts a "new mail" event
  on `MAIL_EVENTS` for each agent attached to it. This replaces email triggers riding on Stalwart's mail sync and
  their saved JMAP state (`agents/email-trigger.ts`). The loop guard and rate limits stay.
- **The same email in two of an agent's mailboxes** (sent to support@ and sales@) runs once: the agent keeps the
  Message-IDs it has handled.
- An agent replies from the mailbox the email arrived in, can only use its own mailboxes (as now: `runBuiltin` with
  `actor.mailboxIds`), and sending still needs approval by default. Mail content stays data, never instructions.

### Attachments and viruses

| Layer | Where | Catches |
|---|---|---|
| SES verdicts | Free, on every message received | Viruses and spam, before we store anything |
| File-type rules | The receiving consumer (`security/attachments.ts`, already in Workers) | Programs, disguised programs, macros, risky archives |
| ClamAV | The existing `apps/scanner` service, on an always-on container or small server, fed by a `SCAN` queue | Known malware, including inside archives |

- Attachments are saved as "scanning" and can't be downloaded until cleared, usually within seconds. The message
  itself shows at once.
- Infected attachments are blocked for good and the message goes to Junk with the reason shown. Files that can't be
  scanned are allowed with a warning, as the rules already do for archives.
- Outgoing attachments go through the same scan, as `security/scan.ts` does for uploads today.
- ClamAV stays always on, because loading its signatures takes tens of seconds and a cold start would slow every
  scan.
- **Attachments are stored once, inside the raw message** (see [Where mail is stored](#where-mail-is-stored)).

### Spam

Each incoming message gets a score from the layers below, cheapest first; over a threshold it goes to Junk. Stalwart's
own spam filter goes away with it, and SES's verdict alone is a coarse pass or fail, so expect more spam than today
unless the later layers are built (not measured yet).

| Layer | Checks | Where |
|---|---|---|
| 1. SES verdicts | SES's spam verdict, and SPF, DKIM and DMARC results | Free, on every message |
| 2. Sender authentication rules | DMARC failure on a domain whose policy is reject or quarantine; a From name imitating one of the organization's own people; a Reply-To on a different domain | Rules in the receiving consumer |
| 3. What the mailbox knows | Has this mailbox written to the sender before; is the sender in the organization's contacts; did the user mark the sender as junk or not junk | The mailbox object and `AudienceStore` |
| 4. A spam engine | Rspamd: content rules, link and sender blocklists, known spam patterns | The scanner container, next to ClamAV |
| 5. A model for borderline mail | A small classifier on Workers AI, only for messages the other layers leave uncertain | Per message |

- **Layer 3 is what a general filter can't do:** a reply from someone the mailbox has emailed should almost never go
  to Junk.
- **Feedback:** "Mark as junk" and "Not junk" update the mailbox's sender list at once. An organization-wide
  blocklist and allowlist sit on top.
- **Rspamd** needs a small Redis next to it to learn from feedback, so the scanner container would hold spam
  statistics (never mail). Blocklists such as Spamhaus need a paid data feed for commercial use, and their free
  lookups don't work from Cloudflare's resolvers; prices not checked.
- **Layer 5** only returns a score: the model has no tools and can't act on what it reads.
- **Order:** layers 1–3 with the new mail path. Measure what gets through during the pilot, add Rspamd if that isn't
  good enough, and layer 5 last, if at all.
- Outgoing spam is already covered by the sending caps and suspension rules (`mailserver/sending.ts`).

### Delivery log

Support has to be able to answer "where is my email". Each message leaves one line per step: received by SES (with
verdicts), stored in R2, delivered to which mailbox and folder, attachments scanned, or dropped and why (unknown
recipient, virus). Lines for delivered mail live in the mailbox object's `delivery_log`; drops, which have no
mailbox, go to a D1 table. Kept 30 days. Never the content, only ids, addresses and outcomes.

### Recovery

- **Raw messages in R2 are the record.** The headers, threads and full-text indexes of a mailbox object can be
  rebuilt from them.
- **Folders, flags and calendars exist only in the object.** They are covered by Durable Objects' point-in-time
  recovery (30 days for SQLite-backed objects; confirm in the spike).
- A rebuild job (list a mailbox's R2 prefix, re-parse, re-insert) is part of the first phase, because the copy from
  Stalwart needs most of it anyway.

### IMAP later

No gateway now. To keep the door open, every folder has `uid_validity`, `uid_next` and `highest_modseq`, and every
message a `uid` that only goes up and a `modseq` that changes with each flag or move. A later gateway (a stateless Go
service using `go-imap`, calling the mailbox objects) could then let mail apps sync without re-downloading.
Cloudflare's inbound TCP for Workers and Containers was in private beta in November 2026; until it's generally
available, a gateway would need an ordinary server.

## What else depends on Stalwart

Found by searching the API for code that calls `mailserver/stalwart/`. Each needs a store-backed path before
Stalwart can go:

| Today | In the new design |
|---|---|
| Mail sync and the Stalwart webhook (`jobs/mail-sync.ts`, `jobs/stalwart-webhook.ts`, `storage/mail-sync.ts`) | Replaced by the receiving consumer; scans and search indexing are queued from it, and attachments are no longer copied out of messages |
| Search indexing and results (`search/indexer.ts`, `search/search.ts`) | Read message text and senders from the mailbox object |
| New-mail push (`push/new-mail.ts`) | Queued by the mailbox object |
| Email triggers (`agents/email-trigger.ts`, `triggers.ts`, `trigger-text.ts`) | The `MAIL_EVENTS` queue |
| Mailboxes, aliases, shared access, quotas (`mailserver/mailboxes.ts`, `aliases.ts`, `sharing.ts`) | D1 only (it already holds them); Stalwart accounts and groups go away. Mailbox passwords are no longer used without IMAP. |
| Domains and DNS records (`mailserver/domains.ts`) | New MX record; SES DKIM only, no Stalwart DKIM fallback |
| Sending blocks (`mailserver/sending.ts`) | D1 stays the source of truth; nothing to sync to Stalwart |
| Calendars (`mailserver/calendar.ts`, `calendar-events.ts`) | The mailbox object |
| Google Workspace import: mail, calendar, cutover (`migration/mail.ts`, `mail-rules.ts`, `calendar.ts`, `final.ts`) | Writes raw messages to R2 and rows into the mailbox object, instead of `Email/import` |
| Email API save to Sent, system mail | The sending path above |

## Moving existing mail

1. **Copy (shadow).** A queue job lists every message through JMAP and, for each, downloads the raw message, stores
   it in R2 and adds it to the mailbox object with its folder, flags and Stalwart ids. It's throttled like the
   Google import (`migration/copy-pool.ts`). Attachment positions are recorded from the raw message; the separate
   attachment copies made by today's mail sync are deleted once the domain has switched, which frees that space;
   their `files` rows stay, with the same ids.
   Calendars copy the same way.
2. **Keep in step.** Mail sync's change feed applies new mail, moves, flags and deletions to the object. Writes
   still go to Stalwart and reach the object through the feed, seconds later.
3. **Check.** Counts per folder, and a sample of messages compared field by field, must match before a mailbox is
   trusted. Reads (lists, filters, search) can move to the object once they do.
4. **Switch the domain's MX** to SES. Domain Connect (built 2026-11-17) can make the change for providers that
   support it; others get the record to paste. **For a day or two mail arrives on both sides:** the object accepts
   mail from SES and from the change feed, and drops duplicates by Message-ID.
5. **Flip `mailboxes.backend` to `store`** for the domain's mailboxes once Stalwart has received nothing new for a
   day. Writes now go to the object.
6. **Keep Stalwart read-only for 30 days**, then delete the accounts.

## Phases

### 0. Spike (throwaway code)

- A `Mailbox` object holding 53,000 messages (hireninja's headers and a sample of bodies): database size, list and
  filter speed, both FTS5 indexes, whether the trigram tokenizer works in Durable Objects, time to fill it, and
  whether the Agents SDK adds enough over a plain Durable Object.
- MIME parsing in a queue consumer: memory and CPU on large messages, odd character sets, nested multiparts, and
  whether the parser can report each attachment's position in the raw message for range reads.
- SES receiving in us-east-2 for a test domain: receipt rule → S3 → SNS → Worker. Largest message, verdicts, prices.
- Direct SES sending with raw MIME, including attachments and a calendar invitation.
- Spam layers 1–3 replayed over hireninja's Junk folder and a sample of its Archive: how much spam they catch, and
  how much real mail they wrongly flag. (Old mail has no SES verdicts, so only layer 3 can be measured this way.)
- A cost estimate from the measurements: SES receiving, Durable Object storage and requests, R2.

#### Findings so far (2026-11-17, local only)

Run with wrangler 4.157 on a laptop (local workerd, not production), on a SQLite Durable Object loaded with 53,000
generated messages: real senders and subjects from the hireninja mailbox, made-up body text averaging 7.7 KB per
message (408 MB in all). Real mail will differ; the shadow copy gives the real numbers.

| Measured | Result |
|---|---|
| Headers table with five indexes and a 256-character preview | 31 MB, about 590 bytes per message |
| Trigram index over sender, recipients and subject | Works in a local Durable Object; adds 20 MB, about 370 bytes per message |
| Body index, word positions and 2–3 letter prefixes | 433 MB, about 1.06 times the text |
| Body index, word positions, no prefix index | 254 MB, about 0.62 times the text |
| Body index, no word positions (`detail='none'`), no prefix index | 42 MB, about 0.10 times the text |
| Loading 53,000 messages with all indexes | 25 seconds |
| Newest 50 in a folder; 100 from one domain; one domain in one year; one thread | 2 ms each, reading only the rows returned |
| Count for one domain (35,684 messages) | 6 ms |
| Part of an address through the trigram index, newest 50 | 13 ms |
| A body word, newest 50 | 9 ms (38 ms for a prefix without the prefix index) |

- **Size per mailbox.** With word positions and prefixes a 10 GB object holds roughly 1.1 million messages of this
  size; without positions, roughly 5.7 million. Without positions, a search for several words finds messages
  containing all of them, but not an exact phrase. Proposed: no positions, no prefix index; exact phrases are rare
  in mail search and Vectorize covers meaning.
- **Unread counts read every row** (53,000) as written. Keep counters per folder, or add an index on flags.
- **Search sorts every match** before returning the newest 50, so one search reads about 100,000 rows. Fast, but
  rows read are billed, so the cost estimate should include it.
- **MIME parsing (postal-mime 4.2.1, in Node):** encoded subjects and names, windows-1252 and Shift_JIS bodies,
  nested multiparts and a boundary look-alike inside a body all parsed correctly. A 35 MB message took 272 ms but
  about 126 MB of memory, which is at a Worker's 128 MB limit.
- **postal-mime does not report where a part sits in the raw message.** A 90-line locator written for the spike
  finds every leaf part's start, length and encoding in one pass (74 ms for 35 MB, no decoding). Reading that range
  and decoding it gave byte-identical files for base64 and 8bit attachments in 2, 14, 35 and 52 MB messages.
- **So the receiving consumer should not parse whole messages with postal-mime.** It locates the parts, decodes only
  the headers and text parts, and leaves attachments in place. That keeps memory near the raw message's size.
- **SES limits (AWS docs):** a received message can be at most 40 MB with the S3 action; a sent message at most
  40 MB and 50 recipients (larger recipient lists must be split); a rule set has at most 200 rules, so one rule for
  all domains, not one per domain.
- **SES prices (AWS pricing page):** receiving costs $0.10 per 1,000 emails plus $0.09 per 1,000 chunks of 256 KB;
  sending costs $0.10 per 1,000 emails plus $0.12 per GB of attachments. A mailbox receiving 1,500 emails a month
  costs about $0.15 to $0.30 a month to receive, which matters for free mailboxes.

**SES receiving and sending, end to end (2026-11-17, us-east-2).** Test: an MX record for `spike.xstate.com`, one
receipt rule with an S3 action and an SNS topic, mail sent through the SES v2 API from `spike@xstate.com`. All test
resources were deleted afterwards.

- **It works.** A plain message, one with a 200 KB attachment and a calendar invitation each reached S3 within
  about 2 to 4 seconds of sending. The attachment read back by position matched byte for byte.
- **The notification has what delivery needs:** the envelope recipients (including a Bcc recipient that is not in
  the headers), the S3 key, and spam, virus, SPF, DKIM and DMARC verdicts. About 5 KB each. The stored message
  also carries the verdicts as headers (`X-SES-Spam-Verdict`, `X-SES-Virus-Verdict`, `Authentication-Results`).
- **One message to several recipients is stored once,** with one notification listing all of them.
- **Size:** a 37.8 MB message sent and arrived (40.2 MB as stored, 17 seconds end to end). A 41.9 MB one was refused
  at sending: "Message length is more than 41943040 bytes". So the practical limit is about 28 MB of attachments.
- **SES replaces the Message-ID of mail we send** with its own (`<SES id>@us-east-2.amazonses.com`). Threading and
  the agents' duplicate check must use the id SES returns from the send call, not the one we wrote.
- **A receipt rule for a domain does not cover its subdomains,** and the rule set must be made active. No rule set
  existed in the account before the test.
- **SES refuses mail from badly rated IP addresses** before any rule runs ("IP address blacklisted by recipient",
  seen when delivering straight from a home connection). That is one more spam layer, free.

**Cost estimate.** Prices from AWS's and Cloudflare's pricing pages on 2026-11-17; usage figures are assumptions
(an average message of 75 KB including attachments, taken from the hireninja mailbox) or local measurements.

| Per 1,000 emails received | Cost |
|---|---|
| SES receiving ($0.10 per 1,000, plus $0.09 per 1,000 chunks of 256 KB) | $0.10 to $0.19 |
| Durable Object rows written (9 per message measured locally: 7 for the table and its indexes, 2 for the search indexes; 20 assumed with flag changes; $1 per million) | $0.02 |
| S3 on the way in (put, get, transfer out at $0.09 per GB) | about $0.01 |
| R2 write ($4.50 per million) and queue operations ($0.40 per million) | under $0.01 |
| **Total** | **about $0.15 to $0.25** |

| Stored, per month | Cost |
|---|---|
| Raw mail in R2 ($0.015 per GB) | A 53,000-message mailbox is about 4 GB: $0.06 |
| The mailbox object's index ($0.20 per GB) | About 0.1 to 0.2 GB without word positions: $0.02 to $0.04 |

- **SES receiving is most of it,** and it is a cost Stalwart doesn't have. A mailbox receiving 1,500 emails a month
  costs about $0.25 to $0.40 a month; 1,000 such free mailboxes about $250 to $400 a month.
- **Reads are close to free.** Lists read only the rows they return; a search reads about 100,000 rows, a hundredth
  of a cent. Workers Paid includes 25 billion rows read, 50 million rows written, 5 GB of Durable Object storage
  and 10 GB of R2 a month.
- **Copying today's 82,000 messages** is about 1.6 million rows written and 82,000 R2 writes: under $1.
- **A later saving:** domains whose DNS is on Cloudflare could receive through Email Routing, which is free. Not
  planned.
- **Not included:** Vectorize and embeddings (unchanged from today), the scanner server, and sending (unchanged).
- How SES counts chunks for a message under 256 KB is not stated on the pricing page; hence the range.

**Cloudflare limits (docs, 2026-11-17).** 10 GB per SQLite Durable Object; a row or value up to 8 MB; 100 bound
parameters per query; 30 seconds of CPU per request by default. Point-in-time recovery reaches back 30 days.
FTS5 is listed as supported; the docs don't mention the trigram tokenizer, which worked locally. Each index update
counts as a row written. Nothing was deployed, so production behaviour is from the docs, not measured.

**Spam replay (layer 3 only).** Old mail has no SES verdicts, so only "has this mailbox written to the sender"
could be replayed, on the hireninja mailbox: all 202 messages in Junk (what Stalwart's filter caught in five
weeks), the newest 200 in Archive (two weeks), against the recipients of the newest 300 of 1,316 Sent conversations.

| | Junk (202) | Archive (200) |
|---|---|---|
| From an address the mailbox has written to | 0 | 1 |
| From a domain the mailbox has written to | 6 | 26 |

- **Layer 3 rescues, it doesn't detect.** The 6 Junk messages from known domains look like real mail filed wrongly
  (Cloudflare billing notices, a Shopify security message, a Google Play notice), so the check would have saved
  them. But almost all wanted mail here comes from automated senders the mailbox never wrote to (Upwork, LinkedIn,
  Substack), so "unknown sender" says nothing.
- **Detection therefore rests on layers 1, 2 and 4.** This makes Rspamd (layer 4) more likely to be needed than the
  plan assumed. Only the pilot can measure SES's own verdict.
- Two Junk messages claimed to come from the mailbox's own domains; one looks forged. That is layer 2's job (DMARC).
- Limits of this replay: one mailbox, a quarter of its Sent folder, and Junk as Stalwart judged it.

**Agents SDK or a plain Durable Object.** Not measured; from reading the code. `AgentStore` already extends the
SDK's `Agent` and uses its scheduler for trigger schedules, which is the part a mailbox needs too (many snoozes and
send-laters per mailbox, where a plain object has one alarm). The mailbox doesn't need the SDK's client
connections, since `LiveHub` carries live updates. The cost is the SDK's own tables in every mailbox and following
a pre-1.0 package (0.33). Conclusion: stay on the SDK, as decided, mainly for the scheduler and for one way of
writing objects across the codebase.

Not done: anything on production Cloudflare (no deploy was made), and attachments inside an attached email. Spike
code is in the session scratchpad only.

### 1. The mailbox object as a shadow copy

The `Mailbox` object, the copy and change feed from Stalwart, the checks, the rebuild job, and lists, filters and
search served from it behind a flag. Our own mailboxes first. This is where domain search gets fixed.

#### Built so far (2026-11-17, uncommitted, off for every mailbox)

- **`MailboxStore`** (`mailbox/store.ts`, binding `MAILBOX_STORE`, wrangler migration `v5-mailbox-store`): one
  object per mailbox on the Agents SDK, holding headers, folders, flags and body text, with the two search indexes
  the spike settled on (trigram on headers; words without positions on bodies). The SQL its lists run is in
  `mailbox/query.ts`, with tests.
- **The copy and the change feed** (`mailbox/shadow.ts`): on each mail sync, with its own saved change state kept in
  the store. The first run queues every message (`store-emails` jobs on the search queue, 50 messages each); later
  runs apply new mail, moves, flags and deletions. Raising `COPY_VERSION` makes every store copy again.
- **The check:** once an hour the store's per-folder counts are compared with Stalwart's and logged as
  `mailbox-store-check`, with `ok: true` when they match.
- **Reads behind a flag:** `mailboxes.store_mode` (D1 migration 0034) is `off`, `shadow` or `read`. With `read`,
  `email_list_messages` (lists, filters and the text query) is answered by the store with no call to Stalwart;
  everything else still goes to Stalwart. Set by hand:
  `UPDATE mailboxes SET store_mode = 'shadow' WHERE id = '…'`, then `'read'` once the hourly check says ok.
- **Tried on the local stack** with a small test mailbox: the copy, new mail, mark read, pin, archive and trash all
  reached the store, the count check passed, and 24 of 25 list queries returned exactly what Stalwart returned
  (same rows, order, fields and cursor). The one difference is intended: part of a subject (`INV-45`) matches in
  the store and not in Stalwart.

- **The raw copy** (`mailboxes.store_raw`, D1 migration 0035, off by default): for a mailbox with `store_raw = 1`,
  each raw message is also copied to the organization's bucket at `<mailbox id>/raw/<message id>.eml` (inside the
  mailbox's folder, so it is deleted with the mailbox), at most 2,000 per sync so search indexing keeps its turn on
  the queue (`store-raw` jobs, 10 messages each). A message deleted on Stalwart has its copy deleted. Messages over
  45 MB are skipped and counted.
- **Attachment positions** (`mailbox/mime.ts`, with tests): a locator finds every part's place in the raw message
  without decoding it. Each file part is recorded in the store's `attachments` table with its start, length and
  encoding, and matched to its D1 `files` row by content hash. The first attachment of every message is read back
  from the bucket by range and compared, which proves the read path the plan relies on.
- **Our parsing against Stalwart's, on every message** (`mailbox/parse.ts`, `compare.ts`): the raw message is read
  with postal-mime (new dependency, given the message with the files cut out so memory stays small) and its
  subject, sender, recipients and text are compared with what Stalwart reports. Differences are stored per message.
- **The hourly check** now also reports the raw copy: copied, skipped, still to copy, bytes, attachments found,
  matched and verified, and how many messages differ in which fields, with a few ids to look at.
- **Tried on the local stack** (14 messages, real dev bucket): every raw message copied; our parsing agreed with
  Stalwart's on all of them, including an encoded subject and sender name, an HTML-only message and a
  windows-1252 body; 7 file parts found, 5 matched to `files` rows (the other 2 are 100-byte inline logos the
  attachment sync skips on purpose), 4 read back by range and identical; deleting a message removed its copy.

- **First production run (2026-11-17, asif@xstate.com, 564 messages):** the first copy queued only 50 messages.
  `Email/query` sends no `total` unless `calculateTotal` is set, so the paging loop stopped after one page; the
  local test mailboxes had fewer than 50 messages and never reached a second page. Fixed: the copy now pages until
  a short page, both first-pass queries ask for the total (the attachment sync and search first passes had the same
  loop; production search was complete anyway, because that mail arrived as changes), and `COPY_VERSION` is 2 so
  the store copies again.

- **First raw copy on real mail (2026-11-17, asif@xstate.com):** 566 of 566 messages copied (20.9 MB), counts
  matching Stalwart in every folder, 58 attachments found, 36 matched to `files` rows, 29 read back from R2 by range
  and all identical. Our parsing differed from Stalwart's on the text of 3 messages. Two were harmless: marketing
  mail padded with invisible characters, which parsers break up differently; the comparison now ignores them. One
  was a bug: an email whose plain-text part is empty kept empty text instead of using its HTML part. Fixed, and the
  HTML-to-text conversion now decodes character references such as `&#847;`, which it left as written before; that
  also improves search and agents on HTML-only mail today. `COPY_VERSION` is 3 so the store copies again. The recopy (11:04 UTC) brought the differences down to 1: the same
  email, now read from its HTML by us while Stalwart's text for it is empty. So `plainText` (what search, agents
  and the store read today) now uses the HTML part too when the plain part is blank, and `COPY_VERSION` is 4. After that deploy (12:07 UTC): 567 of 567 messages matching in every folder, all raw
  copies made, 29 of 29 range reads identical, and **no parsing differences**.
- **Read mode on real mail (2026-11-17, 12:10 UTC, asif@xstate.com):** inbox and all-folders lists identical to
  Stalwart's, rows, order and cursor. `from: google.com` found 5 messages where Stalwart finds none. A text search
  for "workspace" also found a Slack email whose links contain the word (our index splits links into words;
  Stalwart's doesn't) and missed an AppSumo email that only says "workspaces": Stalwart stems English words, the
  store didn't. The word index now stems too (`porter`), and stores made before are rebuilt (`COPY_VERSION` 5). A
  store that is being recopied answers lists only partly, so a mailbox in `read` mode goes back to `shadow` before
  a deploy that raises `COPY_VERSION`, and returns to `read` after the check.
- **First large mailbox (2026-11-17, hireninja, 53,730 messages):** queuing the copy took 2.5 minutes inside one
  mail-sync run (well under the 15-minute limit); the copy ran 12:20–13:34 UTC at a steady 11–12 messages a second
  with no errors, and the check at 13:34 matched Stalwart in every folder (53,731, one email having arrived
  meanwhile). 54,180 copies for 53,731 messages: retried and overlapping jobs store a message again, which
  replaces it. While it ran, search indexing for every mailbox waited behind it on the shared queue. The check
  now reports the store's size (`bytes`).
- **Faster copies (2026-11-17):** the first raw batch for hireninja ran at 2.7 messages a second and waited for
  each hourly sync, about 26 hours in all. Store copies now have their own queue (`xstate-mailbox-store`, binding
  `STORE_COPY`, `mailbox/jobs.ts`; up to 4 batches at once), so they never hold up search indexing; raw copies run 4
  at a time within a job, messages over 5 MB on their own, and attachments over 8 MB are not read back, so a job
  stays within a Worker's 128 MB; one sync queues up to 8,000 raw copies. Every raw copy is a download from
  Stalwart, so these numbers are its load: raise them in steps while watching Stalwart's response times. Jobs left
  on the search queue from before still run there.
- **"Durable Object is overloaded" (2026-11-17, 15:20 UTC, hireninja):** 4 raw-copy jobs were refused after the
  speed-up. Each sync handed out its 8,000 messages by updating them one row at a time, holding the mailbox object
  (which answers one request at a time) while copy jobs waited to record results; and every new email's sync handed
  out another 8,000. Now one statement counts what is in flight and one marks the next batch (about 6 ms for 8,000
  rows), and a sync only tops the in-flight count back up to 8,000. Refused jobs were retried, so nothing was lost.
- **Raw copy of a large mailbox done (2026-11-17, 17:07 UTC, hireninja):** 53,747 of 53,747 messages copied
  (5.1 GB), none missing, counts matching Stalwart in every folder; 10,884 attachments found, 8,792 matched to
  `files` rows, 6,288 read back by range and all identical; the store itself is 105 MB. Our parsing differed from
  Stalwart's on 20 messages (19 text, 1 subject), and every one looked at was spacing where we follow the standard
  and Stalwart doesn't: `format=flowed; delsp=yes` bodies (a soft line break after a space joins the words), a
  carriage return the sender encoded inside a link (`=0D`), and a space inside a malformed encoded subject.
  Python's own email parser reads them as we do. The comparison was left as it is, so these stay counted.
- **Read mode on the large mailbox (2026-11-17):** a `waveapps.com` search returned full pages from the store,
  `comms.waveapps.com` included, which Stalwart's search missed. Back to `shadow` before the next `COPY_VERSION`
  deploy.
- **Whole conversations and attachments from the store:** with `read`, `email_get_thread` reads each message of the
  conversation from its raw copy (`mailbox/read.ts`): headers, Cc, Reply-To, date, text and HTML from our parser,
  and the attachments from the parts the locator finds. Their ids are `store.<message id>.<start>`, read back by
  range from the bucket when downloaded. Attaching one to a reply or draft, or reading an invitation from one,
  uploads it to Stalwart first, which still sends and keeps calendars. File names in the RFC 2231 form
  (`filename*=utf-8''…`, split names) are now decoded, and RFC 2047 ones by postal-mime. A conversation with any
  message whose raw copy isn't made yet (new mail waits for the next sync) is read from Stalwart as before.
- **`email_search` senders from the store:** attachment results from a mailbox in `read` mode take their sender and
  arrival time from the store, not Stalwart. Search itself runs on Vectorize and D1 and never asked Stalwart.

Differences from the plan above, for now:

- **The separate attachment copies stay.** Downloads, scanning and search still read them; the positions are
  recorded and proven, and the copies go when a domain switches.
- **No rebuild job yet.** While Stalwart is in charge, raising `COPY_VERSION` copies a mailbox again from Stalwart,
  which does the same job, and nothing could start a rebuild from the bucket today. The parser it needs is the one
  above. It belongs with the new mail path, where the store first holds mail Stalwart doesn't.
- **No IMAP uid or modseq yet.** They are assigned when the store takes charge of a mailbox, in received order.
- **A message can sit in several folders,** as on Stalwart, so placements are their own table.
- **`store_mode` instead of `backend`** while Stalwart is in charge; `backend` arrives with the switch.

Left for phase 2: the rebuild job, and attachments inside an attached email (kept as one file part). Still on
Stalwart in `read` mode: folder counts, marking read, moving and pinning, sending, the change token the apps poll,
and forwarding (the original's attachments come from Stalwart).

### 2. The new mail path

Receiving and sending through SES, drafts, attachments with scanning, spam layers 1–3, the delivery log, push, live
updates and agent events. Pilot on an internal domain that has no existing mail to move.

Built in four steps, each usable on the pilot before the next: **1. receiving**; 2. acting on mail in the store
(read, pin, move, delete, folder counts, the change token); 3. sending and drafts through SES; 4. scanning, spam
layers 2–3, the delivery log, search indexing and agent events.

#### Step 1: receiving (designed and approved 2026-11-17)

**Goal:** mail sent to a pilot mailbox arrives through SES, is kept in R2 and the mailbox's store, and shows up in
the web app, with Stalwart never seeing it. Pilot: a new subdomain, `pilot.xstate.com`, with one or two mailboxes.
It has no existing mail and nobody depends on it. The pilot mailbox can be read and searched (word search) but not
yet marked read, moved or replied to from xstate (steps 2 and 3); that is fine for a few days of testing.

**Which side owns a mailbox.** D1 migration 0036 adds `mailboxes.backend` (`stalwart` | `store`, default
`stalwart`). `store` means the mailbox store holds the mail and nothing syncs from Stalwart: mail sync skips it,
and every read the app makes (lists, threads, attachments, folders and counts, the change token) goes to the
store. `store_mode` stays for mailboxes still on Stalwart. A `store` mailbox keeps its (empty) Stalwart account
until step 3, because sending still goes through Stalwart until then. Pilot mailboxes get `backend = 'store'` by
hand; the switch for a whole domain is phase 4.

**AWS (us-east-2), set up once:**

| Piece | Setting |
|---|---|
| S3 bucket `xstate-mail-inbound` | Private; a bucket policy lets only SES put objects, for this account; lifecycle deletes objects after 7 days |
| SNS topic `xstate-mail-inbound` | HTTPS subscription to `https://api.xstate.com/webhooks/ses-inbound` |
| Receipt rule set `xstate` (active), rule `inbound` | No recipient filter, so it covers every verified domain whose MX points at SES (the spike found a rule's recipient list doesn't cover subdomains, and listing every customer domain doesn't scale); spam and virus scanning on; one S3 action to `xstate-mail-inbound` under `inbound/`, publishing to the topic |
| IAM user `xstate-mail-inbound` | `s3:GetObject` and `s3:DeleteObject` on that bucket only. Its keys become Worker secrets `MAIL_INBOUND_ACCESS_KEY_ID` and `MAIL_INBOUND_SECRET_ACCESS_KEY` |
| MX for `pilot.xstate.com` | `10 inbound-smtp.us-east-2.amazonaws.com` (Cloudflare DNS) |

Only one receipt rule set can be active per region; none is active today, because Stalwart receives over its own
SMTP. A rule cannot act on SES's verdicts by itself (that takes a Lambda), so a message SES marks as a virus is
still saved to S3; the consumer refuses it (below). This corrects [Receiving](#receiving), which said the rule
rejects it.

**The webhook** (`POST /webhooks/ses-inbound`, `jobs/ses-inbound.ts`): verifies the SNS signature with the existing
`jobs/sns.ts`, accepts only the inbound topic's ARN (a new `SES_INBOUND_TOPIC_ARN` var), confirms the subscription
once, and puts one job per message on a new `xstate-mail-in` queue (binding `MAIL_IN`, with a dead-letter queue):
the S3 key, SES's message id, the envelope recipients, the verdicts (spam, virus, SPF, DKIM, DMARC) and the time.
It answers at once; SNS retries when it doesn't get a 2xx.

**The consumer** (`mailbox/receive.ts`), per job, every step safe to repeat:

1. **Recipients.** Each envelope recipient is looked up in D1 `addresses` (primary addresses and aliases). Kept
   only when its mailbox has `backend = 'store'`. Unknown addresses, and mailboxes still on Stalwart (their MX
   should not point here), are dropped and logged with SES's message id, never bounced (see
   [Proposed decisions](#proposed-decisions)). Several recipients in one mailbox count once.
2. **Virus.** SES's virus verdict FAIL: not delivered, logged, and the S3 object moved under `quarantine/` (kept 7
   days by the same lifecycle rule) for support to look at.
3. **Fetch** the raw message from S3 (40 MB at most, SES's limit) and read it with the existing parser
   (`mailbox/parse.ts`: `locateParts`, then postal-mime on the message with its files cut out).
4. **For each mailbox:** a new message id (below), the raw message put in the organization's bucket at
   `<mailboxId>/raw/<messageId>.eml` (the same place the shadow copy uses), then `deliver` on the mailbox's store.
   A message to two mailboxes in one organization is stored twice, once under each mailbox, so deleting one
   mailbox never touches the other's mail. Simple, and rare enough not to matter.
5. **Afterwards:** the S3 object is deleted, the organization's `LiveHub` told, and a new-mail push queued
   (`push/new-mail.ts`), as mail sync does today.

Messages run one at a time per job, and a batch holds at most 4 jobs, so a 40 MB message stays within a Worker's
memory (parsing needs about the text's size, measured in the spike). A failed step retries the job; after 5 tries
it goes to the dead-letter queue, with the message still in S3 for 7 days.

**Ids.** New mail can't reuse Stalwart ids, and copied mail keeps them (see [Proposed
decisions](#proposed-decisions)). Stalwart's ids are lowercase letters and digits (`fsbiaabmqk`), so new message
and thread ids are ULIDs: 26 characters, uppercase, sortable by time, which can never equal a Stalwart id. They are
made in the consumer before the raw copy is written, so the R2 key and the store agree. Idempotency is not on the
id: a retried job looks up SES's message id first (below) and reuses what was stored.

**`deliver` on the mailbox store** (one call, one transaction):

- **Duplicates:** `messages.ses_id` (unique) is SES's message id; a second delivery of it returns the stored
  message and changes nothing.
- **Folders:** a store-owned mailbox makes its own six folders on first use (Inbox, Sent, Drafts, Archive, Junk,
  Trash; ULID ids), instead of copying Stalwart's. New mail goes to Inbox, or to Junk when SES's spam verdict is
  FAIL (spam layers 2–3 come in step 4).
- **Thread:** the In-Reply-To and References Message-IDs are looked up in `messages.message_id` (newest first); the
  first match gives the thread. Otherwise a message with the same subject (after removing `Re:`, `Fwd:` and the
  like) from or to the same address, within the last 30 days. Otherwise a new thread.
- **IMAP numbering** (see [IMAP later](#imap-later)): each folder gets `uid_validity` (random, fixed),
  `uid_next` and `highest_modseq`; each placement a `uid` from its folder's `uid_next`, and the message a `modseq`
  from a mailbox-wide counter that step 2 raises on every flag change and move. Only store-owned mailboxes are
  numbered; shadow copies get numbers when their domain switches.
- **Rows:** the same `messages`, `placements`, `attachments`, `headers_fts` and `text_fts` rows the shadow copy
  writes, plus new columns: `message_id`, `in_reply_to`, `refs`, `ses_id`, `verdicts` (JSON), `uid` on
  placements and `modseq` on messages. Text for the word index is the parser's text with the footer removed, as
  now. The preview is the first 256 characters of that text.
- **Quota:** the mailbox's quota is checked against the store's total size. A full mailbox still gets its mail in
  step 1 and logs a warning; refusing comes with the delivery log in step 4.

**Message-IDs for copied mail.** Threading new mail into old conversations (needed when a real domain switches,
phase 4) needs the Message-ID, In-Reply-To and References of copied mail too. Filled in place, not by raising
`COPY_VERSION` (which would empty the store and copy everything again, raw copies included): see "Threading headers
for copied mail" under phase 4. Not needed for the pilot.

**Reading a store-owned mailbox** uses what phase 1 built (lists, filters, word search, threads, attachments from
R2). New in step 1: `email_list_folders` and the folder counts, and the change token the apps poll
(`getMailState`), come from the store for these mailboxes; the store keeps its own state string, raised on every
`deliver`. Marking read, moving and pinning answer "not available yet" for these mailboxes until step 2.

**Not in step 1:** search by meaning (Vectorize) and agent email triggers for pilot mail (both read from Stalwart
today; step 4 feeds them from the store), attachment scanning by ClamAV and `files` rows for pilot attachments
(step 4; SES's virus verdict and our file-type rules on download still apply), the delivery log (step 4; step 1
logs to Worker logs only), sending (step 3).

**Testing:**

- Unit tests (pure, like `query.ts`): the subject normalizing and thread matching, ULIDs, the SNS job shape, and
  recipient selection.
- Local: `SES_MODE=fake` gets a script that writes a `.eml` to a local folder standing in for S3 and posts a
  signed-looking notification to the local webhook (signature checks skipped only when fake), so the consumer,
  store and app can be tried end to end without AWS.
- Pilot: plain mail, a reply to it (threading), HTML-only mail, a large attachment (35 MB), a message to two pilot
  mailboxes, an unknown address (dropped), the EICAR test file (quarantined), a GTUBE spam test (Junk), and a
  retried job (no duplicate).

**Cost:** SES receiving plus S3 and SNS, measured in the spike at about $0.15–0.25 per 1,000 received emails.
Nothing new on Cloudflare beyond a queue and the existing R2 and Durable Objects.

**Security and docs:** the S3 bucket is private and written only by SES; the Worker's keys can only read and
delete there; the webhook accepts only signed notifications from one topic; mail content is data, never acted on.
When step 1 runs on the pilot, `apps/web/content/docs/privacy.md` and `security.md` say that received mail passes
through Amazon SES and briefly through S3 (deleted within seconds, 7 days at most).

**For you to do in AWS and DNS** (I'll give the exact commands when step 1 is built): create the bucket, topic,
rule set and IAM user; add the Worker secrets; add the `pilot.xstate.com` MX record; verify `pilot.xstate.com` in
SES if the parent domain's identity doesn't cover it for receiving.

**Decided (2026-11-17):** pilot on `99events.com` (no mail on it before; `pilot.xstate.com` was set up first and removed), mailbox `hello@99events.com`; a full mailbox refuses mail from step 4, not step 1.

#### Step 1 built (2026-11-17, uncommitted)

- **Code:** `mailbox/inbound.ts` (job from SES's notification, ULIDs, subject keys, Message-ID lists; tests),
  `mailbox/s3.ts` (read, quarantine, delete), `mailbox/receive.ts` (the consumer), `jobs/ses-inbound.ts` (the
  webhook), `MailboxStore.deliver` with its own folders, threading, IMAP numbering, `folderList` and `changeState`
  (`mailbox/store.ts`), `notifyDelivered` (`push/new-mail.ts`), and D1 migration 0036 (`mailboxes.backend`). For a
  mailbox with `backend = 'store'`: folders, counts, lists, threads, attachments and the change token come from the
  store; marking, pinning and moving answer `not_available` (409); mail sync and the shadow copy leave it alone;
  deleting the mailbox deletes its store.
- **Local test, end to end** (`node scripts/mail-in-fake.mjs`, which posts a notification carrying the message;
  the local webhook skips the signature check only with `SES_MODE=fake` outside production): a message reached the
  Inbox; the same SES id again stored nothing; a reply with the same subject from the same person, and a reply with
  a different subject carrying `In-Reply-To`, both joined the conversation; a spam FAIL went to Junk; a virus FAIL
  and an unknown address were dropped and logged; mail for a mailbox still on Stalwart was dropped
  (`not_on_store`); an attachment with an RFC 2231 name (`résumé.csv`) listed and downloaded with the right bytes;
  folder counts were right; the change token moved with each delivery; marking read answered 409.
- **Not tried yet:** the real S3 and SNS path, and a large message (needs AWS, below).

#### Step 1 setup

In this order. The account is 881901370832, the region us-east-2. No SES receipt rule set exists today, so this one
can be the active one.

1. **Cloudflare queues, before pushing** (a deploy fails while a queue it consumes doesn't exist):
   `npx wrangler queues create xstate-mail-in` and `npx wrangler queues create xstate-mail-in-dlq`.
2. **Push.** GitHub Actions applies migration 0036 and deploys. Receiving stays off: nothing reaches the webhook
   until the receipt rule is active.
3. **S3 bucket** `xstate-mail-inbound`: private (public access blocked), a bucket policy letting
   `ses.amazonaws.com` put objects only for this account and rule set, and a lifecycle rule deleting everything
   after 7 days.
4. **SNS topic** `xstate-mail-inbound`, with a topic policy letting SES publish for this account. Then subscribe
   `https://api.xstate.com/webhooks/ses-inbound` (HTTPS); the deployed webhook confirms it, which shows in the
   Worker's logs as `ses-inbound: confirmed subscription`.
5. **IAM user** `xstate-mail-inbound` with `s3:GetObject`, `s3:PutObject` (the quarantine copy) and
   `s3:DeleteObject` on `arn:aws:s3:::xstate-mail-inbound/*` only, and an access key, stored as Worker secrets:
   `npx wrangler secret put MAIL_INBOUND_ACCESS_KEY_ID` and `MAIL_INBOUND_SECRET_ACCESS_KEY`.
6. **Receipt rule set** `xstate` with rule `inbound`: enabled, scanning on, no recipients, one S3 action (bucket
   `xstate-mail-inbound`, prefix `inbound/`, topic `xstate-mail-inbound`); then make `xstate` the active set.
7. **The pilot:** add `pilot.xstate.com` as a domain in xstate (that registers it with SES, Easy DKIM), publish
   its DKIM records, and instead of the MX record xstate shows, publish `pilot.xstate.com MX 10
   inbound-smtp.us-east-2.amazonaws.com`. Create the pilot mailboxes, then set
   `UPDATE mailboxes SET backend = 'store' WHERE id IN (...)` before any mail is sent to them.
8. **Docs, the day mail first arrives:** `privacy.md` and `security.md` say received mail for these mailboxes
   passes through Amazon SES and briefly through S3.

Then the pilot tests listed under Testing, from an outside account (Gmail).

**Done 2026-11-17 (steps 1–6):** queues created; deployed ("Start receiving emails using SES"), migration 0036
applied; bucket `xstate-mail-inbound` (public access blocked, AES-256 at rest, 7-day lifecycle); topic
`xstate-mail-inbound`, its HTTPS subscription confirmed by the webhook itself; IAM user `xstate-mail-inbound` with
an inline policy for Get, Put and Delete on that bucket, its key stored straight into the two Worker secrets
(never printed); rule set `xstate` with rule `inbound` (enabled, scanning on, S3 action under `inbound/`,
publishing to the topic), active. One difference from the plan: the bucket and topic policies let SES in only for
this account (`AWS:SourceAccount`). A condition naming the rule (`AWS:SourceArn`) made SES's own write test fail
when the rule was created, even with a wildcard. Nothing is received until a domain's MX points at SES.

**Pilot live (2026-11-17, 19:10 UTC):** `99events.com` (DNS on Cloudflare, no mail before) with `hello@99events.com`
on the store; `pilot.xstate.com` was set up first and removed. The first message, from Gmail, sent 19:09:49 UTC,
was in R2 at 19:10:11 (`01f315d9…/raw/01M7NENBKYTTCFBCV18TESAGXS.eml`, 6,189 bytes) with SES verdicts PASS (spam,
virus, SPF), and the S3 copy was deleted, which the consumer does only after the store accepted it. `privacy.md`
and `security.md` now say received mail passes through SES and S3.

**Pilot tests (2026-11-17, 19:13 UTC),** sent through SES from `pilot-test@xstate.com`, checked in R2 and in the
web app; a second store mailbox, `team@99events.com`, was added for the two-recipient test:

| Test | Result |
|---|---|
| Reply (`In-Reply-To` the Gmail message) | Joined that conversation; the app shows both messages |
| HTML only, with entities | Stored and read correctly (`café`, `&`); the app's message frame was sized 86 px for 119 px of content, so the last line was hidden: an existing viewer issue, not receiving |
| One message to `hello@` and `team@` | One copy in each mailbox, each under its own id |
| Unknown address `nobody@99events.com` | Dropped: nothing in R2, S3 copy deleted |
| GTUBE | SES spam verdict FAIL → Junk (the app's Spam) |
| 20 MB attachment (28.7 MB message) | Delivered in about 15 s; listed as `large-test.pdf`, 20.0 MB |
| EICAR attachment | Never reached S3: SES accepted the send and no bounce came back, so it was most likely stopped on SES's sending side. The quarantine path is still untried with real mail (tried locally with a fake verdict) |

Found: the web app marks a message read when it is opened, which a store-held mailbox refuses until step 2, so
every open shows "Marking, pinning and moving mail in this mailbox is not available yet". Step 2 removes it.
The domain shows "DNS records pending" in the app because domain verification still expects Stalwart's MX.

#### Step 2: acting on mail in the store (approved and built 2026-11-18, uncommitted)

**Goal:** everything the app and `email_update_message` do to received mail works for a store-held mailbox, with
no Stalwart call: mark read and unread, pin and unpin, **archive**, move back to Inbox, Junk and Not junk, Trash and
restore, for one message or a whole conversation. That removes the "not available yet" notice the app shows today
when a message is opened (it marks it read).

**Folders.** A store-held mailbox already has its six folders, Archive included, from its first delivery
(`ensureOwned`, step 1). Archive is a real folder with its own counts and IMAP numbering, like Inbox. Stalwart
mailboxes made Archive on first use; here it always exists, so archiving never has a "no Archive folder" case.

**One store call per action** (`MailboxStore.update`), in one transaction:

- `ids` (one message, or every message of a conversation with `thread`), and any of `seen`, `pinned`, `folder`
  (`inbox`, `archive`, `junk`, `trash`; the same roles `email_update_message` takes today).
- **Flags** (`seen`, `pinned`): change the rows and their placements' `seen`; each changed message gets the next
  `modseq`, and its folder's `highest_modseq` rises.
- **Moves** (`folder`): the message leaves its folder and gets a new `uid` in the target folder (an IMAP client sees
  a move as expunge here, append there), plus a new `modseq`. As today, `thread` with `folder` moves only the
  conversation's messages that are in the same folder as the chosen one, so archiving a conversation from the Inbox
  doesn't pull its sent replies out of Sent.
- Returns how many changed; the change token (`changeState`) moves with it.
- `messages.folder` (the role lists read) and `placements` stay in step, as `setPlacements` does for shadow copies.

**`mailserver/messages.ts`:** `updateMessage` calls the store for `backend = 'store'` instead of answering 409,
then tells the organization's `LiveHub` so the mailbox reloads for whoever has it open (as mail sync does). The
operation's inputs and results don't change, so the web app, mobile app, API and MCP need nothing new.

**Trash:** messages in Trash for 30 days are deleted for good: their rows, search rows and raw copy in R2. The
store's alarm runs it once a day. (Stalwart mailboxes keep whatever Stalwart does; there is no "delete forever"
operation today, so none is added here.)

**Junk and Not junk** are moves for now. Learning from them (the mailbox's sender list, spam layer 3) is step 4.

**Not in step 2:** sending, replying and drafts (step 3: the reply box in a store-held mailbox still fails, since
the message isn't on Stalwart); search by meaning and agent triggers (step 4).

**Testing:** pure tests for which messages a conversation move touches; locally, every action on a store-held
mailbox (read, unread, pin, archive, back to Inbox, junk, not junk, trash, restore), folder counts and the change
token after each, and the 30-day Trash cleanup with a shortened time; then the same in the app on
`hello@99events.com`.

**Built:** `mailbox/actions.ts` (`planUpdate`: which messages a change touches, with tests), `MailboxStore.update`
and `purgeTrash` (new column `messages.trashed_s`), `mailbox/trash.ts` (run by the hourly cron rather than an alarm
in each store: the Worker deletes the raw copies, which needs the organization's bucket), and `updateMessage` in
`mailserver/messages.ts` calling the store and announcing the change. Tried locally end to end: read a conversation
(3), unread, pin (shows in Pinned), archive a conversation (3 to Archive, the pin kept), back to Inbox, Not junk and
Junk, Trash and restore, a missing id (404); folder counts and the change token moved each time; the hourly run
with the 30 days set to zero deleted the one message in Trash and its raw copy.

**Deployed and tried in the web app (2026-11-17, "Added step 2"),** on `hello@99events.com`: opening "Re: hello"
marked the conversation read with no notice (unread 5 → 3); Pin, then Archive moved it to Archive with both
messages and the pin; Unpin and "Move to inbox" brought it back, read and unpinned. One thing seen: right after
"Move to inbox" from Archive, the mailbox's Inbox list in the app still showed the old list until a reload; the
move itself had happened. Cause: the web app, for every mailbox, reloaded only folder counts after a move, and kept
the destination folder's cached list (from before the move) as fresh for 30 seconds. Fixed in
`apps/app/src/mail/MailPage.tsx` (a move also reloads the lists); deployed ("Fixed stale view") and tried: archive,
then "Move to inbox", then the Inbox showed the conversation at once.

#### Step 3: sending and drafts (approved and built 2026-11-18, uncommitted)

**Goal:** a store-held mailbox sends, replies, forwards and keeps drafts with no Stalwart call: the reply box in
the app, `email_send`, `email_create_draft` / `email_update_draft`, attachment uploads, and `POST /v1/emails` from a
store-held address. The operations' inputs and results don't change. (99events.com is already verified for
sending in SES: DKIM SUCCESS.)

**Building the message.** A new pure module, `mailbox/compose.ts`, builds the MIME message that Stalwart builds
today from the JMAP email: `From`, `To`, `Cc`, `Reply-To`, `Subject` (RFC 2047 when not ASCII), `Date`,
`Message-ID`, `In-Reply-To` and `References`, the API's extra headers; `text/plain`, plus `text/html` as
`multipart/alternative`, inline images as `multipart/related`, files as `multipart/mixed`; base64 for files and
non-ASCII text, lines folded at 76. Written here rather than taken from a library, so its output is ours to test:
tests build messages and read them back with our own parser (`mailbox/parse.ts`) and `locateParts`. `Bcc` is never
in the message that leaves; its addresses go only to SES as recipients, and the Sent copy keeps them, as
Stalwart's does.

**Sending.** `sendMessage` keeps its checks (access, recipients, suppression, the From address, caps and
suspension through `reserveSend`, file-type rules and the 25 MB attachment limit). For a store-held mailbox it then
calls SES's `SendEmail` with the raw message and the To, Cc and Bcc addresses as destinations, instead of JMAP
`EmailSubmission`. That needs an IAM user allowed to send, which the identity-managing user is not: a new
`xstate-mail-send` with only `ses:SendRawEmail` for this account's identities, its keys as Worker secrets
(`MAIL_SEND_ACCESS_KEY_ID`, `MAIL_SEND_SECRET_ACCESS_KEY`). A failed send releases the cap reservation, as now.
Bounces, complaints and deliveries keep arriving at `/webhooks/ses` through each domain's notification topics.

**Every send goes through SES,** including to other xstate addresses: a store-held recipient gets it back through
SES receiving, a Stalwart-held one through its MX. Delivering straight to another mailbox's store (the plan's "mail
between xstate mailboxes never leaves Cloudflare") is an optimization for later; the caps already count only outside
addresses.

**The Sent copy.** SES replaces the Message-ID (spike finding) with `<SES message id@<region>.amazonses.com>`, so
replies would not match ours. After SES accepts, the Sent copy's raw message gets that Message-ID, is stored in R2
and added to the store's Sent folder, read, in the conversation of the message it replies to (by In-Reply-To and
References, as received mail is threaded). An API send with `saveToSent: false` stores nothing. The API's delivery
log matches events by SES's message id, which the send returns, as well as by the Message-ID it chose.

**Replies and forwards** read the original from the store (`getReplySource`): its Message-ID and References for
threading, and for a forward its attachments, read from its raw copy by position. Afterwards the original is
marked answered or forwarded in the store (new flags on `messages`, shown nowhere yet, kept for IMAP later).

**Drafts** live only in the store: saving a draft writes its raw message to R2 and adds it to Drafts (a `draft`
flag), with no SES call. `draftId` works as today: sending a draft, or saving a new version, deletes the old one.
Reading a draft back gives its recipients, text, HTML and attachments from the raw copy, as any message.

**Attachment uploads** for a store-held mailbox are scanned and checked as today, then kept in the organization's
bucket at `<mailboxId>/uploads/<ULID>` with the id `upload.<ULID>` (Stalwart's blob ids are lowercase and dot-less,
so they can't collide), read back when the message is built. Uploads not sent within 24 hours are deleted by the
hourly job that empties Trash.

**Not in step 3:** calendar invitations and answers (phase 3: they still go through Stalwart's calendar, which needs
the mailbox's Stalwart account); system mail from `no-reply@xstate.com` (stays on Stalwart until xstate.com moves);
a custom MAIL FROM domain (SPF alignment; DMARC passes on DKIM alone, which SES signs); direct delivery between
store-held mailboxes; search indexing of sent mail (step 4).

**Testing:** the builder's tests (plain, HTML, inline images, attachments, non-ASCII subject and names, threading
headers, Bcc left out); locally with `SES_MODE=fake`, where sending logs the message instead of calling SES and the
Sent copy, drafts and uploads go through the real store and dev bucket; then the pilot: a reply from
`hello@99events.com` to the Gmail message (Gmail threads it, shows DKIM pass for 99events.com), Gmail's answer
arriving in the same conversation, a draft saved, edited and sent, a forward with the 20 MB attachment, and an API
send.

**For you in AWS:** none until it's built; then I create the `xstate-mail-send` IAM user and its secrets, as for
receiving, with your go-ahead.

**Built:** `mailbox/compose.ts` (the builder, with tests that read every message back with postal-mime and
`locateParts`; it writes into one buffer of the exact size so 25 MB of files needs about 60 MB), `mailbox/ses-send.ts`
(SES v2 `SendEmail` with the raw message, the request body written straight from the bytes; `SES_MODE` fake logs
instead), `mailbox/outbound.ts` (sending, drafts and uploads for store-held mailboxes), store methods
`replySource`, `markOriginal`, `draft`, `removeDraft` and Sent and Drafts in `deliver` (new columns `answered`,
`forwarded`, `is_draft`), `checkOutgoing` split out of `compose` in `mailserver/messages.ts` so both paths make the
same checks, and unsent uploads deleted after 24 hours by the hourly job (their ULID says when). The Sent copy
replaces our Message-ID with `<SES id>@us-east-2.amazonses.com` and adds the Bcc line; whether that is exactly the
Message-ID recipients see is checked on the pilot.

**Local test, end to end** with `SES_MODE=fake`: an upload (`upload.<ULID>`), a draft with a Bcc and that file, the
draft edited (the old one gone, one draft left), the draft sent as a reply (it joined the 3-message conversation;
the Sent copy has the Bcc, the file and the SES Message-ID; SES was given To and Bcc separately; Drafts empty), and
a forward that carried the original's `résumé.csv`.

**Sending set up (2026-11-18):** IAM user `xstate-mail-send` with an inline policy allowing only `ses:SendRawEmail`
and `ses:SendEmail` on this account's identities in us-east-2; its key stored straight into the Worker secrets
`MAIL_SEND_ACCESS_KEY_ID` and `MAIL_SEND_SECRET_ACCESS_KEY` (never printed).

**Pilot sending (2026-11-17, "Implemented step 3"; the first deploy hit a Cloudflare API error updating a queue
consumer, code 10013, and the re-run went through):**

| Test | Result |
|---|---|
| Draft from `hello@` to Gmail: saved, edited, sent | Drafts empty after; Sent copy in R2 |
| `hello@` → `team@` (out through SES, back in through SES receiving) | The Sent copy's Message-ID and the received one are the same `<…-000000@us-east-2.amazonses.com>`, so SES does replace ours and the Sent copy has its form right; `dkim=pass header.i=@99events.com`, `dmarc=pass` |
| Forward of the 20 MB attachment to `team@` | Sent copy 28.7 MB at 19:51:56, received by `team@` at 19:52:11; no memory trouble |

Found and fixed (not yet deployed): with `FromEmailAddress` set, SES rewrote the From header to the bare address, so
recipients saw `hello@99events.com` without "99events". The request now leaves it out, and SES sends from the
message's own From header; tried directly with the AWS CLI: `From: 99events <hello@99events.com>` arrived intact,
DKIM and DMARC still passing.

The From fix deployed ("Made some minor fix"). Then the Gmail reply to the draft-test message ("Hello, how are you
doing?", 00:55 local) joined its conversation in `hello@99events.com`, matched through SES's Message-ID; a reply
written in the app's reply box went back to Gmail ("Reply sent") and the conversation shows all three in order.
Step 3 works end to end on real mail.

#### Step 4a: new-mail events for search, attachments and agents (approved and built 2026-11-18, uncommitted)

**Goal:** mail in a store-held mailbox reaches everything that reads Stalwart mail today: search by meaning
(`email_search` and the app's search), attachment records (`files`, so Storage's mail views, `storage_*` tools and
attachment search work), and agents' email triggers. Today `jobs/mail-sync.ts` does all three by walking Stalwart's
change log, which store-held mailboxes don't have, so none of their mail is indexed, filed or seen by agents.

**One event per change, on a new queue.** `xstate-mail-events` (binding `MAIL_EVENTS`, with a dead-letter queue,
as the plan's AI agents section names it). The store's writers queue an event after the change is stored:

| Event | Queued by | Meaning |
|---|---|---|
| `new` (mailbox, message ids, `in` or `out`) | `receive.ts` after a delivery; `outbound.ts` after a Sent copy (not drafts) | A message to file, index and, if received, offer to agents |
| `moved` (mailbox, message ids) | `updateMessage` for store-held mailboxes | Search documents record the folder; nothing is re-embedded |
| `removed` (mailbox, message ids) | the Trash purge, a replaced or sent draft | Its files and search documents go |

A separate queue, not more work in the receiving consumer: delivery stays fast and never retries because the model
or Vectorize failed, and each consumer step retries on its own. Every step is safe to repeat, as mail sync's are.

**The consumer** (`mailbox/events.ts`), for `new`:

1. **Attachments to `files`.** For each file part the store recorded (its position in the raw copy), as mail sync
   does for a Stalwart attachment: claim a `files` row first (`part_id` is the part's start, so a retry finds it),
   apply the file-type rules (blocked: marked, never copied), copy the part's decoded bytes from the raw copy (a
   range read) to the usual file key, record size and hash, and queue it for search. Inline images under 20 KB are
   skipped, as now. `source` is `received` or `sent`.
2. **Search.** The message is queued for search as today (`enqueueEmails`); `indexEmails` reads a store-held
   mailbox's message from its raw copy (our parser, footer removed) and its folder from the store, instead of
   asking Stalwart. Same documents (`email:<mailbox>:<id>`), so `email_search` needs nothing new.
3. **Agents** (received mail in the Inbox only, as now). For each email trigger on the mailbox, the same rules,
   loop guard (Auto-Submitted, Precedence, list headers, no-reply senders, the mailbox's own mail) and AI filter
   decide, with the message read from its raw copy instead of Stalwart's `getTriggerEmails`. A trigger fires once
   per message: the agent's store records the message id before starting the run, so a retried event doesn't start
   a second one. The Stalwart change-log cursor isn't used for these mailboxes.

`moved` updates the search documents' folder (from the store); `removed` marks the messages' `files` rows deleted
(the hourly purge removes their objects and vectors, as for Stalwart mail) and removes their search documents.

**Mail already there.** The pilot's existing messages (a few dozen) were never filed or indexed. The hourly search
job queues a `new` event for every message of a store-held mailbox once (a flag in the store's meta), then never
again.

**Attachments are still copied, not read in place.** The plan's target is one copy, read by position from the raw
message. Storage's downloads (presigned URLs) and "save to Storage" (an object copy) both work on a file's own R2
object, and neither can point at a range of another object without rework. For now a store-held mailbox keeps a
copy per attachment, as Stalwart mailboxes do today; reading in place comes with phase 4, when copied mail's
separate copies are removed anyway.

**Not in 4a:** virus scanning of received attachments (4c, which hooks into the same event), spam layers (4b), the
delivery log (4d), calendar invitations (phase 3).

**Testing:** pure tests for the trigger email built from a parsed message (loop-guard headers kept); locally, a fake
delivery producing `files` rows, search documents in the dev index, and a trigger event (an agent on the test
mailbox, loop guard and rules); then the pilot: `email_search` finds pilot mail and its attachments, the 20 MB PDF
shows in Storage's mail attachments, moving a message updates its search folder, and an agent on
`hello@99events.com` fires once for a new message from Gmail.

**Built:** `mailbox/events.ts` (the queue job, the consumer, the hourly catch-up), `mailbox/trigger-email.ts` (a
store-held message in the shape agents' triggers read, with tests), `offerStoredEmail` in `agents/email-trigger.ts`
with a `trigger_emails` claim table in each agent's store, `indexEmails` and `refreshEmailFolders` reading store-held
mail from the raw copies and the store, producers in `receive.ts`, `outbound.ts`, `updateMessage` and the Trash
purge, and the parser keeping each header's first value. Old mail caught up is filed and indexed but not offered to
agents (`offer: false`), which would otherwise answer weeks-old mail.

**Found while testing: Vectorize ids over 64 bytes.** A passage's id was `<doc>:<n>`; a store-held message's doc is
`email:<mailbox uuid>:<26-character ULID>`, 71 bytes with the passage number, and Vectorize refuses ids over 64. No
store-held mail could have been indexed. Fixed in `search/vector-id.ts`: ids that fit keep the old form (every
vector already stored stays valid), longer ones become `h:<128-bit hash of the doc>:<n>`; the doc id in metadata and
D1 is unchanged, so results and deletes work as before. Tests included.

**Local test, end to end** (the local agent "Inbox Helper" on `dev@acme.test`, switched to the store): a customer
email with a PDF was filed (`files` row ready, `part_id` `store:<start>`), indexed, and offered to the agent, which
fired and replied through the store's sending path (fake SES), its Sent copy then indexed in Sent; a mailing-list
email was skipped by the loop guard; archiving moved the search document's folder to `archive`; Trash with the purge
marked the file deleted and removed the document; the hourly catch-up queued the mailbox's four earlier messages
once, filed nothing twice and offered nothing to the agent.

**Deployed (2026-11-17, "Adde some more fixes"; queues created first).** On the pilot: a message with a PDF sent
through SES at 20:12:42 UTC was stored at 20:12:53, its attachment filed as `gala-budget.pdf` (`files` ready,
`received`, `part_id` `store:3959`) at 20:12:59, and both the email (Inbox) and the PDF indexed in Vectorize; the app's
word search finds it by "catering". The catch-up of the pilot's older mail runs with the next hourly cron. Not yet
tried on the pilot: an agent on a store-held mailbox (tried locally).

#### Step 4b: spam layers 2 and 3 (approved and built 2026-11-18, uncommitted)

**Goal:** decide Inbox or Junk for store-held mailboxes with more than SES's pass/fail ([Spam](#spam), layers 2 and
3), and say why. Today the receiving consumer sends a message to Junk only when SES's spam verdict is FAIL. Rspamd
(layer 4) and a model (layer 5) stay out until the pilot's numbers show they're needed.

**One pure function decides** (`mailbox/spam.ts`, with tests): given the message's authentication results, its
headers and what the mailbox and organization know about the sender, it returns `inbox` or `junk` and the reasons.
The receiving consumer gathers the inputs, calls it, and delivers accordingly; the reasons are kept with the message
(next to SES's verdicts) for the delivery log (4d) and for showing "why is this in Junk" later.

**Inputs**

- **SES:** the spam, SPF, DKIM and DMARC verdicts already in the job, plus the sender domain's DMARC policy
  (`receipt.dmarcPolicy`: `none`, `quarantine` or `reject`, sent when DMARC fails), which the job doesn't keep yet.
- **The message:** From address and display name, Reply-To.
- **The mailbox** (one call to its store): whether it has written to this address before (a small `correspondents`
  table the store keeps from its Sent copies: address and when last written to), and the mailbox's own verdict on
  the sender if it has one (below).
- **The organization:** whether the sender is one of its contacts (the audience store: a new internal
  `knows(addresses)` lookup, no viewer needed), and the display names of its members and mailboxes (D1, for
  impersonation).

**Order of decisions** (the first that applies wins; a virus never reaches here):

1. **The mailbox's own verdict on the sender:** a sender someone marked "Not junk" goes to Inbox; one marked "Junk"
   goes to Junk.
2. **Failed authentication of a domain that asks for it:** DMARC FAIL with the sender's policy `reject` or
   `quarantine` goes to Junk, even for someone the mailbox knows. That is what a forged message from a known sender
   looks like, so the trust in step 3 must not rescue it.
3. **Someone the mailbox knows** (written to before, or an organization contact), with DMARC passing or not
   failing: Inbox. This is layer 3: a reply from someone you've emailed should almost never be Junk.
4. **Otherwise, a score**, Junk at 5 or more:

| Signal | Points |
|---|---|
| SES spam verdict FAIL | 5 |
| From's display name is a member's or mailbox's name in this organization, from an address outside its domains | 5 |
| SPF and DKIM both FAIL | 3 |
| DMARC FAIL with policy `none` | 2 |
| Reply-To on a different domain from From | 1 |

So SES's FAIL alone still means Junk, as today; impersonating a colleague's name is Junk on its own; failed
authentication or a mismatched Reply-To only tips mail that has other problems.

**Learning from people:** "Mark as junk" (a move from Inbox to Junk) records Junk for that sender address in the
mailbox's store, and "Not junk" (Junk to Inbox) records Not junk, replacing any earlier one. Step 1 of the order
then applies to their next message. Per mailbox, not organization-wide; an organization blocklist and allowlist,
with somewhere in Settings to manage them, come later.

**Where the store changes:** `correspondents` (address, last written) filled by each Sent copy, `sender_verdicts`
(address, junk or not, when), both small; `update` records a verdict when a message moves between Inbox and Junk;
`deliver` keeps the reasons in `verdicts`.

**Measuring.** Each decision is logged (`mail-in` already logs per message: the folder, now with the reasons), so
the pilot shows what reaches Junk and why, and what gets through. That decides whether Rspamd is worth adding.

**Not in 4b:** Rspamd and blocklists (layer 4), a model (layer 5), bouncing or rejecting (we never bounce: see
[Proposed decisions](#proposed-decisions)), showing the reason in the app, an organization-wide list.

**Testing:** the decision function's tests (each rule, the order, the known-sender exception for DMARC failure);
locally, fake deliveries for each case (spam FAIL, DMARC reject failing, a colleague's name from Gmail, a reply from
someone the mailbox wrote to, "Junk" then the next message from that sender); on the pilot, the GTUBE test again and
a "Not junk" followed by a second message from the same sender.

**Built:** `mailbox/spam.ts` (`decideSpam`, with tests for each rule and the order), the DMARC policy kept from SES's
notification (`inbound.ts`), `correspondents` and `sender_verdicts` in each store (the first filled once from Sent mail
already there, then by every Sent copy, Bcc included; the second by moves between Inbox and Junk), the audience
store's `knows` (contacts only: leads and identified users come from forms anyone can fill in), the organization's
domains and display names from D1 (`db/organizations.ts` `identity`), and the decision in `receive.ts`, its score and
reasons kept in the message's verdicts and logged on `mail-in`. `scripts/mail-in-fake.mjs` gained `--from-name`,
`--reply-to` and `--dmarc-fail`.

**Local test** (`dev@acme.test` on the store, its agent's trigger paused so no model ran):

| Case | Folder | Reasons |
|---|---|---|
| New sender, clean | Inbox | none |
| New sender, SES spam | Junk | SES spam check failed (+5) |
| SES spam from someone the mailbox wrote to | Inbox | Known sender |
| Known sender, DMARC fails, policy reject | Junk | Failed DMARC; example.org asks for reject |
| "Dev Tester" (a member's name) from Gmail | Junk | Uses the name "Dev Tester" from outside the organization (+5) |
| DMARC fails with policy none, Reply-To elsewhere | Inbox | score 3 |
| Sender moved to Junk, then writes again | Junk | Marked junk before |
| Same sender moved back, then SES spam | Inbox | Marked not junk before |

Found while designing: a member writing from their personal address under their own name (the pilot's Gmail tests,
"Asif Khan") would look like impersonation; the known-sender rule lets them through once the mailbox has written to
that address, which is why existing Sent mail fills `correspondents` too.

**Deployed (2026-11-18, "Implemented spamming support").** On the pilot, a GTUBE message sent from the app by
`team@99events.com` to `hello@99events.com` arrived with `X-SES-Spam-Verdict: FAIL` and went to the Inbox, because
`hello@` had written to `team@` the day before (the known-sender rule, filled from existing Sent mail). The GTUBE
message of the day before, from `pilot-test@xstate.com`, which `hello@` never wrote to, is in Spam.

**Gap found:** neither the web app nor the mobile app has a "Mark as junk" action; mail reaches Junk by hand only through
the API, MCP or agents (`email_update_message` with `folder: junk`). "Move to inbox" from Spam does record "Not
junk". Fixed in the web app (2026-11-18, uncommitted): the reader has **Junk** for a conversation in Inbox or
Archive and **Not junk** in Spam (`apps/app/src/mail/Reader.tsx`), for every mailbox; tried in demo mode at 1280 px
(one toolbar line: Pin, Archive, Junk, Mark read). The mobile app still has neither.

#### Step 4c: virus scanning of received attachments (approved and built 2026-11-18, uncommitted)

**Goal:** every attachment that reaches a store-held mailbox is scanned by ClamAV before anyone can download it, as
[Attachments and viruses](#attachments-and-viruses) planned. Today SES's coarse verdict is the only check for these
mailboxes: Stalwart mailboxes get ClamAV at SMTP time through the scanner's MTA hook on deepo, which store-held mail
never passes. The scanner itself stays where it is (`apps/scanner`, `SCAN_URL`), until Stalwart is retired.

**When:** in the new-mail event (4a), before filing. For each file part of a received message, the consumer sends
its decoded bytes to the scanner (`security/scan.ts`, `scanFile`, the same call composer uploads use), then records
the result. Sent mail isn't scanned again: its attachments were scanned when uploaded.

**Each attachment's state**, kept in the store's `attachments` table (a new `scan` column) so the reader and downloads
see it without D1:

| State | Meaning | Download | In the reader |
|---|---|---|---|
| `scanning` | Delivered, not scanned yet (seconds, usually) | Refused, 409 "being checked; try again in a moment" | Blocked, "Being checked for viruses" |
| `clean` | ClamAV found nothing | Allowed (file-type rules still apply) | As now |
| `infected` | ClamAV found a virus | Refused for good, 403 | Blocked, "Contains a virus (<name>)" |
| `unscannable` | The scanner couldn't take it after every retry (down, or the file over its size limit) | Allowed with a warning | Warning, as the rules already do for archives they can't open |

`deliver` sets `scanning` on every file part of received mail, so nothing is downloadable before it's checked; mail
the mailbox sends is `clean` at once. The reader shows the state through the attachment's existing `safety` (two new
codes, `scanning` and `virus`), which the web app already shows as blocked or warned, so it needs no change. A scan
result bumps the store's change token, so the app reloads and the attachment becomes downloadable on its own.

**An infected attachment:** the message moves to Junk (without counting as a "Junk" verdict on the sender), its `files`
row is marked blocked and never copied, and the result is logged with the virus name. The rest of the message stays
readable.

**The scanner down:** the event retries with backoff (the queue's own retries, about half an hour in all); after the
last one the attachment becomes `unscannable`, so mail is never held back for hours by a broken scanner. Files over
the scanner's size limit become `unscannable` at once.

**Modes,** as `SCAN_MODE` sets them for uploads today: `log` scans and logs but marks every attachment `clean`
(nothing refused; the first days on the pilot); `live` enforces the table above; `fake` (local) flags only EICAR;
`off` marks everything `clean` without scanning. Production is on `log` now; the change to `live` is a one-line
config change, and also makes composer and Storage uploads refuse viruses (the rollout the scanner's README
describes). Turning `live` on is the user's call after the pilot (the earlier log-only week is over; the user chose not
to review its log).

**Mail already there:** the pilot's existing attachments are scanned once by the 4a catch-up path (a `scan` event for
messages with attachments and no scan state), so they don't stay unknown.

**Not in 4c:** moving ClamAV off deepo (phase 5), scanning inside attached emails beyond what ClamAV does itself,
rescanning old files when signatures update.

**Testing:** pure tests for the state rules (each mode, scanner down, size limit); locally with `SCAN_MODE=fake`, an
EICAR attachment (infected: message to Junk, download 403, file blocked), a clean one (downloadable after the scan, 409
before), and the scanner unreachable in `live` (retries, then `unscannable`); on the pilot, in `log`, a real attachment
reaching `clean` through the real scanner on deepo.

**Built:** `mailbox/scan-state.ts` (the states, what each means for the reader and downloads, with tests), a `scan`
and `virus` column on the store's `attachments` (`scanning` on received mail at delivery, none on mail the mailbox
writes or copies from Stalwart, which are never gated), `setScan`, `unscanned`, the scan in the new-mail event before
filing (`scanAttachments` in `events.ts`: `security/scan.ts` `scanFile`, a retry while the scanner is unreachable, an
infected message moved to Junk as a system move that doesn't teach the spam filter, and agents never offered it), a
`scan` event for the catch-up, `storeBlob` refusing a file that is `scanning` (409) or `infected` (403) for every path
(download, attaching to a reply, reading an invitation), forwards skipping an infected original and waiting for one
still being checked, and three new safety codes (`scanning`, `virus`, `unscanned`) the web app already shows.

**Found while testing:** a scan event that never runs (lost when enqueueing, or here a local restart) would leave its
attachments `scanning`, so blocked, for good. The hourly catch-up now also rescans attachments still `scanning` an
hour after delivery.

**Local test:** with `SCAN_MODE=live` and no scanner, a clean file stayed `scanning` (reader "Being checked for
viruses", download 409) and the event was retried; with `fake`, a clean file was `ok` and downloadable, and an EICAR
file put its message in Junk, showed "Contains a virus (Eicar-Test-Signature)", refused the download
(`attachment_blocked`) and left its `files` row blocked (`blocked:virus`); the hourly run rescanned the stuck clean file,
which then downloaded.

**Docs:** `security.md` will say received attachments are scanned by ClamAV only once `SCAN_MODE` is `live` in
production (today `log`), so the public page never claims more than is enforced.

**Deployed (2026-11-18, "Added virus checking").** On the pilot, "Spring gala budget" forwarded from `hello@` to
`team@` (out through SES, back in through SES receiving) arrived with `gala-budget.pdf` downloadable; deepo's nginx log
shows the Worker's `POST /_scan/scan?name=gala-budget.pdf` answered 200 with `{"infected":false}` at 05:20:45 UTC, so
the real ClamAV checked it. Production stays on `SCAN_MODE=log` until the user switches it to `live`.

#### Step 4d: the delivery log (built 2026-11-18, uncommitted)

What support reads to answer "where is my email" for store-held mailboxes. Ids, addresses and outcomes only, never
content; everything kept `DELIVERY_LOG_DAYS` (30).

- **Per mailbox, in its store:** table `delivery_log` (`at_s`, `step`, `email_id`, `ses_id`, `address`, `detail` JSON).
  Steps:
  - `delivered`: folder, To, envelope sender, size, SES verdicts, spam score and reasons; `address` is the From.
  - `refused`: SES found a virus (one line in each mailbox it was for).
  - `scanned`: scan mode, each attachment's state, and whether it moved the message to Junk.
  - `sent`: one line per recipient (`as` to/cc/bcc, recipient count, size, sent through the API or not).
  - `ses_delivered`, `bounced`, `complained`: SES's notifications for a store-held sender, one line per recipient.
- **Drops, in D1** (`mail_drops`, migration 0037): received mail that reached no mailbox (`unknown_address`, or
  `not_on_store` for an address whose mailbox isn't held). Organization from the address's domain; id
  `<sesId>:<recipient>`, so a redelivered notification isn't counted twice.
- **Reading it:** `email_get_delivery_log` (`GET /v1/email/orgs/:organizationId/delivery-log`, MCP read-only),
  owners and admins only. Filters: `mailboxId` (that mailbox's lines, without drops) and `query`, which is a message
  id (also finds the lines logged under its SES id), an SES id, or part of an address. Merged newest first, `limit`
  1–200 (default 50).
- **Purging:** the hourly run deletes store lines older than 30 days in the same pass as Trash
  (`purgeHeldTrash`), and D1 drops older than 30 days.
- **Not built:** a screen for it in the app. The MCP tool and the API are enough for support now.

**Local test:** a clean message (`delivered`, inbox), a message to an unknown address (`dropped`,
`unknown_address`), a virus (`refused`, by SES), an attachment (`delivered`, then `scanned` in fake mode), and a send
to two recipients (two `sent` lines). Query by recipient, by message id (both `sent` lines) and by unknown address
(the drop) each found the right lines. A member who isn't an admin got 403. The hourly run deleted a seeded 2-month-old
drop and kept the new one.

**Found while testing:** the first version logged one `sent` line with the recipients in `detail`, so a search by
recipient missed it. Now one line per recipient.

**Deploy:** migration 0037 runs in CI; no new queues, secrets or AWS changes.

**Deployed (2026-11-18, "Added logging").** On the pilot, a send from `hello@` to `team@` and `nobody-4d@` logged two
`sent` lines, `delivered` in `team@`'s inbox and `dropped` (`unknown_address`). No `ses_delivered` line came for two
sends to Gmail, although SES's notifications reached `/webhooks/ses`.

**Found on the pilot:** since step 3 stopped passing FromEmailAddress (to keep the display name), SES reports
`mail.source` as the whole From header (`99events <hello@99events.com>`). The webhook looked that up as an address,
found no mailbox, and so never counted deliveries, bounces or complaints against store-held senders (their rates and
automatic suspension included; `delivery_counts` stops on 2026-11-17). Fixed with `sourceAddress` in
`mailbox/inbound.ts`, used by the webhook and for received mail. Deployed 2026-11-18 ("Fixed minor bugs"): a send
from `hello@` to Gmail at 05:51:36 UTC logged `ses_delivered` a second later (found by its message id with the `sent`
line), and `delivery_counts` has a row for 2026-11-18. Deliveries between the two fixes were never counted.

#### Mail from Stalwart mailboxes to store-held ones (approved and built 2026-11-18, uncommitted)

**Problem** (found in the 3c pilot test): Stalwart still has 99events.com and the `hello@`/`team@` accounts, so mail
and invitations from a Stalwart mailbox (asif@xstate.com) to a pilot address are delivered inside Stalwart, into
accounts nobody reads, and never reach SES or the store. Every domain moved in phase 4 would have the same gap.

**What was tried on the local Stalwart (2026-11-18):**

| Change | Plain email | Invitation |
|---|---|---|
| Domain disabled (`x:Domain enable: false`) | still delivered locally | — |
| Account deleted, domain kept | not delivered, not queued, no bounce: lost | — |
| Routing rule for the domain (below), after `ReloadSettings` | queued for relay, not delivered locally | queued for relay, not filed in the local calendar |

**Proposed fix: a routing rule, not deletion.** Stalwart decides where queued mail goes with
`x:MtaOutboundStrategy` (`route` and `schedule`), today "local domains → `'local'`, everything else → `'ses'`". A
first rule ahead of that sends store-held domains out like any outside domain:

```
route:    if rcpt_domain == '99events.com' || …  then 'ses'      (then: is_local_domain → 'local'; else 'ses')
schedule: if rcpt_domain == '99events.com' || …  then 'remote'   (then the existing local / dsn / report / remote)
```

Through SES, the message reaches the domain's MX (SES receiving) and the store, exactly as mail from Gmail does,
with SES's checks and the delivery log. Why this and not deleting the domain from Stalwart:
- **Nothing is deleted,** and it is undone by removing the rule. The old accounts keep whatever they hold.
- **The DNS records page keeps working.** `email_get_dns_records` and `verifyDomain` build the records from
  Stalwart's zone file for the domain; deleting the domain would break both until phase 5 rewrites them.
- Deleting only the accounts loses mail silently (table above).

**Kept in step with D1 by the API, not by hand:**
- `mailserver/stalwart/routing.ts`: reads the strategy, removes our own rule (recognised by a marker comment in the
  expression), adds the current one built from D1 (every domain whose mailboxes are all `backend = 'store'`), writes
  it and runs `ReloadSettings`. Run when a mailbox's backend changes (phase 4's switch) and by the hourly job if the
  rule on Stalwart doesn't match D1, so a hand edit or a Stalwart reinstall can't leave it stale.
- A domain with mailboxes on both sides is not supported: domains move whole (phase 4). Until then such a domain
  keeps local delivery and the hourly job logs it.
- Production's previous `route`/`schedule` values are recorded here before the first change, for rollback.

**Mail already delivered into the old accounts** (at least today's "Internal routing test" and the invitation from
asif@xstate.com): a one-time sweep per store-held mailbox lists messages its Stalwart account received after the
mailbox switched to the store, and delivers each into the store as received mail (Inbox, through the normal receive
path, so search, files, agents and the calendar rules see it; marked in the delivery log as `swept_from_stalwart`).
Calendar items Stalwart filed directly into the old account's calendar since the switch are copied the same way.
The sweep is part of every phase 4 switch too, run after the rule is in place.

**Not affected:** mail from outside (MX already points at SES); mail from store-held mailboxes to Stalwart ones
(sent through SES to their MX, which is Stalwart); Stalwart users' own IMAP/SMTP use.

**Tests:**
- Pure: building and replacing the rule (none before, ours before, someone else's rules kept, no store-held
  domains → our rule removed).
- Locally: the experiment above, but through `routing.ts`: plain email and invitation from dev@acme.test to a
  store-held local domain end up queued for relay, not local; removing the domain from the set restores local
  delivery; the sweep moves a message from a Stalwart account into the store once (a second run moves nothing).
- On production: record the current strategy, apply the rule for 99events.com, then from asif@xstate.com send a
  plain email and an invitation to `hello@`; both arrive through SES (delivery log `delivered` and `calendar`
  lines), and the sweep brings in today's two stray items.

**Built:**
- `mailserver/stalwart/routing-rule.ts` (pure, tested): `withStoreRule` puts our rule first, sending the domains
  wherever the expression sends outside mail (its own `else`: `'ses'` in production, the dead-end `'nowhere'`
  locally), and recognises its own rule by the always-true term `!is_empty('xstate:store-held')`; other rules are
  kept in order; names that aren't plain domain names are refused. `storeRuleDomains` reads ours back.
- `db/domains.ts` `storeHeldNames`: domains with at least one address on a store-held mailbox, split into held
  (all of its addresses, aliases included, on the store) and mixed.
- `mailserver/stalwart/routing.ts` `syncStoreRouting`: compares, and only on a difference writes both expressions
  and runs `ReloadSettings`. The log line `stalwart-routing` carries the previous expressions, so production's
  values before the first change are in the Worker logs for rollback. Mixed domains are logged and keep local
  delivery.
- `mailbox/stalwart-sweep.ts` `sweepHeld`: per store-held mailbox with a Stalwart account, messages in received
  folders (Inbox, Junk, Archive, custom) after the remembered point (`stalwart_swept_until` in the store, from
  2026-11-01 the first time), skipping Message-IDs the store has, delivered through `receive.ts` `deliverSwept`
  (verdicts GRAY, `sweptFromStalwart` in the delivery log, `sesId` `stalwart.<account>.<id>` so a repeat is a
  duplicate). Then `sweepStalwartCalendar` copies events whose UID the store doesn't have.
- Hourly job: routing sync first, then the sweep.

**Found while testing:** the store added its `scan`/`virus` columns before creating the `attachments` table, so a
brand-new store's first activation created the table without them and its first delivery failed (the queue's retry
then worked). The columns are now in the `CREATE` too.

**Local test:**
- priya's domain (conp3-8329.test) has other mailboxes on Stalwart: reported as mixed, no rule (as intended).
- dev@acme.test (the only address on acme.test) put on the store: the hourly run added the rule for acme.test and
  logged the previous expressions; a plain email and an invitation from priya (Stalwart) to dev were queued for
  relay (queue `remote`), not delivered to dev's old account or calendar; the sweep moved the 53 messages in dev's old
  Stalwart Inbox into the store (none were there: this mailbox never had a shadow copy). A second run moved nothing
  and left the rule alone. dev back on Stalwart: the next run removed the rule and the strategy was exactly as before.
- 4 new unit tests; 436 tests pass.

**Deployed (2026-11-18, commit 46a283e) and working.** The 08:00 UTC hourly run swept `hello@`'s old Stalwart account:
the two stray messages from asif@xstate.com (the "Internal routing test" email and the invitation email) were delivered
into the store (`sweptFromStalwart`), and the event Stalwart had filed was copied into the store calendar; `team@` had
nothing. Then, from asif@xstate.com, a new email and a new invitation to `hello@` went out through SES (envelope sender
`…@us-east-2.amazonses.com`) and were delivered to the store within seconds; the invitation was proven by DMARC and
added to `hello@`'s calendar on arrival (same organization). Deleting the event in asif@xstate.com's calendar sent a
cancellation the same way, and `hello@`'s copy became cancelled. `ReloadSettings` was enough: no Stalwart restart.

Before that, the plan for this step was: the first hourly run adds the rule for 99events.com and sweeps `hello@` and
`team@` (expected: today's "Internal routing test" and the invitation from asif@xstate.com, plus anything else
Stalwart kept). The docs say outbound-strategy changes needed a restart in production on 2026-11-05;
`ReloadSettings` was enough locally, so the test after the push checks it: from asif@xstate.com, a plain email and
an invitation to `hello@` must arrive through SES. If they don't, Stalwart needs a restart (`systemctl restart
stalwart` on deepo).

#### Our own MX name (discussed 2026-11-17, deferred)

Customer domains publish SES's own hostname for now (`MX 10 inbound-smtp.us-east-2.amazonaws.com`), the user's
choice. The idea, kept for later: a host we own (such as `incoming.xstate.io`) whose A records copy SES's inbound
addresses, kept in step by a Worker cron, so receiving could move off SES or to another region without customers
changing their MX. Not a CNAME: an MX must name a host with its own addresses (RFC 2181). On 2026-11-17 SES's name
answered with the same 3 IPv4 addresses on every lookup (TTL 60, no IPv6), so copying them is simple. What to be
careful about:

- **The DNS token.** Cloudflare tokens limit to a zone, not a record, so a token for `xstate.io` that leaked could
  redirect every customer's mail and change every other record there. Better: the MX host in a zone of its own (a
  domain bought only for this, on auto-renew, since letting it lapse stops all incoming mail).
- **Not supported by AWS.** SES accepts mail on its addresses whatever name the sender looked up, but AWS documents
  pointing MX at its hostname. If AWS changes the addresses, some senders reach a dead one for up to about 20
  minutes (15-minute job, 5-minute TTL); senders retry, so mail is late, not lost.
- **A stopped job** leaves the records as they were: safe unless SES's addresses change meanwhile. Log every run
  and warn in the hourly check when our records differ from SES's.
- **TLS.** Senders get SES's certificate for an amazonaws.com name: opportunistic TLS still encrypts, but customer
  domains can't use MTA-STS in enforce mode or DANE until we run our own MX with a certificate for the name.
- **What assumes `mx.xstate.io` today:** the domain setup records, domain verification's MX check, and the Domain
  Connect template (onboarded by Cloudflare, so a change means resubmitting it).
- It moves the switch from customers to us; it doesn't make leaving SES free.

### 3. Calendars

Events, invitations in and out, free/busy, FullCalendar against the new API, the Google Workspace imports writing
to the store.

**Design (written 2026-11-18, for review; nothing built).**

#### Why before switching domains

Today every mailbox's calendar is in Stalwart, the pilot's included (`mailserver/calendar.ts` calls JMAP with the
mailbox's `stalwart_id`). Stalwart also does the scheduling: it emails invitations itself and files invitations and
replies that reach it by mail. Once a domain's MX points at SES, that mail lands in the store instead, so:

- guests' answers to our invitations no longer update the organizer's event;
- updates and cancellations from outside organizers no longer change the copy in the calendar;
- invitations between two xstate mailboxes are no longer filed automatically.

The pilot has this gap already; it shows up only because nobody on it uses the calendar. Phase 3 moves calendars and
scheduling into the store so phase 4 can switch real domains.

#### Decisions proposed

- **Events are stored as JSCalendar (RFC 8984), not raw iCalendar.** This changes the earlier plan ("the full
  iCalendar data"). Everything we have already speaks JSCalendar: Stalwart returns it, so the copy is a straight move;
  `mailserver/calendar-events.ts` maps it to and from the API's flat event (with its tests, overrides and repeat
  rules); the Google import (`migration/calendar-rules.ts`) produces it. iCalendar is only needed at the edges,
  for invitation emails in and out. Storing iCalendar would mean rewriting all of that for no gain.
- **One library for iCalendar: ical.js** (Mozilla, used by Thunderbird; MPL-2.0, which is fine to use unmodified;
  2.2.1; pure JavaScript, nothing Node-only). It parses `.ics` and builds it, and its recurrence iterator expands
  repeat rules. We convert JSCalendar ⇄ iCalendar ourselves in a pure module with tests, the way
  `calendar-events.ts` does for JMAP. Time zones: events keep IANA names and local times (as now); occurrences are
  expanded in local time and turned into UTC with the existing `zonedToUtc`, so daylight saving is handled by the
  runtime's own time-zone data. Outlook's Windows zone names ("Pacific Standard Time") are mapped with a small table.
- **Calendars move with the mail.** No separate switch: a mailbox whose `backend` is `store` has its calendars in
  the store. Its Stalwart calendars are copied when it switches (for the pilot, once now), then left alone. One
  state per mailbox is easier to reason about than two.
- **Scheduling goes through SES like any mail.** Invitations, updates, cancellations and answers are emails with a
  `text/calendar` part, sent by `mailbox/outbound.ts`. Invitations between two xstate mailboxes travel the same way
  and are filed on arrival (below), so there is one path, not a shortcut for internal guests.
- **The API stays the same.** The `calendar_*` operations, routes and the flat event keep their shapes, so the web
  app (FullCalendar), the mobile app and the MCP tools need no change. The service picks Stalwart or the store per
  mailbox, as mail already does.

#### Storage in the mailbox object

- `calendars`: id, name, color, is_default, sort_order. Work and Personal are created on first use, as now.
- `events`: id, calendar_id, uid, `json` (the JSCalendar event: title, times, time zone, repeat rule, per-occurrence
  overrides, participants, sequence), and columns for finding them: `start_utc`, `end_utc` (a single event's real
  times; for a series, its first start and its last end, or null when it never ends), `recurring`, `organizer`,
  `my_status`, `updated_at`. Index on uid and on the time columns.
- **Listing a range:** single events by the time columns; series that overlap the range are expanded with ical.js
  and their overrides applied (a moved occurrence, a changed one, or a deleted one). The existing 365-day cap on a
  query stays.
- **Ids:** new events get ULIDs; copied ones keep their Stalwart ids, so links to them still open. An occurrence's
  id is the series id plus its original local start, as the flat event already carries it (`occurrence`).
- Deleted with the mailbox, like its mail.

#### Invitations out (3b)

- Creating, changing or deleting an event with guests sends one email to the guests, from the mailbox, with a short
  HTML summary (what, when in the guest's terms, where, who) and the event as `text/calendar; method=REQUEST` or
  `CANCEL`, plus the same as `invite.ics`. `SEQUENCE` goes up on every change that matters (time, place, guests).
  Removing a guest sends that guest a `CANCEL`.
- **Answering** an invitation (`calendar_respond_to_event`) sends the organizer a `REPLY` that carries only the
  mailbox's own attendee line. This replaces today's workaround of re-creating the event in Stalwart to make it send
  a reply.
- Caps, suppressed addresses and guest limits work as now (`withSendingCaps`: invitation caps for every recipient,
  `email_send` caps for outside ones). Stalwart's 20-participant limit goes away; `MAX_GUESTS` stays 19 until we
  decide otherwise (a later one-line change).
- No Sent copy, as with Stalwart's invitations today. The delivery log gets the `sent` lines (detail
  `invite: request|cancel|reply`), and bounces count against the mailbox as usual.
- "Save without emailing guests" keeps working: the event is saved, nothing is sent.

#### Invitations in (3c)

An incoming message with a `text/calendar` part is stored and shown like any mail (the invite card works on it as
now). In addition, the mail-events queue (`mailbox/events.ts`, after delivery, so receiving stays fast) applies it to
the calendar when it is safe:

- **A reply** to an event this mailbox organizes (same uid): updates that guest's answer, but only when the message
  comes from that guest's own address and passed SPF or DKIM for it, so nobody can answer for someone else.
- **An update or cancellation** of an event already in the calendar: applied when it comes from that event's
  organizer (same checks) and its `SEQUENCE` is not older. An update that moves the time resets the mailbox's own
  answer to "needs action", as Google does. A cancelled event stays, shown as cancelled, as now.
- **A new invitation** is added on its own (answer "needs action") only when its sender would reach the Inbox under
  layer 3 of the spam rules: someone in the organization, or someone the mailbox has written to, or a contact. From
  anyone else it stays an email with the card's **Add to calendar**. This keeps calendar spam out.
- Nothing in **Junk** touches the calendar, and a message that failed DMARC never does.
- `calendar_get_invite` and `calendar_apply_invite` read the invitation from the store and use the same conversion,
  without uploading it to Stalwart to parse.
- Each automatic change is logged in the delivery log (`detail.calendar: added|updated|cancelled|answer`).

#### Copying from Stalwart (3a)

- One job per mailbox: read every calendar and event over JMAP (Stalwart returns JSCalendar), write them to the
  store, count both sides. Rerunning it replaces what the store holds for that mailbox.
- For the pilot now; for every other mailbox as part of its switch in phase 4, while mail still flows through Stalwart
  and nothing changes in its calendar for a few minutes.

#### Google Calendar import (3d)

`migration/calendar.ts` writes through the same store methods when the target mailbox is store-held. Its conversion
(`calendar-rules.ts`) already produces JSCalendar; only the writer changes.

#### Free/busy (3d, optional)

Not offered today: Stalwart supports it, but no API or screen uses it. Proposed: a `calendar_get_availability` that
returns busy blocks (times only, no titles) for mailboxes in the same organization that the caller can read, so the
event editor can show when guests are free. It asks each mailbox's store in parallel. Could be left for later.

#### What goes away

- **CalDAV**, with Stalwart (as already noted). We have never told customers about it, so nothing in the docs
  changes; phone calendars come with the mobile app.
- Stalwart's own scheduling quirks and the workarounds for them in `mailserver/calendar.ts`.

#### Steps

1. **3a, storage and API:** the store tables and methods; repeat expansion with ical.js; the service choosing the
   store for store-held mailboxes (events without guests only, until 3b); the copy job; the pilot copied and
   switched. Tests: expansion across a daylight-saving change, monthly "second Tuesday", an occurrence moved, one
   deleted, an all-day event, a series edited from one occurrence on.
2. **3b, invitations out:** the JSCalendar → iCalendar builder and the emails. Tests: build and parse back
   (round trip); locally, a fake send; on the pilot, an invitation to Gmail and to an Outlook.com address, accepted
   there, and the answer coming back.
3. **3c, invitations in:** iCalendar → JSCalendar, the automatic rules above, the invite card on the store. Tests:
   real invitation files from Google, Outlook and Apple Calendar kept as fixtures; replies, updates, cancels, a
   forged reply (refused), and one from an unknown sender (card only).
4. **3d, Google import and, if wanted, free/busy.**

Each step is written up, approved and pushed separately, as in phase 2.

#### Step 3a: storage and API (approved and built 2026-11-18, uncommitted)

- **`mailbox/calendar-expand.ts`** (pure, tested): JSCalendar repeat rule → RRULE for ical.js, occurrences counted in
  local time and placed in UTC with `zonedToUtc` (formatters now cached per zone), overrides applied (moved, changed,
  deleted, and ones moved in from outside the range), the time columns, JMAP-style patches, and which changes raise
  the sequence. Occurrence ids are `<seriesId>.<YYYYMMDDTHHMMSS>` (original local start).
- **Store:** tables `calendars` and `events` (JSON plus `start_utc`, `end_utc`, `recurring`, `uid`); methods
  `calendarRows`, `setCalendarRows`, `eventsInRange`, `eventRows`, `eventByUid`, `putEvents`, `deleteEvent`,
  `calendarCopy`, `calendarCounts`.
- **`mailserver/calendar-backend.ts`:** the calls `mailserver/calendar.ts` makes (calendars, set up, query, get,
  create, update, destroy, find by uid), with a Stalwart and a store implementation (`mailbox/calendar-store.ts`),
  picked by `mailboxes.backend`. The service otherwise kept its code; parsing an invitation still goes to Stalwart
  (until 3c).
- **No invitations from store-held mailboxes yet:** anything that would email guests (creating or changing an event
  with guests, deleting one as organizer, answering an invitation) is refused with 409 `invitations_unavailable`
  ("Save without emailing guests, or remove them"). Saving with `notify: false` works.
- **Copy from Stalwart:** the first time a store-held mailbox's calendar is used, and from the hourly run for those
  nobody opens, its Stalwart calendars and events are copied once (ids kept; an untouched "Stalwart Calendar" becomes
  Work, plus Personal). Counts must match or the copy fails and is retried; a second request while one copies gets
  503 `calendar_busy`. The store remembers it is done (`meta.calendar_copy`), so later Stalwart changes aren't
  picked up: fine, because nothing writes a store-held mailbox's Stalwart calendar any more (except the Google
  import, until 3d, and Stalwart filing an invitation from another Stalwart mailbox, until 3c).
- **Changed ids:** series keep their Stalwart ids; occurrence ids change format (Stalwart's were opaque, like
  `h0ehqeaaaabf`), so a link to one occurrence made before the switch opens nothing. The web app finds occurrences by
  series and start, so it isn't affected.

**Local test:** on dev@acme.test, four events made on Stalwart (a one-off, a weekly series across New York's DST
change with one occurrence moved, a daily series with one deleted, an all-day event), 49 occurrences from February
to May. After switching the mailbox to the store, the copy ran on first use (2 calendars, 4 events) and the same
range returned the same 49 occurrences, field for field and in the same order. On the store: create a twice-weekly
series in Personal, move the whole series (overrides follow), change one occurrence, delete one, open one by its
occurrence id, delete the series (then 404); an event with guests and emails refused with 409, the same with
`notify: false` saved. The hourly run ran clean. 15 new unit tests (DST, second Tuesday, moved and deleted
occurrences, all-day, ranges, time columns, RRULE, ids, patches); 399 tests pass.

**Deploy:** no migration, queue or secret. After the push, the pilot's calendars are copied on the next hourly run or
when one is opened; the log line `calendar-copy` shows the counts.

**Deployed (2026-11-18, "Implemented Calendar support").** On the pilot, `hello@` and `team@` answered with Work
(default) and Personal and no events, as in Stalwart. On `hello@`: a weekly series (three Thursdays) came back from
the store (ULID id, store occurrence ids), an event with a guest was refused with `invitations_unavailable`, and the
series was deleted again. The web app's Calendar shows only the signed-in person's personal mailbox, so the pilot's
shared mailboxes can't be seen there; asif@xstate.com's own calendar (still Stalwart) was unaffected.

#### Step 3b: invitations out (approved and built 2026-11-18, uncommitted)

Store-held mailboxes email guests themselves, through SES, instead of refusing with `invitations_unavailable`.

**What gets sent, and when** (the same moments Stalwart sends today, so `notify` and "Save without emailing guests"
keep their meaning):

| Change | Who | iTIP method |
|---|---|---|
| Event created with guests | every guest | `REQUEST` |
| Event changed (time, place, title, description, repeat, one occurrence) | guests still on it | `REQUEST` (sequence raised) |
| Guest removed | that guest | `CANCEL` |
| Event deleted by the organizer | every guest | `CANCEL` (status cancelled) |
| One occurrence deleted by the organizer | every guest | `CANCEL` with that occurrence's `RECURRENCE-ID` |
| Invitation answered (`calendar_respond_to_event`, or Add with an answer from the invite card) | the organizer | `REPLY` with only our own attendee line |

A guest deleting an event from their own calendar tells nobody, as now. A change that only touches a guest's answer
doesn't raise the sequence (3a already does this).

**Decisions proposed:**

- **One email per change to all the guests it concerns**, From the mailbox with the organizer's name (as Stalwart
  does, via `organizerOf`), To every guest. Guests see each other in the invitation anyway. Removed guests get their
  own `CANCEL`.
- **No Sent copy** (as today). Each recipient gets a `sent` line in the delivery log with
  `detail.invite: request | cancel | reply`, and SES's delivery, bounce and complaint notifications are counted
  against the mailbox like any mail.
- **Caps unchanged:** `withSendingCaps` already reserves the invitation caps for every recipient and the email caps
  for outside ones, and refuses suppressed addresses. The `invitations_unavailable` refusal goes.
- **Answering gets simpler:** for a store-held mailbox `respondToEvent` sets our own answer and sends the `REPLY`.
  The Stalwart workaround (deleting and re-creating an invitation from outside so Stalwart sends a reply) stays only
  for Stalwart mailboxes.
- **The email itself**, shaped like Google's and Outlook's, which every calendar app understands:
  ```
  multipart/mixed
    multipart/alternative
      text/plain                         what, when, where, who, and the description
      text/html                          the same, laid out
      text/calendar; method=REQUEST      the event (Outlook and Apple read this part)
    application/ics; name=invite.ics     the same event as a file (Gmail and others offer "Add")
  ```
  Subjects: "Invitation: Title @ Thu 19 Nov 2026 3pm – 3:30pm (PKT)", "Updated invitation: …", "Cancelled: …",
  "Accepted: …" / "Declined: …" / "Tentative: …". Times are shown in the event's own zone, named, because we don't
  know each guest's zone; their calendar app shows the event in their own. No footer: the free plan's footer is added by
  Stalwart, and the store's own sends (`sendFromStore`) don't add one either.
- **The iCalendar is built by a pure module** (`mailbox/ical-out.ts`, with ical.js's writer) from the JSCalendar
  event:
  - `VEVENT`: `UID`, `SEQUENCE`, `DTSTAMP`, `DTSTART`/`DTEND` (`VALUE=DATE` for all-day; `TZID` for timed), `SUMMARY`,
    `DESCRIPTION`, `LOCATION`, `STATUS`, `ORGANIZER;CN=…`, one `ATTENDEE` per guest with `ROLE`
    (`REQ-PARTICIPANT` / `OPT-PARTICIPANT`), `PARTSTAT` and `RSVP=TRUE`.
  - Repeats: `RRULE` (the 3a converter), `EXDATE` for deleted occurrences, and one extra `VEVENT` with
    `RECURRENCE-ID` for each changed occurrence.
  - **Time zones:** Outlook refuses a `TZID` without a matching `VTIMEZONE`. We generate it from the runtime's own
    zone data: find the zone's offset changes (by probing with `Intl`) from the event's first start to a few years
    ahead, and write them as `STANDARD`/`DAYLIGHT` blocks. No time-zone database to ship. A zone with no changes (Asia/Karachi)
    gets a single `STANDARD` block.
- **Internal guests travel the same way:** an invitation to a Stalwart-held xstate mailbox goes out through SES and
  arrives at Stalwart like one from outside, which shows it with the invite card (Stalwart doesn't file outside
  invitations by itself). Invitations to store-held mailboxes are filed on arrival in 3c.

**What 3b doesn't do yet:** a guest's answer comes back as an email (Gmail sends "Accepted: …") and lands in the
organizer's inbox, but the guest list isn't updated until 3c reads it. So 3b and 3c are best tried on the pilot
together. Building 3b first keeps each step small; I'd push them one after the other.

**Tests:**
- Pure: build → parse back with ical.js for a single event, an all-day one, a weekly series with one moved and one
  deleted occurrence, a reply and a cancel. The generated `VTIMEZONE` gives the same UTC times as `zonedToUtc` across
  New York's and London's daylight-saving changes. Subjects and the summary text.
- Locally: fake SES sends (`SES_MODE=fake`) for create, change, remove a guest, delete one occurrence, delete, answer,
  checking recipients, method, sequence and the delivery-log lines.
- On the pilot, from `hello@`:
  - an invitation to your Gmail and to an Outlook.com address; both show the right time, with Accept/Decline
  - moving it: both calendars follow
  - removing one guest: that guest's copy is cancelled
  - deleting one occurrence of a series, then the whole event
  - an invitation from Gmail to `hello@`, accepted through the API: Gmail shows the answer

**Built:**
- `mailbox/ical-out.ts`: the iCalendar file as jCal, written by ical.js (escaping, folding). `VTIMEZONE` from
  `zoneOffsetMinutes` (new in `mailserver/calendar-events.ts`): the offset at a year before the event, then each
  change found by daily probes narrowed to the minute, up to a year after the event ends (five years for an open
  series). `UNTIL` is written in UTC for a zoned series.
- `mailbox/invite-mail.ts`: subjects ("Invitation: … @ Mon 2 Mar 2026 9am – 9:45am (GMT-5)") and the text and HTML.
  `Intl` names zones like Karachi "GMT+5", not "PKT".
- `mailbox/scheduling.ts` (pure): what a change means for whom, as in the table, plus one thing the table didn't
  say: when the guest list changes, the guests who stay also get an update (the list they were shown changed), as
  Google and Stalwart do.
- `mailbox/invite-send.ts`: builds and sends each email, logs a `sent` line per recipient (`detail.invite`,
  `detail.kind`, `uid`, `occurrence`).
- `mailbox/compose.ts`: `OutMessage.calendar` adds the `text/calendar; method=…` part (base64) to the alternative
  and `invite.ics` as an attachment.
- `mailbox/calendar-store.ts`: create, update and destroy save first, then work out and send the emails when
  `notify`; a failed send answers 502 `invite_send_failed` ("Saved, but emailing the guests failed"). Deleting one
  occurrence raises the sequence.
- `mailserver/calendar.ts`: the 3a refusal (`invitations_unavailable`) is gone; answering from a store-held mailbox
  always takes the simple path (set our answer, the store sends the reply).

**Local test** (fake SES), on dev@acme.test held by the store:
- organizer: a weekly series with Sam and optional Kim → one invitation to both; moving it → update to both;
  renaming → update; swapping Kim for Lee → cancel to Kim, invitation to Lee, update to Sam; deleting one
  occurrence → one cancellation of that occurrence to Sam and Lee, nothing else; a change with `notify: false` →
  nothing; deleting the series → cancellation to both. Every recipient has its line in the delivery log.
- guest: an invitation from Priya built by our own code (`text/calendar` in the alternative plus `invite.ics`),
  delivered through the fake SES path, was read by Stalwart's parser (a second iCalendar implementation) with the
  right title, time and zone; adding it with "accepted" sent one reply to Priya; declining sent another; deleting it
  sent nothing.
- 16 new unit tests: requests parse back with ical.js; every occurrence of a weekly series over a year matches
  `zonedToUtc` in New York, London, Sydney and Karachi; EXDATE and moved occurrences; all-day dates; cancelling one
  occurrence; replies carry one attendee; a zone without daylight saving gets one STANDARD block; the scheduling
  cases; subjects; HTML escaping; the message structure. 415 tests pass.

**Not yet:** guests' answers update the organizer's guest list only from 3c on (until then they arrive as emails).

**Deployed (2026-11-18, "Added calendar support").** From `hello@99events.com` to Gmail, each accepted by Gmail's
server within two seconds (`ses_delivered`):
- invitation, weekly × 3 at 4pm Karachi: Gmail showed its own invitation card ("Weekly on Monday", organizer
  99events, Yes / No / Maybe) at the right time;
- moved to 5pm: "Updated invitation";
- one occurrence (30 Nov) cancelled: Gmail's card showed Mon 30 Nov 5:00–5:30 PM, but **our subject and summary
  named the series' first date** (23 Nov). Fixed after the test (`cancelledOccurrence` in `calendar-expand.ts`,
  used by both the file and the text; test added; 416 tests pass), uncommitted;
- series deleted: "Cancelled", grouped by Gmail with the occurrence's cancellation.

**Second pilot round (2026-11-18, after "Fixed subject name"):** a new weekly × 2 invitation to Gmail, answered
**Yes in Gmail** (with the user's go-ahead). Gmail's "Accepted: xstate answer test @ Weekly from 3pm to 3:30pm on
Tuesday 2 times (GMT+5)" reached `hello@`'s inbox within a minute (delivery log `delivered`, both calendar parts
scanned), and `calendar_get_invite` read it as `method: reply`, answer accepted from aasif.khan@gmail.com, matched to
our event by UID. Our copy still showed the guest as needs-action, as expected until 3c. Cancelling the 1 Dec
occurrence now reads "Cancelled: xstate answer test @ Tue 1 Dec 2026 3pm – 3:30pm (GMT+5)"; deleting the series sent
the full cancellation.

Still not tried: Outlook (needs a test address), and an invitation from Gmail answered from `hello@` (needs an
invitation sent from the user's own Google Calendar).

#### Step 3c: invitations in (approved and built 2026-11-18, uncommitted)

Calendar emails that reach a store-held mailbox update its calendar, the way Stalwart does for its own mailboxes.
Today they arrive as plain mail with an invite card (read by Stalwart's parser), and guests' answers change nothing.

**1. Reading invitation files ourselves** (`mailbox/ical-in.ts`, pure, with ical.js): iCalendar → the JSCalendar
event the store keeps, plus the method.
- `SUMMARY`, `DESCRIPTION`, `LOCATION`, `STATUS`, `SEQUENCE`, `UID`, all-day dates, `DTEND` or `DURATION`.
- `ORGANIZER` and `ATTENDEE` → participants (owner, optional, `PARTSTAT` → participationStatus, `CN` → name).
- Repeats: `RRULE` through the converter the Google import already has (`parseRrule`), `EXDATE` through
  `exdateKeys`, and each extra `VEVENT` with a `RECURRENCE-ID` as an override.
- **Time zones:** an IANA `TZID` (Google, Apple) is kept. A Windows name ("Pakistan Standard Time", Outlook) is
  mapped with a table (the ~140 names in CLDR's windowsZones). Anything else (Outlook's
  "(UTC+05:00) Islamabad, Karachi", custom ids) is matched to an IANA zone whose offsets agree with the file's
  `VTIMEZONE` for the event's year; failing that, times are taken as UTC.
- For store-held mailboxes this replaces Stalwart's `CalendarEvent/parse` in `calendar_get_invite` and
  `calendar_apply_invite`, so the invite card no longer needs Stalwart.

**2. Applying them on arrival.** The mail-events queue (`mailbox/events.ts`, after delivery, so receiving stays fast)
looks at each received message with a `text/calendar` part and its `method`, and applies it when it is safe:

| Method | Applied when | What changes |
|---|---|---|
| `REPLY` | we organize the event (same `UID`), the attendee is on our guest list, and the email is from that attendee | that guest's answer (for the whole series, or one occurrence with `RECURRENCE-ID`) |
| `REQUEST`, event already in the calendar | it comes from the event's organizer and its `SEQUENCE` is not older | the event, keeping our own answer, unless the time moved: then it goes back to "needs action" (as Google does) |
| `REQUEST`, new event | the sender would reach the Inbox under spam layer 3 (in the organization, written to, or a contact) | added to the default calendar, answer "needs action"; from anyone else it stays an email with **Add to calendar** |
| `CANCEL` | it comes from the event's organizer | the event (or that occurrence) marked cancelled, still shown, as now |
| anything else (`COUNTER`, `REFRESH`, `ADD`, `PUBLISH`) | — | nothing; the email is shown as it is |

**"Comes from" is checked, not assumed.** The address in `From` must be the attendee (for a reply) or the organizer
(for an update or cancellation), and that `From` must be authenticated. SES stamps every received message with
`Authentication-Results: amazonses.com; …`, for example on Gmail's "Accepted" reply on the pilot:
`spf=pass … envelope-from=aasif.khan@gmail.com; dkim=pass header.i=@google.com; dkim=pass header.i=@gmail.com;
dmarc=pass header.from=gmail.com`. Trusted when `dmarc=pass` for the `From` domain, or a `dkim=pass` whose
`header.i`/`header.d` domain is the `From` domain. SPF alone isn't enough (it checks the envelope, not `From`).
Google sends answers with `Sender: calendar-notification@google.com` but `From` is the guest, signed by gmail.com,
so they pass. The header is read from our raw copy; a message without SES's stamp is never trusted.

Nothing in **Junk** is applied, and no email is sent automatically (answering is still the person's choice).
Each change is a `calendar` line in the delivery log (`detail`: `uid`, `method`, `action`:
added/updated/cancelled/answer, `from`), and anything skipped says why (`not_authenticated`, `not_organizer`,
`unknown_event`, `older_sequence`, `unknown_sender`), so "why didn't it update" can be answered.

**3. Invitations between two xstate mailboxes** travel through SES both ways (3b), so they are handled by the same
rules: a colleague is "in the organization", so their invitations are added on arrival. One thing to check while
building: Stalwart may still list a store-held domain (99events.com) as local and file a Stalwart user's invitation
into the Stalwart calendar instead of emailing it. If so, store-held domains are removed from Stalwart's local
domains (they no longer receive mail there anyway).

**Tests:**
- Pure: real files as fixtures: Google's REPLY from the pilot (already saved), a Google REQUEST with a moved and a
  deleted occurrence, Outlook's REQUEST with a Windows zone and Outlook's own `TZID`, Apple Calendar's REQUEST, and
  our own (round trip with `ical-out.ts`). The `Authentication-Results` rule: aligned DMARC, aligned DKIM, DKIM for
  another domain only, SPF only, missing header.
- Locally (fake SES): reply → guest answer updated; forged reply (From another address, or not authenticated) →
  skipped with its reason; update moving the time → answer reset; cancel → cancelled; new invitation from a known
  sender → added, from an unknown one → not added; one in Junk → nothing.
- On the pilot: the 3b test again, with your Gmail "Yes" now updating the guest list in `hello@`; an invitation from
  your Google Calendar to `hello@` (you've written to it, so it is added on arrival), accepted through the API, and
  Google showing the answer.

**Needs from you for the pilot:** sending one invitation from your Google Calendar to `hello@99events.com`, and an
Outlook address if you can.

**Decided:** new invitations from known senders are added on arrival (the proposal).

**Built:**
- `mailbox/ical-in.ts` (pure): `parseIcs` → method, UID, the event (overrides from `EXDATE` and `RECURRENCE-ID`
  VEVENTs) and occurrence-only entries. A UTC `UNTIL` is read in the event's zone. An exception that leaves out the
  location, status or guests (Outlook does) keeps the series' values instead of clearing them. Zones: IANA kept,
  `WINDOWS_ZONES` (CLDR's 001 mappings), else the first common zone matching the file's January and July offsets.
- `mailbox/sender-auth.ts` (pure): `headerLines`, `proveSender`. Only the first `Authentication-Results` is read, and
  only if it is SES's (`amazonses.com`); DMARC pass for the From domain first, then an aligned DKIM pass.
- `mailbox/calendar-in.ts` (pure): `decide` (the table, with a reason for every skip) and `timeMoved`.
- `mailbox/calendar-apply.ts`: runs from the mail-events queue for new received mail not carrying a virus (not for
  old mail being caught up, which would replay stale invitations); applies through the store calendar without
  emailing anyone; logs a `calendar` line (`uid`, `method`, `action`, `reason`, `status`, `eventId`, `proof`).
  Failures are logged, not retried.
- Store `updateEvent` keeps a `sequence` given in the patch (an organizer's), instead of raising its own.
- `calendar_get_invite` / `calendar_apply_invite` read store-held mailboxes' files with `parseIcs`, so the card no
  longer needs Stalwart.

**Local test** (fake SES; test messages carried an `Authentication-Results` written as SES writes it, or none), on
dev@acme.test held by the store:
- as organizer, inviting sam@example.org: a reply from someone not on the list → skipped (`not_a_guest`); Sam's
  reply without SES's header → skipped (`not_authenticated`); Sam's proven reply → guest list shows Sam accepted.
- as guest: a stranger's invitation → not added (`unknown_sender`), but the card reads it (our parser) and **Add to
  calendar** adds it; a colleague's (acme.test) → added as needs action; accepted through the API; renamed by the
  organizer (sequence 1) → updated, still accepted; moved (sequence 2) → updated, back to needs action; a stale
  update (sequence 1) → `older_sequence`; a cancellation from another colleague → `not_organizer`; the organizer's
  cancellation → shown as cancelled.
- 16 new unit tests: Google's real reply (anonymised), an Outlook request with a Windows zone, a deleted and a moved
  occurrence, Outlook's own zone id matched to America/New_York, an Apple all-day event, our own files read back,
  one-occurrence cancellation; sender proof (DMARC, DKIM, subdomain, SPF only, another domain, a forged second
  header, a non-SES header, none); every decision. 432 tests pass.

**Deployed (2026-11-18, commit d07fb1c).** On the pilot:
- an invitation from `hello@` to Gmail, answered Yes in Gmail: the reply reached `hello@` at 07:26:00 and 8 seconds
  later the `calendar` line recorded `reply → answer accepted`; `hello@`'s guest list showed the guest accepted.
- **Found:** an invitation from asif@xstate.com (on Stalwart) to `hello@99events.com` never reached SES or the store
  in 1½ minutes; the organizer's copy kept `hello@` at needs-action. Stalwart still lists 99events.com and the pilot
  accounts as its own, so it delivers to them internally (here into `hello@`'s old Stalwart calendar). The same must
  hold for plain email from a Stalwart mailbox to a pilot address, and it does: "Internal routing test" sent from
  asif@xstate.com to `hello@` at 07:28:44 UTC never reached the store; it is in the old Stalwart account, which nobody
  reads now. Fix: when a domain moves to the store, remove it (and its accounts) from Stalwart, so Stalwart
  sends to it by MX like any outside domain. Needed for the pilot now and part of every domain switch in phase 4.

#### Step 3d: Google Calendar import into the store (approved and built 2026-11-18, uncommitted)

**Why:** the Workspace import (`migration/calendar.ts`) still writes into Stalwart with the mailbox's
`stalwart_id`. For a mailbox whose mail and calendars the store holds, an import would fill the old Stalwart
calendar, which nobody sees.

**Approach: the import uses the same calendar backend as the API** (`calendarsOf(env, mailbox)`, from 3a), so it
writes wherever the mailbox's calendars are, Stalwart or store. Its own logic stays as it is: the claims in the
MigrationStore, the conversion (`calendar-rules.ts`), occurrences written into their series, the final pass after
the switch, and nothing ever sent to guests.

The import makes six kinds of call today; four exist on the backend already:

| Call | Today | Backend |
|---|---|---|
| set up Work and Personal | `setUpCalendars(env, accountId)` | `cal.setUp()` |
| make a calendar per Google calendar | `jmap.createCalendar` | **new** `cal.createCalendar(name)` |
| create a page of events, without emails | `jmap.importEvents` (per-event refusals) | **new** `cal.importEvents(events)` |
| read, change, delete one event | `jmap.getEvent` / `updateEvent(…, false)` / `destroyEvent(…, false)` | same calls, `notify: false` |

- **`createCalendar`:** Stalwart as today; store: a ULID calendar after the others in sort order.
- **`importEvents`:** Stalwart as today; store: each event checked (its calendar exists, its time columns can be
  worked out: a rule ical.js can't read is a refusal for that event, not for the page), then one `putEvents` call
  for the page. Same result shape, `{ created, failed }`, so the import's report works unchanged.
- **The 20-guest limit** (`MAX_PARTICIPANTS` in `calendar-rules.ts`, with its "N more guests weren't copied" note)
  is Stalwart's. The store has no such limit, so for store-held mailboxes the limit is lifted to the API's own
  guest limit for imports (proposed: 100, since imported events send nothing). The note stays for anything over.
- **Mailboxes that move while an import runs:** each page asks for the backend afresh, so a page after the switch
  goes to the store. Pages written to Stalwart before the switch are carried over by the one-time calendar copy
  (3a), which runs at the switch; the sweep (Stalwart routing fix) copies any event it missed by UID. The
  MigrationStore's source→target ids stay valid because copied events keep their ids.

**Related gap, not in 3d:** the Workspace import's **mail** copy (`migration/mail.ts`, `jmap.importEmails`) also
writes into Stalwart. Importing mail into a store-held mailbox needs its own step (the store's `deliver` with a
`migrated` source instead of SES verdicts, and no agents, calendar rules or "new mail" pushes for old mail). Proposed
as part of phase 4, since moving a Google Workspace customer onto a store-held domain is when it is first needed.

**Free/busy:** not in 3d. Nothing in the app or the MCP tools uses it today; it can be its own small step when the
event editor wants to show guests' availability.

**Tests:**
- Pure: the participant limit by backend.
- Locally, with the fake Google (`migration/google` fakes): import into dev@acme.test held by the store: primary
  calendar into Work, a second Google calendar becomes its own calendar, a repeating event with a changed and a
  cancelled occurrence lands as one series with its overrides, an event with 30 guests is kept whole; a retried page
  adds nothing twice; the final pass applies a change and a deletion made in Google after the first copy.
- The same run against a Stalwart-held mailbox, to show nothing changed for those.
- On the pilot: only if there is a Google account with a test calendar to import from; otherwise local only.

**Decided:** 100 guests per imported event on the store (the proposal).

**Built:**
- `CalendarBackend` gains `createCalendar(name)` and `importEvents(events)`; Stalwart's are the existing JMAP calls,
  the store's make a ULID calendar after the others, and check each event (calendar exists, time columns can be
  worked out) before one `putEvents` per 200, refusing only the bad ones.
- `migration/calendar-rules.ts`: `MAX_PARTICIPANTS_STORE = 100` and `ConvertContext.maxParticipants` (the trim note
  names the limit used); `contextFor` picks it by `mailbox.backend`.
- `migration/calendar.ts`: no Stalwart calls left; every page and the final pass ask `calendarsOf(env, mailbox)`.
  Occurrence changes written into a store-held series pass the series' own sequence, so the final pass's sequence
  comparison isn't thrown off by the store's own bump.

**Local test** (fake Google, `GOOGLE_MODE=fake`):
- dev@acme.test held by the store, calendar-only import: 12/12 done; calendars Work, Personal and a new
  "Team offsite"; the weekday standup with its EXDATE excluded, a cancelled occurrence excluded and a moved occurrence
  (listed before its series) applied; the 25-person all-hands kept every guest (Stalwart's limit would have cut it to
  20); Lisbon-time and all-day events kept their zone; the month-end series (`BYSETPOS=-1`) expands. The final pass
  applied its three changes: "Kickoff" added, "Design review (v2)" renamed, "Day off" deleted.
- A second import, into a new Stalwart-held mailbox (priya@acme.test): unchanged behaviour, the same 3 calendars and
  8 events in Stalwart, the all-hands trimmed to 20, the standup with its 3 occurrence changes.
- 1 new unit test (the limit by context); 437 tests pass.

**Deploy:** no migration, queue or secret. Nothing on the pilot uses the import; it is covered locally.

#### Open questions

- For 3b: is there an Outlook.com (or Microsoft 365) address we can send test invitations to? Outlook is the strictest
  about time zones, so it is the one worth testing.
- Free/busy: build it in 3d, or later?
- Whether new invitations from unknown senders should still be added, shown as "needs action" (Google's default), or
  stay email only (proposed).
- Whether `MAX_GUESTS` rises once Stalwart's limit is gone, and to what.

### 4. Switching domains

The MX switch and flip above, one domain at a time, starting with our own.

#### Threading headers for copied mail (design written 2026-11-18, for review; nothing built)

**Why:** a copied mailbox (hireninja: 53,747 messages, 5.1 GB of raw copies, in `read` mode) has every message, but
its rows have no `message_id`, `in_reply_to` or `refs`: the shadow copy never stored them. After the switch, a reply
to an old message is threaded by those (`deliver`: In-Reply-To and References looked up in `messages.message_id`),
so without them every reply to old mail starts a new conversation, and the sweep's "already in the store"
check (by Message-ID) can't recognise copied mail.

**Not by raising `COPY_VERSION`.** A version change runs `reset()` and copies again from the start: the index
(about 75 minutes for hireninja, with empty lists meanwhile unless it is put back to `shadow` first) and every raw
message from Stalwart again (`copyOne` downloads unconditionally; a few hours for 5.1 GB). Nothing about the copy is
wrong; only three columns are missing.

**Instead, a backfill in place:**
- Store: `missingThreading(limit)` returns ids of rows without `message_id` and not yet tried (a `threading_s`
  column marks rows done, including ones that have no Message-ID at all, so they aren't asked for forever);
  `setThreading(rows)` writes `message_id`, `in_reply_to`, `refs` (and `threading_s`) in one statement per batch.
- From Stalwart, not the raw copies: `Email/get` with `properties: ['messageId', 'inReplyTo', 'references']` for
  500 ids per call (RFC 8621 header properties; no body, no raw). About 110 calls for hireninja. Reading the
  headers back out of R2 would avoid Stalwart but means reading 5.1 GB.
- Ids that Stalwart no longer has (deleted meanwhile) are marked done; the shadow sync removes them anyway.
- Runs as `store-threading` jobs on the existing `STORE_COPY` queue (the same queue and pacing as the raw copy), a
  batch per job, the next batch queued by the job itself until none are left; started by the hourly
  `mailbox-store-check` for every store with rows missing it, so it also covers mail copied later.
- New shadow copies store the three headers from the start (`getStoreEmails` asks for them too), so the backfill
  only ever has old rows to do.
- Safe in `read` mode and safe to repeat; the hourly check logs `threading: done/left` per mailbox.

**Before a domain switches** (phase 4's checklist, with the routing rule and the sweep from phase 3): the mailbox's
copy is complete (raw copies `n/n`), its threading backfill shows nothing left, its calendars are copied, then the
backend flips, the routing rule is applied and the sweep runs.

**Tests:** pure tests for the batch handling (done rows skipped, rows without a Message-ID marked, deleted ids);
locally on a copied mailbox: backfill fills every row, a reply to an old message delivered after the switch lands in
the old thread, and the sweep skips a message the store already has; on production, hireninja first in `read` mode,
checking the counts, then asif@xstate.com.

### 5. Retire Stalwart

Once every mailbox runs on the store: remove `mailserver/stalwart/`, mail sync's Stalwart path, the Stalwart
webhook, the SMTP sending caps (`scripts/stalwart-limits`) and the local `pnpm mail:dev` stack; shut down deepo's
Stalwart and Postgres. The scanner stays. Local development gets simpler: no local mail server, only a fake SES
endpoint that posts test messages to the receiving Worker.

## What changes for customers

- **Mail apps over IMAP and SMTP stop working** when their domain switches. Warn everyone who has used IMAP well
  before, and update `apps/web/content/docs/security.md`, which mentions IMAP.
- **The MX record changes** for each domain.
- Everything in the web app, mobile app, API and MCP keeps working.

## Docs to update when built

- `apps/web/content/docs/security.md`: IMAP and SMTP removed, where mail is stored, scanning.
- `apps/web/content/docs/privacy.md`: received mail passes through Amazon SES and briefly through S3.
- `docs/stalwart-api.md`: archive it once Stalwart is gone.
- Domain setup docs: the new MX record.

## Risks

- **We become the mail server.** MIME edge cases, threading, character sets and spam handling are hard, and Stalwart
  handled them. The shadow copy tries them against all the real mail before anything depends on it.
- **The 10 GB limit per mailbox object.** See the size note under [The mailbox object](#the-mailbox-object).
- **MX records point at one AWS region.** Moving region later means every customer changes DNS again; Domain Connect
  softens that.
- **Losing IMAP and CalDAV** may cost customers who rely on Outlook, Apple Mail or Apple Calendar.
- **Copy correctness.** Every message, folder and flag must arrive; hence the per-folder checks.
- **No easy way back after a domain's MX switch.**

## Open questions

- Pilot domain and the first customer domain to move.
- Whether to drop unknown recipients silently (proposed) or bounce them.
- How long to keep Stalwart read-only after a domain switches (proposed 30 days).
- When large organizations need the organization-level index (proposed: build it when an organization passes about
  100 mailboxes).
- Whether Rspamd (spam layer 4) is needed, decided from the pilot's numbers, and which blocklist feed to license.
- Whether search in the web app shows word search and search by meaning as two tabs or one merged list.
