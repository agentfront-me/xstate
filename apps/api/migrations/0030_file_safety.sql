-- File-type rules on mail attachments (src/security/attachments.ts): the verdict the mail sync reached for each
-- attachment it copied. 'ok', 'warn:<code>' (macros, a password-protected archive…) or 'blocked:<code>'.
-- Blocked attachments are never copied to R2: their row is kept with status 'deleted' so the sync doesn't try
-- them again, and the purge removes it later. NULL for rows from before this rule; the name is checked instead.
ALTER TABLE files ADD COLUMN safety TEXT;
