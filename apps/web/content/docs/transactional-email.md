---
title: Send transactional email
description: Send receipts, alerts and other one-to-one email from your own server, from any xstate mailbox you can send from.
---

Your server can send email from an xstate mailbox with one HTTP request. The message leaves from the same address
people already write from, so replies land in that mailbox's inbox like any other mail.

Use it for email a person is waiting for: receipts, password resets, alerts, sign-in codes, order updates. It is
not for newsletters or other bulk mail. The [limits](#limits) are the same as for mail you send by hand.

```
POST https://api.xstate.com/v1/emails
```

## 1. Create a token

1. In xstate, open **Settings → Apps and API → Personal tokens** and click **Create token**.
2. Give it a name, such as "Billing server", and choose the mailboxes it may send from. You can pick any mailbox
   you can send from yourself: your own, or a shared one such as `billing@` you have full access to.
3. Choose when it ends: never, or in 30 days, 90 days or 1 year.
4. Copy the token. It starts with `xst_live_` and is shown this once. xstate keeps only a hash of it, so nobody
   can show it to you again. If you lose it, create a new one.

A token is yours. It sends as you, and it can never do more than you can. See [Tokens](#tokens).

## 2. Send an email

Send the token in the `Authorization` header and the message as JSON.

```bash
curl https://api.xstate.com/v1/emails \
  -H "Authorization: Bearer $XSTATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": { "email": "billing@acme.com", "name": "Acme Billing" },
    "to": ["ann@example.com"],
    "subject": "Your receipt",
    "html": "<p>Thanks for your order. Your total was <b>$42.00</b>.</p>"
  }'
```

In Node.js:

```js
const res = await fetch('https://api.xstate.com/v1/emails', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.XSTATE_TOKEN}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': `receipt-${order.id}`,
  },
  body: JSON.stringify({
    from: { email: 'billing@acme.com', name: 'Acme Billing' },
    to: [order.email],
    subject: 'Your receipt',
    html: `<p>Thanks for your order. Your total was <b>${order.total}</b>.</p>`,
  }),
})
const email = await res.json()
if (!res.ok) throw new Error(email.error.message)
```

In Python:

```python
import os, requests

res = requests.post(
    "https://api.xstate.com/v1/emails",
    headers={
        "Authorization": f"Bearer {os.environ['XSTATE_TOKEN']}",
        "Idempotency-Key": f"receipt-{order_id}",
    },
    json={
        "from": {"email": "billing@acme.com", "name": "Acme Billing"},
        "to": [customer_email],
        "subject": "Your receipt",
        "html": "<p>Thanks for your order.</p>",
    },
)
res.raise_for_status()
email = res.json()
```

The answer is `201` with the message as xstate recorded it:

```json
{
  "id": "em_8jnw4ta5wjaac2om7b18vp7y",
  "status": "sent",
  "from": { "email": "billing@acme.com", "name": "Acme Billing" },
  "subject": "Your receipt",
  "recipients": [
    { "email": "ann@example.com", "type": "to", "status": "sent", "detail": null, "updatedAt": "2026-11-16T13:43:53.884Z" }
  ],
  "savedToSent": false,
  "tags": {},
  "createdAt": "2026-11-16T13:43:53.845Z"
}
```

`201` means the message is on its way. Keep the `id` if you want to [check delivery](#check-delivery) later.

## Fields

An address is either a string, `"ann@example.com"`, or an object with a name, `{ "email": "ann@example.com",
"name": "Ann Lee" }`. A field xstate doesn't know is refused, so a misspelled name can't be ignored silently.

| Field | Required | What it is |
| - | - | - |
| `from` | Yes | An address of a mailbox the token was given: its main address or one of its aliases. With a name, that name is shown to the recipient. |
| `to` | Yes | 1 or more addresses. |
| `cc`, `bcc` | No | More addresses. `to`, `cc` and `bcc` together hold at most 50, each address once. |
| `subject` | Yes | Up to 998 characters. |
| `text` | One of the two | The plain-text body, up to 1 MB. Left out, it is made from `html`. |
| `html` | One of the two | The HTML body, up to 2 MB. |
| `replyTo` | No | Up to 5 addresses replies should go to instead of `from`. |
| `attachments` | No | Up to 20 files, 25 MB in total. See [Attachments](#attachments). |
| `headers` | No | Up to 20 extra headers. Only names starting with `X-`, and `List-Unsubscribe` and `List-Unsubscribe-Post`. |
| `tags` | No | Up to 10 labels of your own, such as `{ "kind": "receipt" }`. They are not sent; you can filter the [send log](#the-send-log) by them. |
| `saveToSent` | No | `true` puts a copy in the mailbox's Sent folder. Defaults to `false`. |

### Showing the message in Sent

By default nothing is added to the mailbox: a few thousand receipts would bury the conversations people have
there. The message is still recorded in the [send log](#the-send-log).

Send `"saveToSent": true` when the message is part of a conversation someone will follow in xstate. It then sits
in the Sent folder exactly like mail written by hand, and a reply appears under it.

Replies always arrive in the mailbox's inbox, whichever you choose.

### Attachments

Each file is an object with its name, its type and its content in base64:

```json
{
  "attachments": [
    { "name": "invoice.pdf", "type": "application/pdf", "content": "JVBERi0xLjQK..." },
    { "name": "logo.png", "type": "image/png", "content": "iVBORw0KGgo...", "contentId": "logo" }
  ]
}
```

Give an image a `contentId` to show it inside the HTML with `<img src="cid:logo">`. Other files appear as
attachments.

Files go through the same checks as attachments added in xstate. Programs and other
[risky file types](./security.md#attachments) are refused with `attachment_blocked`.

## Safe retries

Networks fail. If a request times out, you can't tell whether the email went out. Send an `Idempotency-Key`
header with a value that is unique to the message, such as `receipt-` and the order number, and retry with the
same key:

- The first request sends the email.
- A retry with the same key and the same body sends nothing. It returns the first answer again, with status `200`
  and the header `Idempotent-Replay: true`.
- The same key with a different body is refused with `409 idempotency_conflict`.

A key is remembered for 24 hours and can be up to 255 characters.

## Check delivery

```
GET https://api.xstate.com/v1/emails/em_8jnw4ta5wjaac2om7b18vp7y
```

It returns the same object as when you sent it, with the status of each recipient kept up to date:

| Recipient status | What it means |
| - | - |
| `queued` | Being sent right now. |
| `sent` | Handed over for delivery. Most mail stays here for a few seconds. |
| `delivered` | The recipient's mail server accepted it. Mail to another xstate address is delivered at once. |
| `bounced` | It could not be delivered. `detail` holds the reason the other server gave. |
| `complained` | The recipient marked it as spam. |
| `suppressed` | Not sent. The address bounced before, or marked your mail as spam. |

The message's own `status` sums them up: `queued`, `sent`, then `delivered` once every recipient has it.
`bounced` or `complained` when that happened for every recipient, and `partial` when it happened for some.

xstate does not track opens or clicks, and adds nothing to your email to do so.

### Suppressed addresses

xstate will not send to an address that hard-bounced before, or to someone who marked your organization's mail as
spam. Sending to them again is what gets a sender blocked.

If some recipients of a message are suppressed, the rest still get it, and the suppressed ones come back with
that status. If all of them are, or everyone in `to` is, nothing is sent and the answer is
`422 all_recipients_suppressed`.

## The send log

```
GET https://api.xstate.com/v1/emails
```

Lists what you sent through the API, newest first, as `{ "emails": [...], "nextCursor": "..." }`. A token sees
messages its owner sent from the mailboxes that token can use. Messages are kept for 30 days. The log holds the
subject, the addresses and the statuses, never the body or the attachments.

| Query | What it does |
| - | - |
| `limit` | 1 to 100 messages a page. Defaults to 25. |
| `cursor` | The `nextCursor` of the page before, to get the next one. `null` means there are no more. |
| `status` | Only messages with at least one recipient in this status, for example `status=bounced`. |
| `from` | Only messages sent from this address. |
| `tag.<name>` | Only messages with this tag, for example `tag.kind=receipt`. |

## Limits

API mail and mail sent by hand share the same limits, counted together:

| Limit | Amount |
| - | - |
| Recipients on one message | 50 |
| Attachments on one message | 20 files, 25 MB in total |
| Outside recipients per mailbox | 100 an hour, 500 a day |
| Outside recipients per organization | 400 an hour, 2,000 a day |
| Requests per token | 300 a minute |

An outside recipient is an address that isn't on xstate. Mail between xstate addresses isn't counted.

Past a sending limit the answer is `429 send_limit_reached`, with `details.retryAfter`: the number of seconds
after which there is certainly room again. Because the limits are shared, a script that uses up a mailbox's hour
also stops the people in that mailbox from sending until it has passed.

### Bounces and spam complaints

Mail you send through the API counts toward the mailbox's reputation like all its other mail. If too much of a
mailbox's recent mail bounces or is marked as spam, xstate pauses **all** sending from that mailbox: through the
API, in xstate and from mail apps. Reading mail keeps working. If it is true of the whole organization, every
mailbox is paused.

The API then answers `403 sending_suspended`, and the organization's owners and admins get an email that names
the tokens that sent from the mailbox recently. To avoid it, send only to addresses people gave you, and stop
sending to addresses that bounce.

## Errors

Every error has the same shape, with a `code` your code can check and a `message` for people:

```json
{ "error": { "code": "from_not_allowed", "message": "This token can’t send from sales@acme.com. Use an address of a mailbox the token was given." } }
```

| Status | Code | What happened, and what to do |
| - | - | - |
| 400 | `invalid_input` | A field is missing or wrong. The message says which. |
| 400 | `invalid_json` | The body isn't a JSON object. |
| 401 | `invalid_token` | The token is missing, mistyped, revoked or expired. Create a new one. |
| 403 | `from_not_allowed` | `from` isn't an address of a mailbox this token was given. |
| 403 | `no_mailboxes` | You can no longer send from any of the token's mailboxes. Get access back, or give the token another mailbox. |
| 403 | `api_tokens_disabled` | An owner or admin turned API tokens off for the organization. |
| 403 | `sending_suspended` | The mailbox or organization is paused for bounces or complaints. |
| 403 | `attachment_blocked` | An attachment is a file type xstate doesn't send. |
| 404 | `email_not_found` | No such message, or it isn't one this token can see. |
| 409 | `idempotency_conflict` | This `Idempotency-Key` was used for a different message. |
| 409 | `request_in_progress` | An earlier request with this `Idempotency-Key` is still being sent. Retry in a few seconds. |
| 413 | `attachments_too_large` | The attachments are over 25 MB in total. |
| 422 | `all_recipients_suppressed` | Every recipient is suppressed. Nothing was sent. |
| 429 | `send_limit_reached` | A sending limit was reached. Wait `details.retryAfter` seconds. |
| 429 | `rate_limited` | Too many requests. Wait a minute. |

A `5xx` answer or a timeout means xstate couldn't tell you what happened. Retry with the same `Idempotency-Key`.

## Tokens

- **Keep a token on your server.** Put it in your server's secrets or environment. Never put it in a website, a
  mobile app or a repository: anyone who has it can send email as you from its mailboxes.
- **It only sends.** A token can't read mail, and can't be used anywhere else in xstate.
- **It follows your access.** If you lose access to one of its mailboxes, the token can't send from that mailbox
  from the next request on. With no mailbox left it stops working, and starts again if access comes back.
- **It ends when you leave.** If you leave the organization or are removed, your tokens are revoked for good, and
  the owners and admins are told which ones stopped. Someone else then creates a token for the same mailbox.
- **Revoking is immediate.** Revoke a token in Settings → Apps and API → Personal tokens. You can rename a token or
  change its mailboxes there too, without changing the token itself.
- **To replace a token,** create a new one, switch your server to it, then revoke the old one.
- **Owners and admins** see every member's tokens, can revoke any of them, and can turn API tokens off for the
  whole organization. They never see a token itself.
- You get an email when a token is created on your account, and a week before one ends. You can have 20 tokens.

More on how tokens are stored and checked: [Security](./security.md#personal-api-tokens).
