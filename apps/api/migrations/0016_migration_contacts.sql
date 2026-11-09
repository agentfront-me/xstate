-- Copying contacts from Google (src/migration/contacts.ts) into the organization's AudienceStore, as contacts owned
-- by the person's member. Which contacts were copied is in the MigrationStore; these are the progress counters.

ALTER TABLE migration_users ADD COLUMN contacts_state TEXT CHECK (contacts_state IN ('copying', 'done', 'attention'));
ALTER TABLE migration_users ADD COLUMN contacts_total INTEGER;
ALTER TABLE migration_users ADD COLUMN contacts_done INTEGER NOT NULL DEFAULT 0;
-- Where the copy is: 'connections' (their contacts) then 'other' (Google's auto-saved "Other contacts"), and the
-- page token within it. JSON: {"which": "connections", "token": null}
ALTER TABLE migration_users ADD COLUMN contacts_cursor TEXT;
ALTER TABLE migration_users ADD COLUMN contacts_chain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_users ADD COLUMN contacts_note TEXT;
