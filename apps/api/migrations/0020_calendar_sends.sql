-- Invitation emails (invites, updates, cancellations, answers) the calendar API asked Stalwart to send. See
-- mailserver/calendar.ts and CALENDAR_LIMITS in mailserver/sending-rules.ts.
--
-- Stalwart sends one email per guest for every change, and its throttles (scripts/stalwart-limits.mjs, plus its own
-- 25 an hour from one sender to one recipient) refuse past their counts without telling the API. So the API counts
-- them here, internal guests included, and refuses first with a clear error. Pruned after two days with send_log.
CREATE TABLE calendar_sends (
  id               TEXT NOT NULL,              -- one id per change; a change emailing 5 guests writes 5 rows
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  mailbox_id       TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
  recipient        TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX calendar_sends_mailbox_idx ON calendar_sends (mailbox_id, created_at);
CREATE INDEX calendar_sends_recipient_idx ON calendar_sends (mailbox_id, recipient, created_at);
CREATE INDEX calendar_sends_id_idx ON calendar_sends (id);
