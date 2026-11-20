---
title: 'What an AI app can do with your mail, and why send is off by default'
summary: How access works when you connect Claude, Codex, Cursor or ChatGPT to xstate, and what an app can never do.
date: 2026-11-16
author: xstate
tags: [agents, mcp, security]
---

xstate runs an MCP server at `https://mcp.xstate.com/mcp`. Claude, Claude Code, Codex, Cursor, ChatGPT and any other
app that speaks remote MCP with OAuth can connect to it and work with your mail, calendar, files and contacts.

Giving an AI app your inbox is a real decision. This post explains what you choose when you connect one, what we
chose for you, and why.

## You approve every app

The first time an app connects, it sends you to xstate to sign in. Before you approve anything, xstate shows you:

- **Which app is asking.** Apps that publish their details on their own domain (Claude, ChatGPT and Cursor do) show
  that domain. Any other app shows only the name it gave, marked as unverified.
- **Where access will be sent.** If that is a program on your own computer, you get a warning. Continue only if you
  just started connecting from it.

## You choose what it may do

| Choice | Options | Starts on |
| - | - | - |
| Organization | Any you belong to | The first |
| Mailboxes | Mailboxes you can read | Your own mailbox |
| Email | Read only · Draft only · Draft and send | Draft only |
| Calendar, Storage, Contacts | Off · Read · Read and change | Read |
| Manage domains and mailboxes | Off or on, for owners and admins | Off |

The column that matters most is the last one. Every choice starts at the narrowest setting that is still useful.

## Why sending starts off

With **Draft only**, an app can read your mail, write replies and save them to Drafts. You read the draft and press
send. The app cannot send anything until you choose **Draft and send**.

We made this the default because email is written by other people. A message in your inbox can contain text meant
to talk an AI app into doing something you didn't ask for, such as forwarding an invoice or replying to someone on
your behalf. xstate tells connected apps to treat what they read as information, not instructions. But the safest
answer is that a draft hurts nobody until a person sends it.

If an app needs to send on its own, for example a support assistant that answers routine questions, turn sending on
for that app and only for the mailbox it needs.

## An app never gets more than you have

Every call an app makes is checked twice: first against your own access, then against what you chose for that app.
Mailboxes you didn't pick are out of reach, including through search. If you lose access to a mailbox, every app you
connected loses it too.

Some things are never available to a connected app, whatever you choose:

- resetting passwords
- giving people access to mailboxes
- API keys, AI provider keys and other secrets
- inviting or removing members
- public file links

## Taking access back

**Settings → Apps and API** lists every app you connected, what it may do and when it was last active.
**Disconnect** ends its access at once. Owners and admins see every app connected to the organization and can
disconnect any of them.

Connections also end on their own 30 days after their last use, so an app you tried once and forgot doesn't keep
access forever. To change what an app may do, connect it again: the new choices replace the old ones.

The full list of tools and what each one needs is in [Connect AI apps](/docs/mcp).
