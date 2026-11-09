# Plan: Calendar section

Status: Phases 0–3 shipped 2026-11-09. Google Calendar in the Workspace migration built 2026-11-09, uncommitted;
migration 0021 must be applied before the API is deployed. Each claim about Stalwart and FullCalendar below was
tested on the local stack; see [Verified claims](#verified-claims).

The design ("xstate App.dc.html", Calendar page) adds a Calendar section: an Upcoming list grouped Today / Tomorrow /
date on the left, a Day / Week / Month grid with a current-time line, an all-day row and sticky day headers, and an
event panel with calendar, location, description and guests (Organizer / Accepted / Pending). Calendars are Work and
Personal. The design's "Agent schedules" calendar is left out for now.

## Decisions

- **Events live in Stalwart (JMAP Calendars), not a Durable Object.** Invites by email (iMIP), CalDAV for phones and
  desktop apps, free/busy, and cleanup on account deletion come with it. Contacts went to AudienceStore because they
  merge with audience data; calendar has no such reason.
- **Grid: FullCalendar 7** (`@fullcalendar/react` 7.x, MIT). Views are subpath imports
  (`@fullcalendar/react/daygrid`, `/timegrid`, `/interaction`); do not install the v6 `@fullcalendar/*` packages.
  Needs `temporal-polyfill`. It ships no look of its own: we style it through its `…Class` options.
- **Agents:** out of scope for this round.

## Phases

### 1. API (built)

- `mailserver/stalwart/calendar.ts`: the JMAP calls (`Calendar/get|set`, `CalendarEvent/query|get|set`).
- `mailserver/calendar-events.ts`: JSCalendar ↔ the flat event, no runtime imports; tests in
  `calendar-events.test.ts`.
- `mailserver/calendar.ts`: access (same rules as mail: a personal mailbox's calendar only for its owner), sending
  caps and suppression for invites (`reserveSend`, like `email_send`), default calendars on first open.
- `operations/calendar.ts`, under `/v1/calendar/mailboxes/:mailboxId/…`:

| Operation | Route |
|---|---|
| `calendar_list_calendars` | `GET …/calendars` |
| `calendar_list_events` | `GET …/events?from&to[&calendarId]` |
| `calendar_get_event` | `GET …/events/:eventId` |
| `calendar_create_event` | `POST …/events` |
| `calendar_update_event` | `PATCH …/events/:eventId` (scope `series` or `occurrence`) |
| `calendar_delete_event` | `DELETE …/events/:eventId[?occurrence&notify]` |
| `calendar_respond_to_event` | `POST …/events/:eventId/rsvp` |

- Event shape: `id, seriesId, occurrence, calendarId, status, title, description, location, allDay, start, end` (UTC,
  or dates with an exclusive end for all-day), `localStart, localEnd, timeZone` (as entered, for the editor),
  `repeat, guests[{email, name, organizer, optional, status}], organizer, isOrganizer, myStatus, updatedAt`.
- Updates: title, start, end, allDay and timeZone are always sent; description, location, repeat, guests and
  calendarId left out stay as they are. Removed guests get a cancellation.
- Not built (not needed by the design yet): creating, renaming or deleting calendars; RSVP to one occurrence;
  `CalendarEvent/parse` for the email invite card (Phase 3).
- Moving a series' start re-keys its per-occurrence changes and deletions (`rekeyOverrides`), and an occurrence edit
  stores its time only if the time changed, so a renamed occurrence follows the series. (Found in Phase 2: before
  this, moving the series duplicated the renamed occurrence and brought back a deleted one.)
- Expanded occurrences don't carry their series' repeat rule on Stalwart; `listEvents` and `getEvent` fill it in
  from the series (one extra get).

### 2. App UI (built)

- Rail: Calendar after Agents (`app/pages.tsx`, `ROUTED` set used by `app/Shell.tsx`); route `/calendar` in
  `app/router.tsx`, lazy-loaded (its chunk is about 101 KB gzipped, FullCalendar and temporal-polyfill included).
- `src/calendar/`: `CalendarPage` (mailbox choice, queries, sidebar, header), `CalendarGrid` (FullCalendar 7 with our
  `…Class` names), `EventPanel` (details, guests, Yes/Maybe/No, delete with "This event / All events"),
  `EventEditor` (title, all day, start/end, calendar, repeat, location, guests via `RecipientInput`, description),
  `api.ts` (live and demo sources), `format.ts`. Styles in `src/styles/calendar.css`; icons calendar, map-pin,
  align-left, repeat added to `Icon.tsx`.
- Whose calendar: the readable personal mailbox (only its owner can read it). Without one, an empty state.
- Upcoming: the next 30 days, at most 40, grouped Today / Tomorrow / date; clicking moves the grid and opens the
  event. A Calendars checklist below it shows or hides Work and Personal (remembered per browser).
- New events: "+" (next whole hour), dragging over the grid, or clicking a day in Month view.
- Demo mode (`?demo`) has a sample week in memory.
- Not built: dragging events to move or resize them; calendars of shared mailboxes.

### 3. Invites in email (built)

- API: `calendar_get_invite` (`GET …/invites/:blobId`) reads the message's text/calendar part with
  `CalendarEvent/parse` and finds your copy by UID; `calendar_apply_invite` (`POST …/invites/:blobId`, optional
  `status`) adds an invite to your default calendar, brings your copy up to date when the email is newer
  (higher `sequence`), answers the organizer, or removes your copy for a cancellation. A guest's reply is shown,
  not applied.
- App: `mail/InviteCard.tsx` above the message body: title, time, place, organizer and a line saying where things
  stand ("Not in your calendar yet", "You're going", "The organizer changed this event…", "Guest accepted",
  "Cancelled"), Yes / Maybe / No, "Add without answering", "Update my calendar", "Remove from calendar" and
  "Open in Calendar" (`/calendar?date=…&event=…`). The unnamed text/calendar copy is hidden from the file chips.
  Not shown in demo mode.
- Parsed invites have only a local time and zone, so `zonedToUtc` (Intl) gives their UTC start and end.

### 4. Google Calendar in the Workspace migration (built)

- Scope: `calendar.readonly`, shown on Connect and checked by Verify. Migrations verified before it are not blocked:
  their calendar copy stops with a note asking the admin to add the scope, and Retry carries on.
- Plan: a Calendar toggle per person, on for `create` and `existing`, off (and locked) for suspended people imported
  as shared mailboxes (Google won't act as them). Migrations planned before this keep `copy_calendar = 0`.
- Copy (`migration/calendar.ts`, job `calendar`): only calendars the person owns. The primary one goes into their
  default calendar (Work, set up like the app does), each other one into a new calendar of the same name. Per
  calendar, one listing for events and series, then one for changed or cancelled occurrences (written into
  their series' `recurrenceOverrides`), since Google may list an occurrence before its series. Claims in the
  MigrationStore (kinds `calendar`, `event`), no scheduling messages, iCalendar UIDs kept.
- Conversion (`migration/calendar-rules.ts`, tested): times stay in the event's zone; RRULE → JSCalendar
  (`byDay` with ordinals, `byMonthDay`, `byMonth`, `bySetPosition`, `count`/`until`, `firstDayOfWeek`); EXDATE →
  excluded overrides; the person's Google address(es) → their xstate address; rooms dropped; meetings over 20
  people keep the organizer and the person, then the first others, with a note in the description; working-location,
  birthday and cancelled entries skipped.
- Final pass (job `final_calendar`): each calendar's Google sync token from the copy; added events created, changed
  ones replaced (keeping per-occurrence changes), deleted ones removed. An expired token (HTTP 410) falls back to a
  full listing that never applies an older version than ours and leaves alone events deleted in xstate since.
- Progress, watchdog, skip/retry, ready email, Finish report and CSV include calendar events; Google gives no event
  count up front, so the Copying column says "N events so far".

### Later

- Settings: replace "Calendar is coming soon" with CalDAV setup (`/.well-known/caldav` → `/dav/cal`). Needs a way for
  members to get a password for apps.
- Google Calendar in the Workspace migration (`calendar.readonly` scope, `calendar` job kind, like `contacts.ts`).
- Free/busy when picking a time. Drag to create/move (FullCalendar's interaction plugin already works).

## Open points

- **Outside invites aren't added to the calendar automatically.** Locally an invite from `maria@example.org` arrived as
  mail but Stalwart didn't process it (no `calendar.itip-message-received` in the log); internal ones were. Likely
  because the sender isn't authenticated in dev (no SPF/DKIM). Check in production with a real Gmail invite; the
  email-view card covers it either way.
- **Invites to outside guests are normal outbound mail** (about 21 KB each) through SES, so they count against
  sending caps and SES sandbox limits.
- **Invitation emails are capped by the API (built 2026-11-09).** Stalwart sends one email per guest for every
  invite, update, answer and cancellation, and its throttles *drop* mail past their counts while the API reports
  success. Tested locally: with a temporary per-sender limit of 2, the third guest's invite was refused and never
  queued. The limits that apply are ours in `stalwart-limits.mjs` (40 messages an hour and 200 a day per signed-in
  sender, 150 / 800 per sending domain) and Stalwart's default "Sender address to recipient throttle" (25 an hour
  from one sender domain to one recipient), which is what held the test invites earlier. So the API now counts
  every invitation email, internal guests included, in `calendar_sends` (migration 0020) and refuses past
  `CALENDAR_LIMITS` (30 an hour and 150 a day per mailbox, 20 an hour to one recipient) with 429
  `invite_limit_reached`; outside guests still count against the email_send caps too. The editor then offers
  "Save without emailing guests" (`notify: false`). `MAX_GUESTS` is now 30, one hour's worth.
  Still open: the per-sending-domain throttle (150 an hour) isn't mirrored, and mail-app SMTP sending shares the
  same 40 an hour, so the 30 is not a guarantee. Raising the Stalwart throttles for calendar mail is the other lever.
- **Adding an outside invite must set `organizerCalendarAddress`.** Without it Stalwart makes the mailbox the
  organizer and emails the real organizer a new *invitation* (METHOD:REQUEST) instead of an answer. Tested.
- **Answering an outside invite after adding it sends nothing** when the answer is changed in place (one field,
  the whole participants map, with or without roles: all tested on 1.0.2). Creating the event with the answer does
  send a proper METHOD:REPLY. So for organizers outside xstate, `respondToEvent` quietly replaces the guest copy
  with one carrying the new answer (the event id changes); for internal organizers the in-place change works.
- **Stalwart limits (from the session's `jmap:calendars` capability):** at most 20 participants per event
  (`maxParticipantsPerEvent`; the 21st is refused) and 52 weeks and a day per expanded query
  (`maxExpandedQueryDuration`). The API now allows 19 guests (it said 30) and 365-day ranges (it said 400).
  Raising the participant limit in Stalwart's settings would allow bigger meetings.
- **`ParticipantIdentity` can't be set per member.** Under impersonation it returns the admin's identity and
  `ParticipantIdentity/set` is refused ("only in your own account"). Not a blocker: setting the organizer
  participant explicitly makes `organizerCalendarAddress` the member's address. The API must always do that.

## Verified claims

Local Stalwart 1.0.2 (same version as production), test accounts on `cut5-12880.test`, 2026-11-09. Test data deleted
afterwards.

| Claim | Result |
|---|---|
| Session advertises `jmap:calendars`, `calendars:parse`, `principals:availability` | Yes |
| Each account has a default calendar | Yes, "Stalwart Calendar (<address>)", `isDefault: true`; renamable |
| Create a second calendar | Yes; `isDefault` can't be set on create |
| Admin key reaches a member's calendar via `accountId` | Yes, same as mail |
| Events use JSCalendar 2.0 (`version: "2.0"`) | Yes: repeat is `recurrenceRule` (singular). `recurrenceRules` is silently dropped |
| `CalendarEvent/query` with `filter.after/before` + `expandRecurrences: true` | Yes. Occurrences get synthetic ids, `baseEventId`, `recurrenceId`, and `utcStart`/`utcEnd` |
| Edit / delete one occurrence | Yes, by setting the whole `recurrenceOverrides` map (`{start}` or `{excluded: true}`). A patch path into a missing map fails ("Patch operation failed") |
| All-day events | `showWithoutTime: true`, `duration: "P1D"` |
| Invite to a member (`sendSchedulingMessages: true`) | Event appears in their default calendar, a `CalendarEventNotification` is created, and an "Invitation: …" email lands in their inbox |
| RSVP back to the organizer | Attendee patches `participants/<id>/participationStatus`; the organizer's copy updates |
| Invite to an outside address | Queued as normal outbound mail (`calendar.itip-message-sent`) |
| Outside invite received by SMTP | Stored as mail only; `CalendarEvent/parse` on the `text/calendar` blob returns the event, method `request` |
| CalDAV | `/.well-known/caldav` → `/dav/cal`, requires auth |
| `recurrenceOverrides` and `utcStart`/`utcEnd` in one `CalendarEvent/get` | Refused: "cannot be requested together". Lists ask for the UTC times; one event is read with two gets in one request |
| Organizer deletes an event with guests | The guest's copy stays, with `status: "cancelled"` |
| Organizer removes every guest | Stalwart keeps a bare organizer participant; removed guests get a cancellation |
| Guests on another xstate domain (same server) | Invite, RSVP and cancellation all work |
| Invite + cancellation to one outside guest | Counted as 2 in `send_log`; the internal guest isn't counted |

Phase 1 end-to-end run (local API, two test members on different domains): 26 checks, all passing (twice; later runs
hit Stalwart's 25-an-hour per-recipient throttle, see Open points). Calendars set up,
repeating / all-day / guest events created, UTC conversion from Asia/Karachi, expanded listing, invite seen by the
guest, guest refused when editing, RSVP seen by the organizer, update without guests keeps them, `guests: []` removes
and cancels, move and delete one occurrence, 400s for bad times / unknown zone / missing zone / range over 400 days,
404 for another member's personal calendar.

FullCalendar 7.1.4 test page (React 19, Vite 8):

| Claim | Result |
|---|---|
| Day / Week / Month views | `timeGridDay`, `timeGridWeek`, `dayGridMonth` |
| Current-time line, all-day row, sticky header, opens at 8 AM | `nowIndicator`, `allDaySlot`, `tableHeaderSticky`, `scrollTime` all work |
| Short events on one line | `eventContent` gets `isShort` (threshold `eventShortHeight`) |
| Our own look | No built-in theme needed: `eventClass`, `dayLaneClass`, `slotLaneClass`, `dayCellClass`, `nowIndicatorLineClass`, … plus a 9 KB `skeleton.css` |
| Click, select, drag | `eventClick`, `select`, `eventDrop` work with the interaction plugin |
| Bundle cost | About 72 KB gzipped on top of React + temporal-polyfill |

Phase 2 in the browser (local app on the real local API, and demo mode): Work and Personal set up on first open;
event created by dragging over the grid with a weekly repeat, a location and a guest; one occurrence renamed
("This event"); one occurrence deleted; the series moved to 11 AM ("All events") with the rename kept and the
deletion still applied; Day, Week and Month views; light and dark; delete with confirmation; empty states for
no personal mailbox and no events. Bugs found and fixed on the way: a crash when dragging out a new event, the title
losing focus after a drag, Escape on a menu closing the editor, occurrences showing "Does not repeat" (and so
"All events" would have dropped the repeat rule), and the selected occurrence not highlighted after saving.

Invitation caps (local API, counts seeded in `calendar_sends`): 29 sent + an invite to 2 guests → 429 naming the
hourly cap, and the refused attempt leaves no rows; the same with `notify: false` → saved, nothing counted; 20 sent
to one person + another invite to them → 429 naming that address; an allowed invite is counted. In the app, the
editor shows the message and "Save without emailing guests", which saves the event.

Phase 3 (local API, outside invitations emailed over SMTP to a test user): 16 checks, all passing: read an invite
(method, UTC time, organizer, your pending answer); add without answering sends nothing; the invite then matches
the calendar copy; a newer email (SEQUENCE 1, moved an hour) shows as outdated, and "update + accept" moves the
event and sends Maria one METHOD:REPLY with PARTSTAT=ACCEPTED (checked in Stalwart's outbound queue) and no new
invitation; a cancellation is read and removes the copy; a guest's reply is read (who and what) and has nothing to
apply (400); answering an invite that doesn't list you → 409; a bad blob → 400. In the app: the card on a real
invitation, Yes (→ "You're going", reply queued), Open in Calendar (right day, event open, no edit for a guest),
the cancellation card with Remove from calendar, the reply card, and demo mode without the card.

Google Calendar migration (local API, fake Google Workspace, a fresh organization on a `.test` domain, calendar-only
plan for two people): Connect lists and checks the calendar scope; each person gets Work, Personal and "Team offsite";
a weekday standup series arrives with its EXDATE excluded, a cancelled occurrence excluded and a moved occurrence
(listed before its series) applied; the person's own meeting keeps its guests minus the room; an outside organizer's
invite keeps them as organizer with the person's pending answer; a 25-person all-hands is trimmed to 20 with a note;
all-day "free" and Lisbon-time events keep their zone; working-location and cancelled entries are skipped. The final
pass applied 3 changes each (one added, one renamed, one deleted). With expired sync tokens the second pass listed
everything again and changed nothing it shouldn't (two bugs found and fixed there: a deleted copy made the pass fail,
and an older Google version overwrote a newer one). Report and CSV show the events column and labelled skips.
