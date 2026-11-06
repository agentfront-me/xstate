-- Public links to Storage items: "Anyone with the link can view". One link per item. Anyone holding the token can
-- view and download the item, and everything inside it if it's a folder, without signing in. Turning the link off
-- deletes the row; turning it on again makes a new token, so a URL that was turned off never works again.
-- The link stops working while the item, or a folder above it, is in the trash, and goes with the item.
CREATE TABLE storage_links (
  token            TEXT PRIMARY KEY,
  item_id          TEXT NOT NULL UNIQUE REFERENCES storage_items (id) ON DELETE CASCADE,
  organization_id  TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by       TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL
);
