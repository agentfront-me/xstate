---
title: Privacy Policy
description: What data xstate collects, why, who we share it with, and the choices you have.
---

**Last updated:** November 11, 2026

This policy explains how **HireNinja LLC** ("xstate", "we", "us") handles personal data when you use
xstate.com, go.xstate.com, api.xstate.com, the xstate mobile and desktop apps, and the related services (the
"Service"). Capitalized terms not defined here have the meaning in our [Terms of Service](./terms.md).

**The short version**

- Your email, files and contacts are yours. We process them to run the Service for you.
- We don't sell personal data, we don't show ads, and we don't use your content to train AI models.
- We don't add tracking pixels or rewrite links in the email you send.
- When you run an AI agent, the data it needs goes to the AI provider your organization chose, using your
  organization's own key.

## 1. Our two roles

- **Controller.** For account data, billing data, and data about how you use the Service, we decide how it is
  used. This policy covers that data directly.
- **Processor / service provider.** For Your Content (email, files, contacts, audience data about your
  website visitors, agent data), we process data on behalf of the organization that owns the account. That
  organization is the controller and decides what is collected and why. If you are, for example, a person who
  emailed an xstate customer or visited their website, please contact that organization about your data. We
  will help them answer your request.

## 2. What we collect

### Data you give us

- **Account data:** name, email address, password (stored only as a hash), profile photo, organization name,
  role and membership.
- **Domain data:** domains you connect, DNS records and verification status.
- **Billing data (paid plans):** billing name, address, plan and payment history. Card details are handled by our
  payment processor, Stripe; we don't store full card numbers.
- **Support:** messages you send us and the details you include.

### Your Content

- **Email:** messages, attachments, folders, labels and mail settings for mailboxes on your domains, including
  mail other people send you and mail you send them, with the headers and metadata email needs (sender,
  recipients, dates, IP addresses in headers).
- **Storage:** files, folders, file versions, sharing settings and public links.
- **Contacts and audience:** contacts your members add or import, and people, leads, events and attributes
  your organization collects about its website visitors and customers through our snippet or API.
- **Agents:** agent instructions, triggers, run history, inputs and outputs, approvals, memory, connector
  settings, and encrypted AI provider keys and secrets.
- **Imports:** data copied from another provider you import from (for example, Google Workspace): users,
  groups, mail, contacts, Drive files and sharing settings.

### Data we collect automatically

- **Usage and log data:** IP address, browser and device type, operating system, pages and API endpoints used,
  timestamps, errors, and security events such as sign-ins.
- **Mail delivery data:** delivery, bounce and complaint notifications for mail sent through the Service.
- **Mobile apps:** device push token, app version and device platform, to send notifications you turned on.
  Lists you have opened may be cached on your device so the app works offline; that cache stays on your device.
- **Local storage and cookies:** we use your browser's local storage and strictly necessary cookies to keep
  you signed in and remember preferences. We don't use advertising cookies or cross-site tracking.

### Data from third parties

- **Sign in with Google:** your name, email address and profile photo, if you choose this sign-in option.
- **Imports from Google Workspace:** see section 5.

## 3. How we use data

| Purpose | Data | Legal basis (EU/UK) |
| --- | --- | --- |
| Provide the Service: deliver and store mail, host files, run agents, search, sync apps | Account data, Your Content | Contract |
| Index your mail and files so you and your agents can search them | Your Content | Contract |
| Keep the Service secure, stop spam, abuse and fraud, enforce sending limits | Account, usage, log and delivery data; message metadata | Legitimate interests; legal obligation |
| Send service messages: invitations, security alerts, import status, billing notices | Account data | Contract |
| Send push notifications you enable | Push token, notification content | Consent (you can turn it off at any time) |
| Bill for paid plans | Billing data | Contract; legal obligation |
| Support and troubleshooting | Account data, support messages, and Your Content only when you ask us to look | Contract; legitimate interests |
| Improve the Service using aggregated, de-identified usage data | Usage data | Legitimate interests |
| Comply with the law and respond to valid legal requests | Any, as required | Legal obligation |

We do not use Your Content for advertising, profiling, or to train AI models. Our staff do not read Your Content
except when you ask us to (for example, for support), when needed to investigate abuse or security issues, or
when the law requires it. Automated systems scan mail for spam and malware.

## 4. AI agents and search

- **Search.** To power search, we create text embeddings of your files and email bodies using an AI model
  that runs on our own cloud infrastructure (Cloudflare Workers AI). The embeddings are stored separately for
  each organization and are deleted when the source item is deleted.
- **Agents.** Agents use AI providers your organization chooses, such as Anthropic or OpenAI, with your
  organization's own API key. When an agent runs, we send that provider the agent's instructions and the data
  the agent reads (for example, an email it is replying to). The provider processes it under its agreement with
  your organization. Agents can only reach data and tools your organization allows.
- **Connectors.** If your organization connects an agent to another service (for example, an MCP server), the
  data the agent sends to or receives from that service is governed by that service's own privacy policy.

