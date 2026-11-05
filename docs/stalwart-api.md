# Stalwart management API for xstate

How xstate talks to the Stalwart mail server (v1.0.2 at `https://mx.xstate.com`) to add domains and manage mailboxes.

Source: Stalwart docs — [HTTP API](https://stalw.art/docs/http/api), [Domain object](https://stalw.art/docs/ref/object/domain/), [Account object](https://stalw.art/docs/ref/object/account/), [Managing accounts](https://stalw.art/docs/auth/accounts/manage/), [API keys](https://stalw.art/docs/auth/authentication/api-key/).

> Status: domain add/enable/DNS/remove, mailbox create (User and Group), password reset, aliases, display name, quota and
> group membership were run against mx.xstate.com on 2026-11-04 by the API's end-to-end test. Items still marked
> **(verify)** have not been tried.
>
> **List fields are objects keyed by position, not JSON arrays.** Stalwart sends and expects `credentials` and `aliases`
> as `{"0": {...}, "1": {...}}`; an empty list is `{}`. Sending `[]` fails with "Invalid value for object property".
> Sets (`memberGroupIds`) are `{"<id>": true}`.

## Basics

Stalwart 1.0 has no REST endpoints for this. All management is JMAP: one `POST` to `/jmap/` with a list of method calls.

| | |
|---|---|
| Endpoint | `POST https://mx.xstate.com/jmap/` |
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

1. Sign in to `https://mx.xstate.com` as an administrator (asif@xstate.com).
2. Go to Account → Credentials → **API Keys** and create one, e.g. "xstate backend".
3. Copy the secret. It is shown only once and stored hashed.

The key inherits the account's permissions unless you narrow it. It only works for the management API, not IMAP/SMTP. Keep it in the backend's secret store, never in the browser.

### IDs

Objects are addressed by Stalwart IDs (short strings like `d`, `jmwngjkwaaaa`), not by name. Store the ID xstate gets back from `create`, or look it up by name with `/query` (shown below).

---

## 1. Add a domain

Method: `x:Domain/set` with `create`. Needs permission `sysDomainCreate`.

```bash
curl -X POST https://mx.xstate.com/jmap/ \
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
curl -X POST https://mx.xstate.com/jmap/ \
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
