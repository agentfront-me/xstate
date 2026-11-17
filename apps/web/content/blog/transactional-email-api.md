---
title: Send receipts and alerts from your own mailbox with one request
summary: The new email API sends from an address people already write to, so replies land in a real inbox.
date: 2026-11-16
author: xstate
tags: [email, api]
---

Most apps send their receipts, password resets and alerts through a separate email service, from an address like
`noreply@mail.example.com` that nobody reads. When a customer replies to a receipt, the reply goes nowhere.

xstate now has an email API. Your server can send from any mailbox you can send from, such as `billing@`, with one
HTTP request. Replies land in that mailbox's inbox like any other mail, where your team (or an agent) can answer them.

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

## Tokens that can't do more than you

To send, create a personal token in **Settings → API keys → Personal Tokens**:

- Choose which mailboxes it may send from. You can pick only mailboxes you can send from yourself.
- Choose when it ends: never, or in 30 days, 90 days or 1 year.
- Copy it once. Tokens start with `xst_live_`. xstate keeps only a hash, so nobody can show it to you again.

A token sends as you. If you lose access to a mailbox, the token loses it too.

## What it's for

Use it for email a person is waiting for: receipts, password resets, sign-in codes, alerts and order updates. It
isn't for newsletters or other bulk mail. The sending limits are the same as for mail you send by hand.

The full reference, including attachments, safe retries, delivery checks and errors, is in
[Send transactional email](/docs/transactional-email).
