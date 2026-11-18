# Plan: managing members

Status: **approved 2026-11-18** with the recommendations in §4. **Phase 1 built and tested locally 2026-11-18**
(see "Phase 1 as built" below). Phases 2–6 not started.

This plan builds the Members screens in the Claude Design file "xstate App" (Settings → Members). It
lists what the design asks for, three changes to the design, and the work in the API and the app in the
order to build it.

---

## 1. What the design asks for

- **Members list.** Name, primary address, "· N domains", when they were last active, role, and an
  "Invite pending" badge. Shared mailboxes are listed below.
- **Add member.** Full name, mailbox (name + domain), "Also add a mailbox on" (other verified domains), role,
  and how they sign in:
  - *Email an invite* to a personal or secondary email, or
  - *Set temporary password* (generated, copyable), with an optional secondary email for resets.
- **Member detail.**
  - Role.
  - Domains: every address, which one is primary, "Make primary", remove, add another.
  - Secondary email (used for invites and password resets).
  - Password: "Set temporary password", "Email reset link".
  - Invite pending: "Resend invite".
  - Shared mailboxes: a checkbox for each.
  - Security: "2-step verification · Reset", "Sign out everywhere".
  - Suspend access: blocks sign-in and signs them out everywhere. Mail and data are kept.
  - Delete member: asks what should happen to their mail.
- **Sign-in.** Members sign in with their primary address and can send from any of their addresses.

## 2. What exists today

| Piece | Today |
|---|---|
| Sign-in identity | `users.email` (global, unique). It is also where invites go. Nothing ties it to an xstate address. |
| Invite | `POST /members/orgs/:org` with `{ email, role }` (`apps/api/src/members/service.ts`). It creates the `members` row as `invited` and a `users` row with no password. |
| Mailboxes | Created separately, from the Domains page (`DomainMailboxes` in `apps/app/src/settings/SettingsPage.tsx`). |
| Addresses | `addresses` already lets one mailbox have addresses on any of the org's domains (`db/addresses.ts`, `mailserver/aliases.ts`). |
| Shared mailbox access | `mailbox_access` with `owner`, `full` and `read`. |
| Role change, resend, cancel invite | Built. |
| Remove member | Refused with `member_has_mailbox` while they have a personal mailbox. |
| Sessions | HS256 JWTs that last 7 days (`auth/token.ts`). They can't be revoked. |
| 2-step verification, suspend, temporary password, admin password reset, last seen | Not built. |

## 3. Changes to the design

### 3.1 Extra domains are addresses on one mailbox, not separate mailboxes

The design says "Each address is its own mailbox." Instead, every extra address delivers into the member's
one mailbox, and they can send as it. Google Workspace (alias domains) and Microsoft 365 work this way.

Why:
- One person, one inbox. Search, push alerts, agents, storage use and the delete question all apply to one
  mailbox. With separate mailboxes, each of those multiplies by the number of domains.
- The schema already supports it (`addresses`), so no new mailbox kind or per-domain access rows are needed.
- Pricing counts people and gives aliases free (`docs/pricing-plan.md` §1). Separate mailboxes would blur what
  a seat is.
- Anyone who really needs a separate inbox for one domain should use a shared mailbox.

Changes to the design:
- Rename "Domains" to **Addresses**. Copy: "Mail to any of these arrives in one inbox. They sign in with the
  primary address and can send from any of them."
- Allow more than one address on the same domain (e.g. `jordan@` and `j@`).
- In Add member, rename "Also add a mailbox on" to "Also receive mail at". Change the hint to "All of these go
  to one inbox."
- "Make primary" changes the sign-in address and the default From address.
- Fix the sample data. Jordan's primary is `jordan@acme-supply.co`, which is an outside address. It should be
  their secondary email, and the primary should be on one of the org's domains.

### 3.2 Temporary passwords always need changing

- Remove the "Require a new password at first sign-in" checkbox. It is always on.
- Show the password once, when it's created. After that, "Set temporary password" makes a new one.

### 3.3 Hide 2-step verification until it exists

Hide "2-step verification · Reset" until 2-step verification is built (see `security-gaps`). Building it is a
separate project, not part of this plan.

### 3.4 Small copy fixes

- Members section subtitle: use the current wording, "Admins can also manage members, billing and secrets."
  The design leaves out members.
- The delete prompt has to cover all of the member's addresses, not just the primary.
- Shared mailboxes: add a **Full / Read only** selector next to each checked mailbox. The schema already has
  both levels.

