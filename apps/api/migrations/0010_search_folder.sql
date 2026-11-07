-- Which mail folder an indexed message is in (inbox, sent, drafts, archive, junk or trash), so a search result can
-- open the Email page on the right list. Kept fresh by mail sync as messages move. Null for files.
ALTER TABLE search_docs ADD COLUMN folder TEXT;
