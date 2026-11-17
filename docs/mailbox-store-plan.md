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

- Events live in the mailbox object: the full iCalendar data, plus columns for start, end, recurrence and
  attendees. A repeating event is stored once and expanded when shown. Time zones come from the event.
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
phase 4) needs the Message-ID, In-Reply-To and References of copied mail too. The shadow copy will ask Stalwart for
them (JMAP header properties, no raw read) and store them, with `COPY_VERSION` 6. Not needed for the pilot; it can
ship later, before phase 4.

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

**Decided (2026-11-17):** pilot on `pilot.xstate.com`; a full mailbox refuses mail from step 4, not step 1.

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

### 3. Calendars

Events, invitations in and out, free/busy, FullCalendar against the new API, the Google Workspace imports writing
to the store.

### 4. Switching domains

The MX switch and flip above, one domain at a time, starting with our own.

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
