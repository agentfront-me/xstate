---
title: Use your mail and calendar app
description: Read and send xstate mail in Apple Mail, Outlook, Thunderbird and phone mail apps, and see your calendars in Apple Calendar, Thunderbird and DAVx⁵.
---

You can use xstate in the mail and calendar apps you already have, as well as on the web and in the xstate mobile
app. Everything stays in step: mail you read, move or delete in one place shows the same everywhere.

| What | How | Works in |
| --- | --- | --- |
| Reading mail | IMAP | Apple Mail, Outlook, Thunderbird, the Gmail app, iPhone and Android mail apps |
| Sending mail | SMTP | The same apps, and printers, scanners and other software that sends email |
| Calendars | CalDAV | Apple Calendar (Mac, iPhone, iPad), Thunderbird, DAVx⁵ on Android |

## 1. Create an app password

Mail apps can't use your xstate sign-in, so each app gets an **app password** of its own.

1. In xstate, open **Settings → Apps and API → App passwords**.
2. Click **Create app password** and name it after the app or device, such as "iPhone Mail".
3. Copy the password. It is 16 letters, shown as four groups such as `abcd-efgh-ijkl-mnop`, and it is shown this
   once. You can type it with or without the dashes.

Create one for each app or device. Then, if you lose a phone, you revoke that one password and the others keep
working.

An app password works for **every mailbox you can open**: your own, and any shared mailbox you have access to. The
address you type as the username decides which mailbox the app opens.

## 2. Server settings

Use these in any app. Most apps fill in the rest once you give your address and the server name.

| Setting | Value |
| --- | --- |
| Incoming mail server (IMAP) | `mail.xstate.com`, port **993**, SSL/TLS |
| Outgoing mail server (SMTP) | `mail.xstate.com`, port **465**, SSL/TLS (or port **587** with STARTTLS) |
| Calendar server (CalDAV) | `mail.xstate.com` |
| Username | The mailbox's full address, such as `you@yourcompany.com` |
| Password | An app password |

## 3. Set up your app

### Apple Mail and Calendar (Mac)

1. Open **System Settings → Internet Accounts → Add Account → Add Other Account → Mail account**.
2. Enter your name, the mailbox's address and the app password, then click **Sign In**.
3. If it asks for servers, enter `mail.xstate.com` for both incoming and outgoing, with your address as the
   username.
4. For your calendars, go back to **Add Other Account**, choose **CalDAV account**, set **Account type** to
   **Manual**, and enter your address, the app password and `mail.xstate.com` as the server.

### iPhone and iPad

1. Open **Settings → Apps → Mail → Mail Accounts → Add Account → Other → Add Mail Account**.
2. Enter your name, address and app password, choose **IMAP**, and enter `mail.xstate.com` as both the incoming
   and outgoing host name, with your address as the username.
3. For calendars: **Settings → Apps → Calendar → Calendar Accounts → Add Account → Other → Add CalDAV Account**,
   with `mail.xstate.com` as the server, your address and the app password.

iPhone Mail checks for new mail on a schedule (every 15 minutes, by default) rather than at once. You can change it
in **Mail → Mail Accounts → Fetch New Data**.

### Outlook

1. Choose **Add account**, enter your address, and when asked for the account type choose **IMAP**.
2. Enter `mail.xstate.com`, port 993, SSL/TLS for incoming mail, and `mail.xstate.com`, port 465, SSL/TLS for
   outgoing mail. The password is the app password.

Outlook doesn't support CalDAV, so your xstate calendars don't appear in it. Use the xstate app or another
calendar app for them. See also [Apps that sync through the cloud](#apps-that-sync-through-the-cloud).

### Thunderbird

1. Choose **Account Settings → Account Actions → Add Mail Account**, and enter your name, address and app password.
2. Click **Configure manually** and enter the server settings above, with **Normal password** as the
   authentication method.
3. For calendars, choose **New Calendar → On the Network**, enter your address and `mail.xstate.com` as the
   location, and sign in with the app password.

### Android

- **Mail:** in the Gmail app, choose **Add another account → Other**, enter your address, choose **Personal
  (IMAP)**, and enter the app password and the server settings above. Thunderbird for Android works the same way.
- **Calendars:** install [DAVx⁵](https://www.davx5.com/), add an account with **Login with URL and user name**,
  and enter `https://mail.xstate.com`, your address and the app password. Your calendars then appear in the phone's
  calendar app.

## What to expect

- **New mail** reaches desktop apps within seconds. Phone apps check on their own schedule.
- **Deleting** a message moves it to Trash, where it stays 30 days, as in the xstate app. Deleting it from Trash
  removes it for good.
- **Drafts** you save in your app appear in Drafts in xstate too.
- **Sent mail** is saved to Sent once, whether or not your app also saves a copy.
- **Junk:** marking a message as junk, or not junk, in your app teaches xstate's spam filter, the same as the
  buttons in xstate.
- **Folders** you create, rename or delete in your app do the same in xstate. The built-in folders (Inbox, Sent,
  Drafts, Archive, Junk, Trash) can't be renamed or deleted.
- **Invitations:** when you add guests to an event in your calendar app, xstate emails the invitations, updates
  and cancellations for you, from your address.
- **Shared mailboxes** are added as an account of their own, with the shared address as the username and your own
  app password. A shared mailbox you can only read opens read-only: you can read its mail, but not change it or
  send from it.

## Limits

- Sending from a mail app has the same limits as sending from xstate: up to **50 recipients** a message, up to
  **25 MB** of attachments, and your plan's sending limits. For larger files, share a link from Storage.
- A message saved into a folder from your app counts toward your organization's storage.
- **Apple Calendar can't create a new calendar** from inside the app. Create it in xstate and it appears in Apple
  Calendar on its next sync. Thunderbird and DAVx⁵ can create calendars.

## Apps that sync through the cloud

Some apps don't connect from your device but from their maker's servers. The new Outlook for Windows and Outlook on
phones do this: Microsoft's servers sign in to xstate with your app password and keep a copy of your mail. That is
between you and Microsoft, under their terms. If your organization doesn't allow it, an owner or admin can turn mail
apps off (see below), or you can use Thunderbird, Apple Mail or the xstate app instead.

## Security and control

- **Only hashes** of app passwords are stored. Each sign-in checks your access at that moment: if a shared mailbox
  is taken away from you, or you leave the organization, your apps lose it on their next sign-in.
- **Revoke** an app password in **Settings → Apps and API → App passwords**. The app using it is refused from its
  next sign-in (calendar apps within 5 minutes).
- **Owners and admins** see everyone's app passwords, can revoke any of them, and can turn **Allow mail and
  calendar apps** off for the whole organization.
- **Sign-in tries** are limited to 10 a minute for each address, so app passwords can't be guessed.
- Connections are always encrypted. Mail passes through xstate's gateway for mail apps in memory only, and is never
  stored there. See [Security](/docs/security).

## Troubleshooting

- **"Wrong address or app password":** use the mailbox's full address as the username and an app password, not
  your xstate sign-in password. Check the app password hasn't been revoked.
- **"Mail apps are turned off for this organization":** ask an owner or admin to turn on **Allow mail and calendar
  apps**.
- **"Too many sign-in attempts":** wait a minute. An app with an old password will keep trying; update it or remove
  the account.
- **Can't send:** check the outgoing server is `mail.xstate.com` with port 465 (SSL/TLS) or 587 (STARTTLS), and
  that it uses the same address and app password. You can only send from the mailbox's own addresses.
- Still stuck? Email [hello@xstate.com](mailto:hello@xstate.com) with the app's name and the message it shows.