## 5. Google user data

If you sign in with Google or import from Google Workspace, we access Google user data only as described here.

- **Sign-in:** we receive your basic profile (name, email, photo) to create and sign in to your account.
- **Workspace import:** with an administrator's authorization (domain-wide delegation), we read the
  organization's users and groups, usage reports for sizing, Gmail messages and labels, contacts, and Google
  Drive files and their sharing settings, only to copy them into the organization's xstate account and to keep
  that copy up to date until the switch-over is finished.
- We store imported data as part of Your Content and handle it under this policy. Working records used to track
  the import are deleted 30 days after an import finishes, or 90 days after it is cancelled.
- Our use and transfer of information received from Google APIs adheres to the
  [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
  including the Limited Use requirements. We do not use Google user data for advertising, we do not sell it, we
  do not use it to train AI models, and people at xstate do not read it except with your consent, for security
  purposes, or to comply with the law.
- Administrators can revoke our access at any time in the Google Admin console.

## 6. Who we share data with

We share personal data only as described here:

- **Service providers (subprocessors)** that run parts of the Service for us, under contracts that limit their
  use of the data:

  | Provider | Purpose |
  | --- | --- |
  | Cloudflare, Inc. | Hosting, databases, file storage, queues, search indexing, AI embeddings, DNS and network security |
  | Amazon Web Services, Inc. | Hosting the mail servers that store and deliver mailboxes; delivering outgoing email (Amazon SES), bounce and complaint handling |
  | Expo (650 Industries, Inc.), Apple, Google | Delivering push notifications to the mobile apps |
  | Stripe, Inc. | Payments for paid plans |

- **Providers your organization chooses**, such as AI providers and connected services, when your organization
  configures them.
- **Other members of your organization**, according to the permissions its admins set. Shared mailboxes,
  shared files and org-wide contacts are visible to the members they are shared with. Items you share through a
  public link can be viewed by anyone with the link.
- **Email recipients and senders**, as a normal part of sending and receiving email.
- **Legal and safety:** when we believe in good faith it is required by law or a valid legal request, or needed
  to protect the rights, safety or property of our users, the public or xstate. Where allowed, we tell the
  affected organization first.
- **Business transfers:** if xstate is involved in a merger, acquisition or sale of assets, under this policy's
  protections.

We do not sell personal data, and we do not "share" it for cross-context behavioral advertising as defined by
California law.

## 7. International transfers

We and our providers process data in the United States and other countries where they operate. When we transfer
personal data from the EU, UK or Switzerland, we rely on the European Commission's Standard Contractual Clauses
(and the UK addendum) or another lawful transfer mechanism.

## 8. How long we keep data

- **Account data:** while your account exists, then deleted within 30 days after the account or organization
  is deleted, except what we must keep for legal, tax or security reasons.
- **Your Content:** until you or your organization delete it, or until the organization is deleted (then within
  30 days, after any export period described in the Terms). Deleted files sit in trash until emptied. Up to 5
  previous versions of a file are kept, each for 30 days after it was replaced.
- **Search indexes:** removed after the source item is deleted, usually within an hour.
- **Audience data:** anonymous visitors with no email address are deleted after 30 days; raw tracking events
  after about 90 days; other audience records until the organization deletes them.
- **Import records:** see section 5.
- **Logs and delivery records:** typically up to 90 days, longer when needed to investigate abuse or security
  incidents.
- **Backups:** deleted data may remain in encrypted backups for a limited time until they are overwritten.

## 9. Security

We encrypt data in transit with TLS and at rest with our providers' encryption. AI provider keys and secrets are
stored encrypted and are never shown to AI models. Access to production systems is limited to people who need it.
No method of transmission or storage is completely secure; if a breach affects your personal data, we will notify
you and the authorities as the law requires.

## 10. Your rights and choices

Depending on where you live, you may have the right to access, correct, delete or export your personal data, to
object to or restrict some processing, to withdraw consent, and to complain to your data protection authority.
California residents also have the right to know what we collect and not to be discriminated against for using
their rights.

- **In the app:** you can update your profile, export or delete content, turn off push notifications, and admins
  can delete the organization.
- **By email:** write to [hello@xstate.com](mailto:hello@xstate.com). We will verify your identity and reply within the time the law
  requires (usually one month). You can use an authorized agent where the law allows.
- **Data in someone else's xstate account:** contact that organization; we will help them respond.

## 11. Children

The Service is not directed to children under 16, and we don't knowingly collect their personal data. If you
believe a child has given us personal data, contact [hello@xstate.com](mailto:hello@xstate.com) and we will delete it.

## 12. Changes to this policy

We may update this policy. For material changes, we will notify you by email or in the app before they take
effect. The date at the top shows when it was last updated.

## 13. Contact

HireNinja LLC\
16192 Coastal Highway, Lewes, DE 19958, USA\
Privacy questions: [hello@xstate.com](mailto:hello@xstate.com)
