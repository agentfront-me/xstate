# Plan: message API and attachments in R2

Status: proposal, revised 2026-11-05. Nothing here is built yet. Each claim about Stalwart is checked against its
docs in [Verified claims](#verified-claims) at the end.

## Why

The dashboard (`apps/www/public/app/`) shows real domains and mailboxes, but a signed-in inbox is empty: the API can
manage mailboxes but can't read or send mail. This plan adds `email_*` operations for messages, backed by Stalwart's
JMAP mail API, and wires the Email view to them. Operations are also MCP tools, so agents get the same mail tools.

Attachments are stored in Cloudflare R2: one bucket per organization, one folder per mailbox, with a `files` table in
D1 describing each one.

## How the API reaches a mailbox's mail

The `impersonate` permission "allows requests that carry the `accountId` of any account" through the management API
and JMAP. The System Administrator role holds it. An API key "acts as the account it belongs to" and, with default
permissions, "has every permission of its account, mail access included". So the existing `STALWART_API_KEY` (from
the admin account) can call `Email/query`, `Email/get`, `EmailSubmission/set` and so on with
`accountId = <the mailbox's account>`.

Still to prove in step 1:

- that the JMAP mail `accountId` is the `x:Account` id we store as `stalwart_id`, or how one maps to the other
- that the admin account holds the protocol (`jmap*`) permissions through the User role the Admin role includes

Fallback if either fails: create one key per mailbox account with `x:ApiKey/set` and that account's `accountId`
(needs `impersonate` plus `sysApiKeyCreate`). We'd store those keys encrypted in D1.

Master-user sign-in (`target%admin` with a password) is not an option: API keys can't use it, and it would mean
keeping the admin password in the Worker.

## Who can read whose mail

Today `mailboxContext(..., 'read')` lets anyone who can read a domain open every mailbox on it. That is fine for
settings, but too broad for mail. A new `mailContext(env, actor, mailboxId, 'read' | 'write')`:

| Mailbox kind | Who can open it |
| --- | --- |
| personal | Only its owner (`mailbox_access.access = 'owner'`). Admins don't read people's personal mail. |
| shared | Members in `mailbox_access` (full = write, read = read), plus owners and admins. |
| agent | Owners, admins and people who manage the domain. |

The same check guards attachments: a file can be read by whoever can read its mailbox.

## Operations

All take our `mailboxId`; the service maps it to the Stalwart account. "Folder" means a JMAP Mailbox, renamed so it
isn't confused with our mailboxes.

| Operation | HTTP | Does |
| --- | --- | --- |
| `email_list_folders` | `GET /email/mailboxes/:mailboxId/folders` | `Mailbox/get`: role, name, unread and total counts |
| `email_list_messages` | `GET /email/orgs/:organizationId/messages?mailboxId&folder&unread&q&cursor` | `Email/query` + `Email/get` summaries. Leaving out `mailboxId` merges every mailbox the actor can read. Each message lists its attachments from `files`. |
| `email_get_thread` | `GET /email/mailboxes/:mailboxId/threads/:threadId` | `Thread/get` + `Email/get` with bodies; attachments from `files` |
| `email_update_message` | `PATCH /email/mailboxes/:mailboxId/messages/:emailId` | `Email/set`: seen (`$seen`), pinned (`$flagged`), folder |
| `email_send` | `POST /email/mailboxes/:mailboxId/send` | Creates the draft and submits it (`Email/set` + `EmailSubmission/set`), attaching files by `fileId` |
| `email_changes` | `GET /email/orgs/:organizationId/changes?since=<state>` | `Email/changes`, for polling |
| `files_create_upload` | `POST /files/mailboxes/:mailboxId/uploads` | Reserves a `files` row and returns a presigned R2 PUT URL |
| `files_complete_upload` | `POST /files/:fileId/complete` | Checks the object landed (size, type) and marks the row ready |
| `files_get` | `GET /files/:fileId` | Metadata plus a short-lived presigned R2 GET URL |
| `files_list` | `GET /files/mailboxes/:mailboxId?emailId&q&cursor` | A mailbox's files, for an "Attachments" view and for agents |

Pinned maps to `$flagged`, so it also shows as starred in Apple Mail and Thunderbird. Assigning a conversation has
no JMAP equivalent and comes later, with its own table.

## Attachments

### What Stalwart does with them

Stalwart keeps each raw message, attachments included, in its blob store. Blobs are identified by a BLAKE3 hash of
their content, deduplicated and compressed. The blob store can be S3-compatible (R2 is named), but it is one bucket
for the whole server: "Stalwart writes each blob to one bucket only", and the only split is a fixed `keyPrefix`.
**Stalwart can't put each organization's mail in its own bucket**, and its objects are compressed, content-addressed
blobs, not files a person could browse.

So the R2 attachments are our own copy, made by the API. Stalwart keeps the full message, so IMAP clients, forwarding
and DKIM signatures keep working. Each attachment is stored twice, once in each place. This is accepted: R2 storage
is $0.015 per GB-month and downloads from R2 are free.

### Stalwart's own storage moves to R2 too

Decision (2026-11-05): no mail files on the mail server's disk. Stalwart's blob store moves to one shared R2 bucket,
so the server keeps only the data store (accounts, folders, flags, the search index) in Postgres.

- **What moves:** every blob, meaning raw messages with their attachments, Sieve scripts, JMAP uploads not yet sent,
  and spam-classifier training data.
- **Bucket:** `xstate-mail-blobs`, one for the whole server, separate from the organization buckets. Give it a
  location hint near the server (Eastern North America), since every message read and write goes to R2.
- **Credentials:** an R2 API token limited to Object Read & Write on that one bucket. It goes in an environment
  variable on the server, so it never sits in Stalwart's settings.
- **BlobStore setting** (Settings › Storage › Blob Store, or `x:BlobStore`). The `Custom` region shape below is
  rebuilt from the field list; the docs show no complete example.

  ```json
  {
    "@type": "S3",
    "bucket": "xstate-mail-blobs",
    "keyPrefix": "mx1/",
    "region": { "@type": "Custom", "url": "https://<cloudflare account id>.r2.cloudflarestorage.com", "region": "auto" },
    "accessKeyId": { "@type": "EnvironmentVariable", "variableName": "R2_BLOBS_ACCESS_KEY_ID" },
    "secretKey": { "@type": "EnvironmentVariable", "variableName": "R2_BLOBS_SECRET_ACCESS_KEY" },
    "sessionToken": { "@type": "None" },
    "timeout": 30000,
    "maxRetries": 3,
    "verifyAfterWrite": false
  }
  ```

  `keyPrefix` leaves room for a second mail server in the same bucket later. Turning off `verifyAfterWrite` follows
  the docs: R2 guarantees an object is stored once the write is acknowledged, so the extra check isn't needed.
- **If R2 is unreachable:** writes are retried up to `maxRetries` times. If they still fail, incoming SMTP mail gets a
  temporary `451` and the sending server tries again later, so nothing is lost. Reading message bodies fails until
  R2 is back.
- **Switching is not automatic:** changing the blob store only changes where new blobs go. "After a change the
  messages, files and scripts written before it can no longer be read." Existing blobs have to move with Stalwart's
  export and import, with the server stopped:
  1. Check what is on the server now: which blob store is set, and how much real mail exists.
  2. If it holds only test mail, the simple path is to switch the setting, restart, and recreate the test
     mailboxes.
  3. If it holds mail to keep, stop Stalwart and run `stalwart --export` (every family, as the docs advise). Import
     into a fresh Postgres database with the new R2 blob store configured, start it, then run the `reindexAccounts`
     maintenance task. Restricting the export to blobs alone isn't safe: the docs say to always include `data`, and
     importing needs an empty target.
  - Doing this now, before customers have mail, keeps it to a few minutes of downtime.
- **Still on the server:** the Postgres data store (accounts, folders, flags, search index). Decision
  (2026-11-05): it stays on deepo and does not move to managed Postgres.

### Why a copy, not stripping attachments out of mail

An MTA hook could take attachments out of incoming messages (it can replace the body at the DATA stage). That would
avoid storing them twice, but I recommend against it:

- Mail clients would see a link instead of the attachment.
- It would break DKIM signatures on the message.
- With `tempFailOnError` on (the default), inbound mail is deferred whenever our Worker is down.
- The docs only describe the hook for SMTP sessions, so messages sent through JMAP may never pass through it.

The cost of copying is storing attachments twice: once compressed in Stalwart, once in R2. That can be revisited
later, for example with a retention rule on one side.

### Ingesting attachments

Ingestion is triggered by Stalwart's webhook and driven by JMAP changes, so it covers every path the same way:
inbound mail, mail sent from the dashboard, and mail sent from Apple Mail, Spark or other clients.

1. Stalwart's webhook (see `docs/stalwart-api.md` §7) posts `message-ingest.*` events to `POST /webhooks/stalwart`.
   The API checks the signature, converts each event's numeric `accountId` to the JMAP id, and queues a
   `MAIL_SYNC` job for each matching mailbox.
2. The queue consumer (`jobs/mail-sync.ts` → `storage/mail-sync.ts`) calls `Email/changes` from the mailbox's saved
   state. Each created message's attachment parts are claimed in `files` (status `pending`), streamed from
   `/jmap/download/...` into the organization's bucket while being hashed, then marked `ready`. Inline parts under
   20 KB (logos, tracking pixels) are skipped.
3. Destroyed messages mark their files `deleted`. The hourly cron then removes files deleted more than 30 days ago
   (`storage/purge.ts`, `GRACE_DAYS`), from R2 first and then from `files`, up to 500 per run. Until then a deleted
   file can still be recovered by hand.
4. A mailbox seen for the first time, or whose saved state is too old to diff from, is backfilled. Its current
   state is noted, every message with attachments is copied, then the state is saved.
5. An hourly Cron Trigger queues every mailbox, because webhooks aren't guaranteed and deletions send none.
   Mailboxes with nothing new finish in one JMAP call.

Every step can be repeated safely: the unique `(mailbox_id, email_id, part_id)` index plus the claim-then-upload
order mean a retried or duplicated job never stores a second copy.

Small inline images, such as signature logos and tracking pixels, are skipped below a size threshold (proposed:
inline parts under 20 KB). They aren't stored or listed.

### Uploading for sending

1. `files_create_upload` writes a `pending` row and returns a presigned PUT URL. The browser or desktop app uploads
   straight to R2, and the bytes never pass through the Worker.
2. `files_complete_upload` checks the object and marks the row `ready`.
3. `email_send` takes `fileIds`. For each one it streams the object from R2 to Stalwart's
   `/jmap/upload/<accountId>/`, then references the returned blob id in the new message.

Stalwart's default `maxUploadSize` is 50 MB per upload and `maxRequestSize` is 10 MB per request. Per-message
attachment limits are set separately in Stalwart's message settings. We'll enforce the same limits when creating
the upload, so people find out before sending.

### R2 layout

- **One bucket per organization:** `xstate-org-<organization id>`, created when the organization is created. R2
  allows 100,000 buckets per account by default, and the limit can be raised. Bucket management is limited to
  50 requests a second, which is fine for sign-ups.
- **One folder per mailbox:** `<mailbox id>/<yyyy>/<mm>/<file id>/<file name>`. The folder is named by mailbox id,
  not address, because addresses can be renamed. The file id keeps names from colliding.
- **How the Worker reaches buckets:** a binding is fixed in `wrangler.jsonc` at deploy time, so a Worker can't bind
  buckets created at runtime. It uses R2's S3 API instead (`aws4fetch`, about 3 KB) with an R2 access key for the
  account. Buckets are created through the Cloudflare API. Both credentials are Worker secrets.
- **Downloads:** presigned GET URLs that expire after 5 minutes, issued only after `mailContext` passes, with
  `Content-Disposition: attachment` so files download rather than render.
- **Deleting:** deleting a mailbox deletes its folder. Deleting an organization empties its bucket, then deletes it.

Why per-organization buckets are worth the extra work over one shared bucket: deleting a tenant is clean,
per-organization storage can be measured from bucket metrics, and organizations can get a data location later
(R2 jurisdictions are set per bucket).

### `files` table

Migration `0002_files.sql`:

```sql
-- The organization's R2 bucket for files. NULL until it has been created.
ALTER TABLE organizations ADD COLUMN r2_bucket TEXT;

-- Last JMAP Email state seen per mailbox, so attachment ingestion resumes where it stopped.
CREATE TABLE mailbox_sync (
  mailbox_id   TEXT PRIMARY KEY REFERENCES mailboxes (id) ON DELETE CASCADE,
  email_state  TEXT,
  synced_at    TEXT
);

-- Every file in R2: attachments of received and sent mail, and uploads waiting to be sent.
CREATE TABLE files (
  id                TEXT PRIMARY KEY,
  organization_id   TEXT NOT NULL,
  mailbox_id        TEXT,                     -- NULL for future files that aren't mail
  r2_key            TEXT NOT NULL,            -- '<mailbox id>/2026/11/<file id>/invoice.pdf'; the bucket is the org's
  name              TEXT NOT NULL,            -- file name as sent, cleaned for display
  content_type      TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  sha256            TEXT,                     -- set once the bytes are in R2
  source            TEXT NOT NULL CHECK (source IN ('received', 'sent', 'upload')),
  status            TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('pending', 'ready', 'deleted')),
  email_id          TEXT,                     -- Stalwart Email id
  thread_id         TEXT,
  part_id           TEXT,                     -- MIME part within the message
  stalwart_blob_id  TEXT,
  disposition       TEXT CHECK (disposition IN ('attachment', 'inline')),
  content_id        TEXT,                     -- for inline images referenced as cid:
  created_by        TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  deleted_at        TEXT,
  FOREIGN KEY (mailbox_id, organization_id) REFERENCES mailboxes (id, organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX files_part_uniq ON files (mailbox_id, email_id, part_id) WHERE email_id IS NOT NULL;
CREATE INDEX files_mailbox_idx ON files (mailbox_id, created_at);
CREATE INDEX files_email_idx ON files (mailbox_id, email_id);
CREATE INDEX files_org_idx ON files (organization_id);
```

A deleted mailbox cascades its `files` rows away, so its R2 folder must be deleted first, in the same operation.

## Sending is blocked outside xstate

This comes from our server notes, not Stalwart's docs. AWS blocks outbound port 25 on the Stalwart host, and its
reverse DNS (PTR) is still the default EC2 name. Mail between xstate addresses works. Mail to outside addresses won't
deliver until one of these is done:

- **Recommended:** relay Stalwart's outbound mail through Amazon SES (on AWS already, handles sending reputation).
- Ask AWS to lift the port 25 block, set the PTR to `mx.xstate.com`, and build reputation on our own IP.

## Dashboard changes

- `store.js`: live mode loads messages through the API; demo mode keeps `sample.js`.
- `mail.js`: real folder counts, a paged list, the thread view, actions with optimistic updates, and polling of
  `email_changes` every 30 s while the window is visible.
- Attachments show as chips on the message and download through `files_get`. The composer's paperclip uploads
  straight to R2 and shows progress.
- HTML mail renders in a sandboxed `<iframe srcdoc>` with scripts off and remote images blocked until "Show images".
  `cid:` images resolve to presigned R2 URLs.
- The desktop app shows new-mail notifications (respecting the setting) and keeps the unread count current.

## Steps

0. **Done 2026-11-05: Stalwart's blob store is on R2.** The server held only test mail, so the setting was switched
   directly. The 7 old test messages, whose contents were left behind in Postgres, were deleted. Recorded in
   `docs/stalwart-api.md`.
1. **Spike.** The Stalwart half is answered: the admin key works with `accountId` = `stalwart_id` (see Verified
   claims). Left to do: create an R2 bucket through the Cloudflare API, and put an object into it from a Worker with
   `aws4fetch`.
2. **Done 2026-11-05:** migration `0002_files.sql`; `storage/r2.ts` (S3 API via aws4fetch: put, get, head,
   list, delete, delete folder, presigned GET/PUT); `storage/buckets.ts` (create with CORS through the Cloudflare
   API, `xstate-dev-org-<id>` outside production). Buckets are created in the background at sign-up, for existing
   organizations at the owner's next sign-in, or lazily when the first file is stored. Deleting a mailbox deletes
   its R2 folder. Secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_API_TOKEN` (one R2 "Admin
   Read & Write" token). Known gap: bucket CORS only accepts http(s) origins, so the desktop app (`app://xstate`)
   will need uploads to go through its main process or the API.
3. **Done 2026-11-05: read operations.** `email_list_folders`, `email_list_messages`, `email_get_thread`,
   `email_update_message` (read, pinned, move; creates Archive on first use), `email_get_mail_state` (polling
   token) and `email_get_attachment` (streams from Stalwart until R2 copies exist), with `mailContext` in
   `mailserver/access.ts`. JMAP message ids are only unique within one account, so clients key messages by
   mailbox id and message id together.
4. **Done 2026-11-05: attachment ingestion.** Webhook endpoint, `MAIL_SYNC` queue, sync, hourly cron. Tested
   locally with signed webhooks: first sync, new mail (PDF stored with a matching SHA-256, inline logo skipped),
   replay (no duplicates), delete (file marked deleted), and cron. Live test the same day, with a temporary
   Stalwart webhook to a tunnel (removed afterwards): real deliveries reached the API within a second, and their
   attachments landed in R2. Production set up the same day: queue `xstate-mail-sync`, all secrets, and WebHook
   `jm3h29ayaaaa` → `https://api.xstate.com/webhooks/stalwart`. Stalwart restarted, and a real delivery was accepted
   (no `telemetry.webhook-error`). Not yet seen in production: an attachment stored in R2, since production has no
   organizations yet. Purge of deleted files after 30 days added and tested locally (2026-11-05).
5. Files operations (upload, complete, get, list) and `email_send` with attachments (internal delivery).
6. Dashboard: live inbox, thread view, attachment downloads, 30 s polling and sandboxed HTML are **done
   2026-11-05** (`apps/www/public/app/mail-data.js`, `mail.js`). Left: composer uploads and sending, once
   `email_send` exists.
7. Outbound relay (SES) so mail reaches outside addresses.
8. Later: assignments, push through a Durable Object instead of the cron, search across mailboxes, agent drafts.

## Verify

- End-to-end script: create two mailboxes, send A→B with a PDF attached, and wait for ingestion. Check the PDF in
  B's folder of the organization's bucket, its `files` row, and that `files_get` returns a working URL. Also check
  the sent copy appears under A as `source = 'sent'`. Then delete the message and confirm the file is marked deleted.
- Access tests: a member can't list or download another member's personal mailbox files; a shared-mailbox member
  can; an admin can't read a personal mailbox.
- Retry test: run the same ingestion job twice and check there is still one row and one object.

## Verified claims

Checked on 2026-11-05 against the Stalwart docs, starting from the [HTTP API page](https://stalw.art/docs/http/api/).

| Claim | Verdict | Source |
| --- | --- | --- |
| `impersonate` lets requests carry any account's `accountId` through JMAP and the management API | Confirmed | [Administrators › Impersonation](https://stalw.art/docs/auth/authorization/administrator#impersonation), [Permissions](https://stalw.art/docs/auth/authorization/permissions/) |
| The System Administrator role holds `impersonate` | Confirmed | [Administrators](https://stalw.art/docs/auth/authorization/administrator#impersonation) |
| An API key acts as its account and by default has all its permissions, mail included | Confirmed | [API keys](https://stalw.art/docs/auth/authentication/api-key/) |
| API keys work as `Bearer` on JMAP | Confirmed. The HTTP API page only mentions OAuth tokens for Bearer, but the API keys page says keys work there too. | [API keys](https://stalw.art/docs/auth/authentication/api-key/) |
| API keys can't do master-user sign-in | Confirmed | [API keys](https://stalw.art/docs/auth/authentication/api-key/) |
| Admins can create a key for another account with `x:ApiKey/set` + `accountId` (needs `impersonate` and `sysApiKeyCreate`) | Confirmed | [API keys](https://stalw.art/docs/auth/authentication/api-key/) |
| Administrator roles hold no protocol permissions themselves; admins get them through the User role | Confirmed. This is why step 1 checks the admin account can make mail calls. | [Permissions](https://stalw.art/docs/auth/authorization/permissions/) |
| Stalwart supports `jmap:mail`, `jmap:submission` and `jmap:blob` | Confirmed | [JMAP capabilities](https://stalw.art/docs/http/jmap/capabilities/) |
| Upload and download URLs are `/jmap/upload/<accountId>/` and `/jmap/download/<accountId>/<blobId>/<name>/`; push is `/jmap/eventsource` | Confirmed | [JMAP overview](https://stalw.art/docs/http/jmap/), [Push](https://stalw.art/docs/http/jmap/push/) |
| `maxUploadSize` defaults to 50 MB; `maxRequestSize` to 10 MB | Confirmed | [JMAP limits](https://stalw.art/docs/http/jmap/protocol/) |
| `emailSend` covers sending through SMTP or JMAP | Confirmed | [Permissions](https://stalw.art/docs/auth/authorization/permissions/) |
| Raw messages and their attachments live in the blob store, keyed by a BLAKE3 hash of the content, deduplicated and compressed | Confirmed | [Blob store](https://stalw.art/docs/storage/blob) |
| The S3 blob store (R2 supported) writes to one bucket; only a fixed `keyPrefix` splits it | Confirmed | [S3 backend](https://stalw.art/docs/storage/backends/s3) |
| Changing the blob store doesn't move existing blobs; it takes effect after a restart; moving data needs export and import with the server stopped | Confirmed | [Blob store](https://stalw.art/docs/storage/blob), [Migration](https://stalw.art/docs/management/maintenance/migration) |
| S3 blob store fields and defaults (`timeout` 30000 ms, `maxRetries` 3, `verifyAfterWrite` true); R2 doesn't need `verifyAfterWrite` | Confirmed | [S3 backend](https://stalw.art/docs/storage/backends/s3), [BlobStore object](https://stalw.art/docs/ref/object/blob-store) |
| MTA hooks get the whole message at DATA, can replace the body, and by default defer mail when the hook fails | Confirmed. The docs only describe hooks during SMTP sessions, so it's not stated whether JMAP-submitted mail passes through them. | [MTA hooks](https://stalw.art/docs/mta/filter/mtahooks), [MtaHook object](https://stalw.art/docs/ref/object/mta-hook) |
| JMAP mail `accountId` equals the `x:Account` id, and the admin key can read, send and delete mail in any account | Not documented, but tested 2026-11-05: `Email/query`, `Email/get`, `Email/set`, `EmailSubmission/set` and `/jmap/upload` and `/jmap/download` all worked with the admin key and `accountId` = `stalwart_id` | |
| One JMAP request can call several `accountId`s; `$seen` and `$flagged` keywords | From the JMAP RFCs ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620), [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621)), not Stalwart's docs. Step 1 checks it. | |
| Port 25 blocked, default PTR | From our server notes, not Stalwart's docs | |
| R2: 100,000 buckets per account by default (can be raised); 50 bucket operations per second | Confirmed | [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) |
| Worker bindings are fixed at deploy time | The docs imply it: a binding is "defined in the Wrangler file". Hence the S3 API for buckets made at runtime. | [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/) |

One correction for `docs/stalwart-api.md`: it says an API key "only works for the management API, not IMAP/SMTP".
The current API keys page says keys also work on IMAP, POP3, SMTP and ManageSieve through `OAUTHBEARER` or
`XOAUTH2` over TLS, and on JMAP.