## 4. Decisions to make before building

1. **Can a member sign in with any of their addresses, or only the primary?** Recommendation: primary only,
   as in the design. It keeps `users.email` a single value, and the sign-in screen can say "Use your primary
   address" when someone types another of their addresses.
2. **What happens to existing users who signed up with an outside email** (e.g. a Gmail address)?
   Recommendation: when the org gives them a personal mailbox, it becomes their sign-in. The old email moves
   to `recovery_email`. Members with no personal mailbox keep signing in with their own email, so owners who
   haven't set up a domain yet are unaffected.
3. **Someone in two organizations.** `users` is global, so a person's sign-in address can only belong to one
   org. Recommendation: a user may have personal mailboxes in only one org. Being invited to a second org
   without a mailbox there still works.
4. **The default when deleting.** Recommendation: "Turn into a shared mailbox", see §5.6.
5. **Is deletion immediate?** Recommendation: no. "Delete member" suspends them at once and deletes for good
   after 30 days, the same as file versions. Until then an admin can restore them.

## 5. Build plan

### Phase 1: identity and creating a member with a mailbox

Migration `0040_members.sql`:
- `users.recovery_email TEXT`: where invites and reset links go.
- `users.must_change_password INTEGER NOT NULL DEFAULT 0`.
- `users.sessions_after TEXT`: sessions issued before this time are rejected (used in phase 3).
- Extend `members.status` to `('invited', 'active', 'suspended')`. D1/SQLite needs a table rebuild to change
  the CHECK constraint.
- `members.delete_after TEXT`: set while a deletion is pending (phase 4).
- `members.last_seen_at TEXT`.

API:
- `POST /members/orgs/:org` takes, in addition to today's fields: `name`, `mailbox: { local, domainId }`,
  `alsoAt: [{ local, domainId }]`, and `signIn: { kind: 'invite', email } | { kind: 'password' }`, plus
  an optional `recoveryEmail`.
  - Checks that every address is free first, using the existing `addresses.taken`, so the call either creates
    everything or nothing.
  - Creates the user (sign-in = the primary address), the member, the personal mailbox, its addresses, and
    `mailbox_access` with `owner`.
  - `invite`: sends the invite to the recovery email. The existing invitation flow is reused.
  - `password`: returns the generated password in the response once and sets `must_change_password`. The
    member is `active` straight away.
  - Leaves out `mailbox` for "invite without a mailbox". That's today's behavior, which the migration flow
    still needs.
- The new mailbox follows the domain's `mail_path`, as `mailserver/mailboxes.ts` does today. Extra addresses
  are allowed only on domains with the same mail path as the mailbox, until Stalwart is gone. Per
  `feedback-no-stalwart-work`, nothing new goes into Stalwart. If that rule blocks a case, say so in the UI
  rather than building it in Stalwart.
- `PATCH /members/:id` also accepts `name` and `recoveryEmail`.
- `POST /members/:id/addresses`, `DELETE /members/:id/addresses/:addressId`, and
  `POST /members/:id/addresses/:addressId/primary`. Making an address primary updates `users.email` in the
  same batch. These wrap the existing alias code.
- Sign-in (`auth/service.ts` `login`): if `must_change_password` is set, it returns a short-lived
  change-password session instead of a full one.
- Accepting an invite stays the same, except that the account's email is now the mailbox address.

App:
- New `AddMemberDialog` and `MemberDialog` in `apps/app/src/settings/`, following the design. `LiveMembers`
  becomes the list with an "Add member" button. The inline invite form goes.
- The Domains page's mailbox form stops offering **Personal** (only shared and agent mailboxes), and links to
  Members.
- A change-password screen after sign-in when the server asks for one.

#### Phase 1 as built (2026-11-18)

Differences from the plan above:
- Migration `0040_members.sql` adds only `users.recovery_email` and `users.must_change_password`. The new member
  status, `sessions_after`, `delete_after` and `last_seen_at` move to the phases that use them (3 and 4), so the
  `members` table rebuild happens once, in phase 3.
- `POST /members/orgs/:org/add` (`members_add`) adds someone with a mailbox. The old invite-by-email
  (`members_invite`) stays for orgs with no verified domain and for migrations.
- Extra addresses use the existing alias endpoints (`/email/mailboxes/:id/aliases`). Making one primary is
  `POST /members/:id/addresses/:addressId/primary`, and only works for mailboxes on the new mail system.
