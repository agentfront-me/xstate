# Stalwart management API for xstate

How xstate talks to the Stalwart mail server (v1.0.2 at `https://mx.xstate.io`) to add domains and manage mailboxes.

Source: Stalwart docs — [HTTP API](https://stalw.art/docs/http/api), [Domain object](https://stalw.art/docs/ref/object/domain/), [Account object](https://stalw.art/docs/ref/object/account/), [Managing accounts](https://stalw.art/docs/auth/accounts/manage/), [API keys](https://stalw.art/docs/auth/authentication/api-key/).

> Status: domain add/enable/DNS/remove, mailbox create (User and Group), password reset, aliases, display name, quota and
> group membership were run against mx.xstate.com (now mx.xstate.io) on 2026-11-04 by the API's end-to-end test. Items still marked
> **(verify)** have not been tried.
>
> **List fields are objects keyed by position, not JSON arrays.** Stalwart sends and expects `credentials` and `aliases`
> as `{"0": {...}, "1": {...}}`; an empty list is `{}`. Sending `[]` fails with "Invalid value for object property".
> Sets (`memberGroupIds`) are `{"<id>": true}`.

## Basics

Stalwart 1.0 has no REST endpoints for this. All management is JMAP: one `POST` to `/jmap/` with a list of method calls.

| | |
|---|---|
| Endpoint | `POST https://mx.xstate.io/jmap/` |
| Auth | `Authorization: Bearer <API key>` |
| Content-Type | `application/json` |
| `using` | `["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]` |

Every request has this shape:

```json
{
  "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
  "methodCalls": [
    ["<Method>", { ...arguments }, "c1"]
  ]
}
```

The response mirrors it: `{"methodResponses": [["<Method>", { ...result }, "c1"]]}`. A `/set` call reports per-item results in `created`, `updated`, `destroyed`, and per-item errors in `notCreated`, `notUpdated`, `notDestroyed`. The HTTP status is 200 even when an item fails, so always check those maps.

### Getting an API key

1. Sign in to `https://mx.xstate.io` as an administrator (asif@xstate.io, which also owns the API key in `STALWART_API_KEY`).
2. Go to Account → Credentials → **API Keys** and create one, e.g. "xstate backend".
3. Copy the secret. It is shown only once and stored hashed.

The key inherits the account's permissions unless you narrow it, mail access included. It works as `Bearer` on the management API and JMAP, and on IMAP, POP3, SMTP and ManageSieve through `OAUTHBEARER`/`XOAUTH2` over TLS ([API keys](https://stalw.art/docs/auth/authentication/api-key/)). An admin key can act on any account by passing its `accountId` (the `impersonate` permission). Keep it in the backend's secret store, never in the browser.

### IDs

Objects are addressed by Stalwart IDs (short strings like `d`, `jmwngjkwaaaa`), not by name. Store the ID xstate gets back from `create`, or look it up by name with `/query` (shown below).

---

## 1. Add a domain

Method: `x:Domain/set` with `create`. Needs permission `sysDomainCreate`.

```bash
curl -X POST https://mx.xstate.io/jmap/ \
  -H "Authorization: Bearer $STALWART_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
    "methodCalls": [
      ["x:Domain/set", {
        "create": {
          "new1": {
            "name": "customer.com",
            "certificateManagement": { "@type": "Manual" },
            "dnsManagement": { "@type": "Manual" },
            "subAddressing": { "@type": "Enabled" },
            "aliases": {}
          }
        }
      }, "c1"]
    ]
  }'
```

The new ID is in `methodResponses[0][1].created.new1.id`.

Defaults if omitted: `enable: true`, DKIM `Automatic` (keys are generated on create), DNS `Manual`, `allowRelaying: false`.

### Get the DNS records to show the customer

The read-only `dnsZoneFile` field holds every record the customer must add: MX, SPF, DKIM, DMARC, SRV, MTA-STS, autoconfig. This is what xstate's in-app domain verification step displays.

```json
["x:Domain/get", { "ids": ["<domainId>"], "properties": ["name", "dnsZoneFile"] }, "c1"]
```

Strip the TLSA (`_25._tcp…`) lines before showing them. They pin our certificate key, need DNSSEC, and break when certbot renews.

### Look up a domain ID by name

```json
["x:Domain/query", { "filter": { "name": "customer.com" } }, "c1"]
```

Returns `ids: [...]`.

### Remove a domain

Stalwart creates two DKIM signature objects (Ed25519 and RSA) for each domain and refuses to delete the domain while they
exist (`objectIsLinked`). Delete them first:

```json
["x:DkimSignature/query", { "filter": { "domainId": "<domainId>" } }, "c1"],
["x:DkimSignature/set", { "destroy": ["<dkimId>", "<dkimId>"] }, "c2"],
["x:Domain/set", { "destroy": ["<domainId>"] }, "c3"]
```

Stalwart also rejects domain names whose TLD isn't real (e.g. `.invalid`) with "Invalid domain name".

---

## 2. Create a mailbox

A mailbox is an `Account` of type `User`. Its address is `name@<domain name>`. Method: `x:Account/set` with `create`. Needs `sysAccountCreate`.

```bash
curl -X POST https://mx.xstate.io/jmap/ \
  -H "Authorization: Bearer $STALWART_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
    "methodCalls": [
      ["x:Account/set", {
        "create": {
          "new1": {
            "@type": "User",
            "name": "hello",
            "domainId": "<domainId>",
            "description": "Hello Inbox",
            "credentials": {
              "0": { "@type": "Password", "secret": "the-initial-password" }
            },
            "roles": { "@type": "User" },
            "quotas": {},
            "aliases": {}
          }
        }
      }, "c1"]
    ]
  }'
```

This creates `hello@customer.com`.

- `name` is the local part only, without `@domain`.
- `description` is the display name. Accounts have no separate "full name" field; the web UI's "Full Name" maps to `description`.
- `credentials`: `secret` takes a plain-text password or a supported hash. Stalwart stores it hashed.
- `roles` is `User` for a normal mailbox, `Admin` for an administrator.
- `quotas` maps quota keys to limits; `maxDiskQuota` is the storage cap in bytes. Leave it empty for no limit.
- A shared mailbox is `@type: "Group"` with the same fields minus `credentials` and `roles`. A user opens it once the
  group id is in the user's `memberGroupIds` (`{"<groupId>": true}`).

### Create the domain and its first mailbox in one request

JMAP lets one call reference an ID created earlier in the same request with `#`:

```json
"methodCalls": [
  ["x:Domain/set",  { "create": { "d1": { "name": "customer.com" } } }, "c1"],
  ["x:Account/set", { "create": { "a1": {
      "@type": "User", "name": "asif", "domainId": "#d1",
      "credentials": { "0": { "@type": "Password", "secret": "…" } }
  } } }, "c2"]
]
```

(verify) This is standard JMAP back-referencing (RFC 8620 §5.3). If Stalwart rejects `#d1` here, send the two calls separately.

---

## 3. Update a mailbox

Method: `x:Account/set` with `update`, keyed by account ID. Only the fields you send change. Needs `sysAccountUpdate`.

Find the ID first:

```json
["x:Account/query", { "filter": { "name": "hello", "domainId": "<domainId>" } }, "c1"]
```

Then update it. Common changes:

```json
["x:Account/set", { "update": { "<accountId>": {

  "description": "Support Team",

  "credentials/0/secret": "new-password",

  "aliases": {
    "0": { "name": "support", "domainId": "<domainId>", "enable": true }
  },

  "name": "team",

  "roles": { "@type": "Admin" }

} } }, "c1"]
```

Use only the lines you need:

| Field | Effect |
|---|---|
| `description` | Changes the display name. |
| `credentials/0/secret` | Resets the password. This is a JSON-pointer patch on the first credential, the same form the docs give for `stalwart-cli`. Changing a password also signs out the account's OAuth apps. |
| `aliases` | Replaces the alias list, here giving the mailbox an extra address `support@customer.com`. |
| `name` | Renames the mailbox, here to `team@customer.com`. (verify) Not covered in the docs; the web UI does it this way. |
| `roles` | Promotes the mailbox to administrator. |

Read the current state with:

```json
["x:Account/get", { "ids": ["<accountId>"] }, "c1"]
```

---

## 4. Delete a mailbox

Method: `x:Account/set` with `destroy`. Needs `sysAccountDestroy`.

```json
["x:Account/set", { "destroy": ["<accountId>"] }, "c1"]
```

Deletion is immediate and permanent on our (non-Enterprise) edition:

- **Immediately:** the account and its credentials are removed, so it can't sign in.
- **In a background task:** its mail, calendars, contacts, files, Sieve scripts and search index are deleted.

xstate should confirm with the user before calling this.

---

## 5. Read and send mail as any account

The admin key can use the standard JMAP mail methods on any account by setting `accountId` to the account's
`x:Account` id (our `mailboxes.stalwart_id`). This works because admins hold the `impersonate` permission
([Administrators](https://stalw.art/docs/auth/authorization/administrator#impersonation)). Tested 2026-11-05 with
`Email/query`, `Email/get`, `Email/set` (create, destroy), `EmailSubmission/set`, `/jmap/upload/<accountId>/` and
`/jmap/download/<accountId>/<blobId>/<name>`.

```json
{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
  "methodCalls": [
    ["Email/query", { "accountId": "<stalwart account id>", "filter": { "subject": "invoice" } }, "q"],
    ["Email/get", { "accountId": "<stalwart account id>", "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" },
      "properties": ["subject", "from", "receivedAt", "preview", "attachments"] }, "g"]
  ]
}
```

To send: upload attachments to `/jmap/upload/<accountId>/`. Create the message with `Email/set`, using the
`bodyStructure` and `bodyValues` properties, in the account's Drafts folder (`Mailbox/query` with
`filter.role = "drafts"`). Then `EmailSubmission/set` with an `identityId` from `Identity/get` and
`onSuccessUpdateEmail` to clear `$draft`. Each account already has an identity for its own address.

## 6. Where Stalwart stores mail

Since 2026-11-05, message contents (raw messages with attachments, Sieve scripts, pending uploads, spam-filter data)
live in the R2 bucket `xstate-mail-blobs` on the HireNinja Cloudflare account (location: Eastern North America),
under the prefix `mx1/`. Accounts, folders, flags and the search index stay in the Postgres data store on the server.

The `x:BlobStore` singleton:

```json
{
  "@type": "S3",
  "bucket": "xstate-mail-blobs",
  "keyPrefix": "mx1/",
  "region": { "@type": "Custom", "url": "https://99322c1871edd6eb7fba729f872c1832.r2.cloudflarestorage.com", "region": "auto" },
  "accessKeyId": { "@type": "EnvironmentVariable", "variableName": "R2_BLOBS_ACCESS_KEY_ID" },
  "secretKey": { "@type": "EnvironmentVariable", "variableName": "R2_BLOBS_SECRET_ACCESS_KEY" },
  "sessionToken": { "@type": "None" },
  "timeout": 30000,
  "maxRetries": 3,
  "allowInvalidCerts": false,
  "verifyAfterWrite": false
}
```

- **Key:** the two variables live in `/etc/stalwart/stalwart.env`, which the systemd unit loads. The R2 token is
  limited to Object Read & Write on this bucket.
- **Changing the store:** changes to the blob store take effect after `systemctl restart stalwart`, and existing
  blobs are not moved. To move a server that holds real mail, stop Stalwart and use `stalwart --export` and
  `--import` ([Migration](https://stalw.art/docs/management/maintenance/migration)). The switch on 2026-11-05 was
  done in place because the server held only test mail. The 7 messages written before it were deleted, because their
  contents stayed behind in Postgres.

## 7. Webhook: tell the API when mail arrives

One server-wide `x:WebHook` posts delivery events to the API, which queues a sync of that mailbox (copy new
attachments to R2, mark files of deleted messages). See [Webhooks](https://stalw.art/docs/telemetry/webhooks/) and
the [event reference](https://stalw.art/docs/ref/events).

- **Events:** `message-ingest.ham` (delivered), `message-ingest.spam` (delivered to Junk), and
  `message-ingest.imap-append` and `message-ingest.jmap-append` (saved by a mail app or the API, e.g. sent copies).
- **Identifying the account:** `data.accountId` is Stalwart's internal number, not the JMAP id. Convert it with
  base32, most significant symbol first, alphabet `abcdefghijklmnopqrstuvwxyz792013` (10 → `k`). See
  `apps/api/src/mailserver/stalwart/ids.ts`.
- **Signing:** `X-Signature` is base64 HMAC-SHA256 of the raw body, keyed with `STALWART_WEBHOOK_SECRET`.
- **Delivery isn't guaranteed:** undelivered events are dropped after `discardAfter`, or past a 65,536-event queue,
  and message deletions send no event. The API therefore treats a webhook only as "this mailbox changed". It reads
  `Email/changes` from the last saved state, and an hourly cron syncs every mailbox anyway.

Create it (production URL; use the same secret as the Worker's `STALWART_WEBHOOK_SECRET`):

```json
["x:WebHook/set", { "create": { "w": {
  "url": "https://api.xstate.com/webhooks/stalwart",
  "enable": true,
  "level": "info",
  "eventsPolicy": "include",
  "events": { "message-ingest.ham": true, "message-ingest.spam": true,
              "message-ingest.imap-append": true, "message-ingest.jmap-append": true },
  "signatureKey": { "@type": "Value", "secret": "<STALWART_WEBHOOK_SECRET>" },
  "throttle": 1000,
  "discardAfter": 3600000,
  "lossy": false,
  "timeout": 10000
} } }, "c1"]
```

List them with `x:WebHook/query` + `x:WebHook/get`; remove one with `x:WebHook/set` `destroy`.

**Webhook changes take effect only after `systemctl restart stalwart`.** That applies to creating, changing and
deleting one. Tested 2026-11-05: a webhook created at runtime sent nothing until the restart, then posted
`message-ingest.ham` and `message-ingest.jmap-append` within a second of delivery.

## 8. Outbound through Amazon SES

AWS blocks outbound port 25 on EC2, so Stalwart hands mail for outside addresses to Amazon SES, at
`email-smtp.us-east-2.amazonaws.com:587` (reachable from deepo). Mail between xstate addresses stays local.

- **SES (us-east-2, account 881901370832):** pay-as-you-go plan, with engagement tracking, VDM and Auto Validation
  off. Verified: xstate.com (Easy DKIM, three CNAMEs in Cloudflare) and asif@xstate.com. Production access was
  requested 2026-11-05; until it's granted, SES only delivers to verified addresses.
- **Each customer domain** must be a verified SES identity before mail from it can go through SES. To do: register
  it from the API when the domain is added, ideally reusing Stalwart's RSA DKIM key ("bring your own DKIM") so
  customers add no extra records.
- **Bounces and complaints:** SES identity notifications → SNS topic `xstate-ses-events` → `POST
  https://api.xstate.com/webhooks/ses`. The API verifies the SNS signature, accepts only topics in
  `SES_SNS_TOPIC_ARNS`, and confirms the subscription itself. It records `email_events` and suppresses
  hard-bounced addresses for everyone, and complainers for the sending organization.
- **Stalwart config (2026-11-05):**
  - Relay route `ses` (`x:MtaRoute` `jm3sqbjoaaaa`): `email-smtp.us-east-2.amazonaws.com:587` with STARTTLS. The
    user name is the SMTP user's `AKIA…` access key ID. The password is `{"@type":"EnvironmentVariable",
    "variableName":"SES_SMTP_PASSWORD"}`, from `/etc/stalwart/stalwart.env`.
  - `x:MtaOutboundStrategy` `route`: local domains → `'local'`, otherwise `'ses'` (was `'mx'`; that route is kept).
  - `x:MtaStageData` `dkimSignDomain` is now `{"match":{},"else":"false"}`: Stalwart no longer signs. SES rejects
    messages that already carry more than one `DKIM-Signature` (Stalwart added Ed25519 and RSA), and SES signs
    each message itself with the From domain's SES DKIM key, plus `d=amazonses.com`. Previous value (the default):
    `{"match":{"0":{"if":"is_local_domain(sender_domain) && !is_empty(authenticated_as)","then":"sender_domain"}},"else":"false"}`.
  - Restart Stalwart after changing any of these.
- **Every sending domain must be a verified SES identity.** SES signs with that domain's own key and refuses mail
  from unverified domains. It never signs with another domain's key.
- **Identity precedence:** an address identity (e.g. asif@xstate.com) overrides its domain's notification
  settings, so give it the same bounce and complaint topic, or don't create address identities.
- **Testing:** SES's mailbox simulator (`bounce@simulator.amazonses.com`, `complaint@simulator.amazonses.com`)
  produces real notifications without hurting reputation.

## 9. Local development

`wrangler dev` must never reach mx.xstate.io, production SES or the Cloudflare account. Domains created while
testing would otherwise be left behind there after the local D1 is wiped, which is how asdfasdf.com ended up on the
production server.

- **Local Stalwart:** `pnpm --filter @xstate/api mail:dev` runs Stalwart 1.0.2 (same as production) from
  `apps/api/.stalwart/`, set up by `apps/api/scripts/mail-dev.sh`. The first run downloads it (SHA-256 checked),
  bootstraps `mx.xstate.test`, and writes `STALWART_URL=http://localhost:18080` and a local `STALWART_API_KEY` into
  `.dev.vars`. Ports, all on 127.0.0.1: HTTP/JMAP and admin UI 18080, SMTP 2525 (inbound, no sign-in), submission
  2465, IMAP 2993. The admin password is in `.stalwart/admin.env`.
- **Nothing leaves the machine:** outbound mail goes to the `nowhere` relay (127.0.0.1:9), so it stays queued and
  eventually bounces. The spam filter is off so test mail from made-up senders reaches the inbox. A mail-sync webhook
  posts to `http://localhost:8788/webhooks/stalwart`.
- **SES:** `SES_MODE=fake` in `.dev.vars` returns made-up DKIM tokens and marks the domain ready on the next check,
  without calling AWS. `off` skips SES; `live` (the production default in `wrangler.jsonc`) is real SES.
- **DNS:** outside production, domains ending in `.test` (reserved, never registrable) skip public DNS, so
  `acme.test` passes onboarding end to end. Real domains are still checked against public DNS.
- **R2:** every organization shares the `xstate-dev` bucket (`R2_BUCKET`, ignored in production), which has CORS for
  `http://localhost:8787`. `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` come from an R2 API token with Object Read &
  Write on `xstate-dev` only, so local runs can't touch production buckets. `CLOUDFLARE_API_TOKEN` stays empty, so
  nothing creates or deletes buckets. Without the keys, file endpoints answer 503 `storage_not_configured` and mail
  sync skips attachment copying.
- **Reset:** `pnpm --filter @xstate/api mail:reset` deletes the local Stalwart's data and clears domains, mailboxes
  and mail rows from the local D1 (their Stalwart ids are gone). Users and organizations stay.

Test inbound mail with any SMTP client, e.g. `swaks --server 127.0.0.1:2525 --to dev@acme.test`.

## Permissions for xstate's API key

If you narrow the key instead of letting it inherit full admin rights, it needs:

- **Domains:** `sysDomainGet`, `sysDomainQuery`, `sysDomainCreate`, `sysDomainUpdate`, `sysDomainDestroy`
- **Accounts:** `sysAccountGet`, `sysAccountQuery`, `sysAccountCreate`, `sysAccountUpdate`, `sysAccountDestroy`

## CLI equivalents

Handy for testing from the server:

```bash
stalwart-cli create Domain --field name=customer.com
stalwart-cli query Account --where name=hello
stalwart-cli update Account <id> --field description='Support Team'
stalwart-cli delete Account --ids <id>
```
