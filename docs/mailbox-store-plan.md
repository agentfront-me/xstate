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