- Aliases of mailboxes on the new mail system are no longer written to Stalwart. A switch rollback writes them
  back (`resyncStalwartAliases`).
- Temporary password sign-in: `auth_login` answers 403 `password_change_required` with a 15-minute
  `changeToken`; `POST /auth/password/change` sets the new password and returns a session. The mobile app shows
  the message and points to the web, and doesn't have the new-password screen yet.
- A member now also sees the domains of mailboxes they can open (`listDomains`). Without that, a member with no
  domain permissions didn't see their own mailbox in the mail sidebar.
- The Domains page keeps the Personal option for giving an existing member a mailbox. It now defaults to Shared
  and says to use Members for new people.

### Phase 2: passwords and reset links

- `POST /members/:id/password`: an admin sets a new temporary password. Returns it once and sets
  `must_change_password` and `sessions_after = now`.
- `POST /members/:id/reset-link`: emails a reset link to `recovery_email`. Reuse the token pattern from
  invitations (only the hash is stored, and it expires).
- Nobody can do either to the owner. Admins can't do them to other admins. Only the owner can.

### Phase 3: sign out everywhere and suspend

- `verifyToken` rejects tokens whose `iat` is before `users.sessions_after`. That needs one D1 read per request
  for the user row. Most routes already load the member, so add the column to that query rather than adding
  a new read.
- `POST /members/:id/sign-out`: sets `sessions_after = now`. It also removes their phone push registrations
  (`devices`), so a phone that was signed in stops getting mail alerts.
- `POST /members/:id/suspend` and `/restore`:
  - Suspend sets `status = 'suspended'` and `sessions_after = now`. It also revokes their API tokens (the
    existing `revokeTokensOfMember`) and connected AI apps (MCP connections).
  - Access checks (`db/members.ts` find, `mailserver/access.ts`) treat `suspended` like not a member.
  - Mail keeps arriving in their mailbox. Shared mailboxes keep working for everyone else.
  - Restore sets them back to `active`. API tokens and AI app connections stay revoked and have to be set up
    again, which is safer.
- `members.last_seen_at`: update at most once an hour per member, in the auth middleware.

### Phase 4: deleting a member

`DELETE /members/:id` takes `{ mail: 'shared' | 'transfer' | 'delete', to?: memberIds }`:
- **shared** (default): the mailbox becomes `kind = 'shared'` with all its addresses, and the chosen members
  get `full` access. Mail to their addresses keeps arriving.
- **transfer**: their mail moves into another member's mailbox, under a folder named after them. Their
  addresses become aliases of that mailbox. This is the most work, so it could come later.
- **delete**: the mailbox and all its addresses are deleted.

For every option, the member is suspended straight away and `delete_after` is set to 30 days from now. A daily
job finishes the deletion: the membership, and the user row if they have no other org. "Restore" works until
then. The list shows "Deleted · restorable until Dec 18".

The same dialog says what happens to their **files** (the owner's files move to the person deleting them, or
to an admin), their **agents** (switched off, owner moved to the person deleting them) and their
**calendar** (it goes with the mailbox).

The `member_has_mailbox` refusal is removed, because the dialog now handles the mailbox.

### Phase 5: shared mailbox access in the member dialog

- `PUT /mailboxes/:id/access/:memberId` with `{ access: 'full' | 'read' }`, and `DELETE` to remove it. Check
  whether the shared mailbox screens already have these endpoints before adding new ones.
- The member dialog shows each shared mailbox with a checkbox and Full / Read only.

### Phase 6: mobile

Mobile Settings isn't in the design yet. Once the web version ships: a read-only Members list on mobile, plus
suspend and sign out everywhere for admins. Adding members stays on the web.

## 6. Security and docs

- Each phase that changes sign-in, passwords or sessions updates `apps/web/content/docs/security.md`.
- Phase 3 closes the "no session revocation" gap. Remove it from the security gaps list once it's deployed.
- Admin actions on a member (password set, reset link, sign-out, suspend, delete, restore) are the first things
  an audit log should record. There is no audit log yet. Until there is, record each action as a structured
  log line.
- Temporary passwords go through `hashPassword` like every other password. The plain value is never stored or
  logged.

## 7. Not in this plan

- 2-step verification (its own project; the design's Reset button stays hidden until then).
- Storage limits per member (blocked on pricing limits).
- Mail forwarding to outside addresses (blocked by the SES forwarding rules in `ses-todo-later`).
- Seat billing prompts in Add member ("Adds a seat: $12 a month"). Add these once per-seat limits are built.
