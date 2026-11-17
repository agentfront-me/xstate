-- Which side holds a mailbox's mail (docs/mailbox-store-plan.md, phase 2): 'stalwart' as today, or 'store', where
-- mail arrives through SES into the mailbox's own store (mailbox/receive.ts) and nothing syncs from Stalwart.
-- 'stalwart' for everyone until set.
ALTER TABLE mailboxes ADD COLUMN backend TEXT NOT NULL DEFAULT 'stalwart' CHECK (backend IN ('stalwart', 'store'));
