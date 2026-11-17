-- The mailbox store's raw copy (docs/mailbox-store-plan.md, phase 1): for mailboxes with store_raw = 1, each raw
-- message is also copied to the organization's bucket under <mailbox id>/raw/, and the store records where each
-- attachment sits inside it. 0 for everyone until set.
ALTER TABLE mailboxes ADD COLUMN store_raw INTEGER NOT NULL DEFAULT 0;
