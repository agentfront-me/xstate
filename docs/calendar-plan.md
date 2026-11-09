# Plan: Calendar section

Status: Phases 0 (checks), 1 (API) and 2 (UI) done 2026-11-09, uncommitted; migration 0020 must be applied
(`pnpm db:migrate:remote`) before the API is deployed. Phase 3 (invites in email) waits for approval. Each claim
about Stalwart and FullCalendar below was tested on the local stack; see [Verified claims](#verified-claims).

## Why

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

### 3. Invites

- Accept / Maybe / Decline in the event panel (`calendar_event_rsvp`).
- In the email view, a card for messages with a `text/calendar` part: parse with `CalendarEvent/parse`, show the
  event, and offer Add + RSVP (outside invites are not added on their own, see below).
- Guest suggestions from `/contacts/suggest`.

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
