# Plan: managing members

Status: **approved 2026-11-18** with the recommendations in §4. **Phase 1 built and tested locally 2026-11-18**
(see "Phase 1 as built" below). **Phases 2 and 3 built and tested locally 2026-11-18**, and phases 1–3 deployed the same day. **Phases 4 and 5 built, tested and deployed 2026-11-18.** **Phase 6 (mobile) built and tested in the iOS Simulator 2026-11-18**; not yet sent as an EAS update.

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
- Plans count mailboxes (Free allows 5, personal and shared together; `docs/pricing-plan.md` §1). Separate
  mailboxes per domain would use that limit up for one person, while aliases are free.
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

#### Phase 2 as built (2026-11-18)

- `POST /members/:id/password` and `POST /members/:id/password-reset`, in `members/passwords.ts`. Migration
  `0041_password_resets.sql` holds one open link per user (hash only, 24 hours).
- A temporary password needs the person's sign-in to be an address of their mailbox in this organization. Someone
  who signs in with their own email may be in other organizations, so for them only the reset link is offered.
- Setting a temporary password for someone still invited makes them a member straight away and ends the invite.
- The link opens `go.xstate.com/reset/#token`, which sets the password and signs them in.
- Until phase 3, setting a password doesn't sign out sessions that are already open.
- There's still no "change my own password" screen for someone who is signed in. That's a small follow-up.

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

#### Phase 3 as built (2026-11-18)

- Migration `0042_member_suspension.sql`: `users.sessions_after` and `members.suspended_at`. A column, not a new
  `members.status` value. Rebuilding `members` to change its CHECK would drop a table that many others reference
  with ON DELETE CASCADE, and in SQLite that drop can delete child rows.
- `verifyToken` reads `users.sessions_after` on every request (one D1 read) and refuses tokens issued before it.
  It compares whole seconds, so a session issued in the same second as the cutoff still works.
- `POST /members/:id/sign-out`, `/suspend` and `/restore`, in `members/security.ts`. Signing out also deletes the
  user's phone registrations (`devices`).
- Suspension doesn't revoke API tokens or connected AI apps. Every operation checks membership (`db/members.ts`
  find skips suspended members), so they stop working while suspended and work again on restore. Live updates
  and phone alerts skip suspended members (`mailbox-access.ts` listToNotify).
- Sign-in is refused when every membership of the account is suspended. A temporary password and a password
  reset also end other sessions.
- Not built: `members.last_seen_at` and "Active 2 h ago" in the list.

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

#### Phase 4 as built (2026-11-18)

- Migration `0043_member_deletion.sql`: `members.delete_after`, `delete_mail`, `delete_shared_with` and
  `deleted_by`. `POST /members/:id/delete` takes `{ mail: 'shared' | 'delete', shareWith }`, in
  `members/deletion.ts`. `POST /members/:id/restore` also undoes a pending deletion.
- Deleting suspends the member, signs them out and pauses the agents they made or published.
- "Turn into a shared mailbox" makes it shared **at once**, not at the end. Personal mailboxes are readable only by
  their owner (`mailAccess`), so this is the only way the chosen people can read it during the 30 days. Restoring
  makes it personal again and removes the access that was granted for the deletion.
- That option only works for mailboxes on the new mail system. Mailboxes on the current mail server can only have
  their mail deleted.
- The hourly job (`membersHourly`) finishes deletions:
  - **Mailbox:** deleted, or the owner row dropped from the now-shared mailbox.
  - **My Files:** moved into "From <name>" in the deleter's My Files (or the owner's, if the deleter has left).
  - **Agents:** handed to that person.
  - **Membership:** removed. The account is removed too when it's in no other organization.
  - **Tokens:** their API tokens are revoked (the existing email goes to admins).
- "Move mail into another member's mailbox" isn't built.
- The old `DELETE /members/:id` stays for cancelling invites and for leaving an organization.
- To test the hourly job locally, run the `api-cron` launch config (`wrangler dev --test-scheduled`) and open
  `/__scheduled`.

### Phase 5: shared mailbox access in the member dialog

- `PUT /mailboxes/:id/access/:memberId` with `{ access: 'full' | 'read' }`, and `DELETE` to remove it. Check
  whether the shared mailbox screens already have these endpoints before adding new ones.
- The member dialog shows each shared mailbox with a checkbox and Full / Read only.

