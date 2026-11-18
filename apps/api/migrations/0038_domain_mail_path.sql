-- Where a domain's mail lives (docs/mailbox-store-plan.md, phase 4): 'stalwart' as before, 'store' once its
-- mailboxes are held by the mailbox store, 'switching' while its MX moves to SES. DNS records and the switch follow it.
ALTER TABLE domains ADD COLUMN mail_path TEXT NOT NULL DEFAULT 'stalwart' CHECK (mail_path IN ('stalwart', 'switching', 'store'));

-- Domains whose addresses all belong to store-held mailboxes are on the store already (the pilot, 99events.com).
UPDATE domains SET mail_path = 'store'
 WHERE id IN (
   SELECT a.domain_id FROM addresses a JOIN mailboxes m ON m.id = a.mailbox_id
    GROUP BY a.domain_id
   HAVING COUNT(*) > 0 AND SUM(CASE WHEN m.backend = 'store' THEN 0 ELSE 1 END) = 0
 );
