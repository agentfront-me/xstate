-- The mailbox store (docs/mailbox-store-plan.md, phase 1): which mailboxes have a MailboxStore object kept in step
-- with Stalwart ('shadow'), and which have their lists answered from it ('read'). 'off' for everyone until set.
ALTER TABLE mailboxes ADD COLUMN store_mode TEXT NOT NULL DEFAULT 'off' CHECK (store_mode IN ('off', 'shadow', 'read'));