#### Phase 5 as built (2026-11-18)

- `PUT /email/mailboxes/:id/access/:memberId` takes `access: 'full' | 'read'` (default full). Granting again with
  the other level changes it. Read only is refused for mailboxes on the current mail server.
- The members list returns each member's `sharedAccess` (to themselves and to people who manage members). The
  member dialog lists the shared mailboxes with a checkbox and Full / Read only. Owners and admins see a note that
  they open every shared mailbox.
- Fix found while testing: syncing Stalwart group memberships (`stalwartIdsForMember`) now skips mailboxes on the
  new mail system. A personal mailbox turned shared by a member deletion is a Stalwart user, so Stalwart refused it
  as a group, and every later grant to people with access to it failed.

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
- Plan limits in Add member. There is no charge per person or seat. Free allows 5 mailboxes, and adding a
  member with a mailbox is refused with 402 `plan_limit` past that (`docs/billing-limits-plan.md`).

#### Phase 6 as built (2026-11-18)

- **Settings → Members (mobile):** shows Invite pending, Suspended or Being deleted, and "· N domains". Tapping
  someone opens `settings/member/[id]` with their role, status, addresses (primary marked) and shared mailboxes.
- **Owners and admins:** Sign out everywhere, Suspend access / Restore access, and Restore member while a
  deletion is pending. Each asks for confirmation first, with the same permission rules as the API.
- **Anyone:** can sign themselves out everywhere, which goes straight to sign-in.
- **Sign-in:** after a temporary password, the app shows "Choose your password" (`/auth/password/change`), like
  the web. The mobile `ApiError` now carries `details`.
- **Stays on the web:** adding people, addresses, passwords, shared mailbox access and deleting.
- **Shipping:** JavaScript only, so it ships with `eas update --channel preview`, without a new build.
- **Local testing:** the `mobile-local` launch config points the dev build at the local API.

#### Follow-up: several mailboxes per member, shared mailboxes list, giving a mailbox (2026-11-18)

Production showed the owner with four separate personal mailboxes (one per domain, made before one mailbox could
have several addresses), four shared mailboxes nobody could see from Members, and mohammad@asif.pk owned by the
owner instead of the invited Mohammad Asif.
- **All mailboxes:** the members list returns `mailboxes` (every personal mailbox, the sign-in one first) as well
  as `mailbox`, which older apps read. The web and mobile apps show all of them, and "· N domains" counts across
  them.
- **Deleting:** handles every mailbox a member owns, including restoring and finishing.
- **Shared mailboxes:** a section on the Members page, as in the design, lists each one with how many members can
  open it. Opening one sets who can open it, with Full / Read only.
- **Giving a mailbox:** `POST /email/mailboxes/:id/owner` (`email_give_mailbox`) gives a personal mailbox and its
  mail to another member, invited ones included. The member dialog offers "Give this mailbox to someone else…".
- **Not built:** merging separate mailboxes into one (moving mail between stores).


#### Follow-up: the onboarding team step (2026-11-20)

Onboarding step 4 (`apps/app/src/onboarding/TeamStep.tsx`, "Set up your team") replaces "Create your email addresses",
which made every extra address a shared mailbox and had no way to add a person:
- **Your mailbox**, then **team members** (name, mailbox name suggested from the name, an email for the invite, Member
  or Admin), then **shared mailboxes** (hello@ / support@ / sales@ / Custom).
- Teammates go through `members_add` with `signIn: 'invite'`, so each gets their own mailbox and signs in with it. Only
  invites here: a temporary password is shown once, which doesn't suit a list. Settings → Members offers it.
- Every teammate with the Member role added here gets Full access to every shared mailbox, and every shared mailbox
  added here is opened to the existing teammates. Admins open all shared mailboxes anyway.
- The step shows "N of 5 mailboxes on your plan" from `billing_usage` and stops before the API would refuse
  (`plan_limit`). The server check stays the real one.
- An invite that wasn't sent keeps the person on the step with the reason and the invite link (with Copy) on their
  row; Continue moves on. `deliver` now returns `inviteUrl` whenever the email didn't go out, production included
  (before: only outside production), so Settings → Add member shows the link too.
- A return visit shows what exists. Onboarding puts the owner's own mailbox first in its list (several personal
  mailboxes are listed by address), so "your address is …" is right.
