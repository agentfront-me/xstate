// storage_items and storage_grants: the Storage folder tree and who it's shared with. See migrations/0006_storage.sql.

export type Space = 'personal' | 'organization'
export type ItemKind = 'folder' | 'file'
export type StorageRole = 'viewer' | 'editor' | 'manager'
export type OrgAccess = 'viewer' | 'editor'

export type ItemRow = {
  id: string
  organization_id: string
  space: Space
  parent_id: string | null
  kind: ItemKind
  name: string
  owner_member_id: string | null
  org_access: OrgAccess | null
  file_id: string | null
  version: number
  size_bytes: number
  content_type: string | null
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
  trashed_at: string | null
  trashed_by: string | null
}

/** An item with the reader's own grant on it, and display names for its owner and last editor. */
export type ItemView = ItemRow & {
  grant_role: StorageRole | null
  /** How many people have a grant on this item itself (the Access column). */
  grant_count: number
  owner_name: string | null
  owner_email: string | null
  updated_by_name: string | null
  /** 1 if the item has a public link of its own. */
  has_link: number
}

/** Columns for ItemView. `?1` is the reader's user id. */
const VIEW = `
  s.*,
  (SELECT g.role FROM storage_grants g JOIN members gm ON gm.id = g.member_id
    WHERE g.item_id = s.id AND gm.user_id = ?1) AS grant_role,
  (SELECT COUNT(*) FROM storage_grants g2 WHERE g2.item_id = s.id) AS grant_count,
  EXISTS (SELECT 1 FROM storage_links l WHERE l.item_id = s.id) AS has_link,
  ou.name AS owner_name, ou.email AS owner_email,
  uu.name AS updated_by_name`

const JOINS = `
  LEFT JOIN members om ON om.id = s.owner_member_id
  LEFT JOIN users ou ON ou.id = om.user_id
  LEFT JOIN users uu ON uu.id = s.updated_by`

/** Deepest folder nesting walked when resolving access, as a guard; moves can't make cycles. */
export const MAX_DEPTH = 64

/** The item and its ancestors, item first, as seen by `userId`. Empty if the item doesn't exist. */
export async function chain(db: D1Database, itemId: string, userId: string): Promise<(ItemView & { depth: number })[]> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT ?2, 0
         UNION ALL
         SELECT p.parent_id, up.depth + 1 FROM up JOIN storage_items p ON p.id = up.id
         WHERE p.parent_id IS NOT NULL AND up.depth < ${MAX_DEPTH}
       )
       SELECT ${VIEW}, up.depth FROM up JOIN storage_items s ON s.id = up.id ${JOINS} ORDER BY up.depth`,
    )
    .bind(userId, itemId)
    .all<ItemView & { depth: number }>()
  return results
}

/** Live (not trashed) children of a folder. */
export async function children(db: D1Database, parentId: string, userId: string): Promise<ItemView[]> {
  const { results } = await db
    .prepare(`SELECT ${VIEW} FROM storage_items s ${JOINS} WHERE s.parent_id = ?2 AND s.trashed_at IS NULL`)
    .bind(userId, parentId)
    .all<ItemView>()
  return results
}

/** Top of one person's My Files. */
export async function personalTop(db: D1Database, organizationId: string, memberId: string, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT ${VIEW} FROM storage_items s ${JOINS}
       WHERE s.organization_id = ?2 AND s.space = 'personal' AND s.parent_id IS NULL AND s.owner_member_id = ?3
         AND s.trashed_at IS NULL`,
    )
    .bind(userId, organizationId, memberId)
    .all<ItemView>()
  return results
}

/** Top of the organization space; the caller filters what the reader may see. */
export async function organizationTop(db: D1Database, organizationId: string, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT ${VIEW} FROM storage_items s ${JOINS}
       WHERE s.organization_id = ?2 AND s.space = 'organization' AND s.parent_id IS NULL AND s.trashed_at IS NULL`,
    )
    .bind(userId, organizationId)
    .all<ItemView>()
  return results
}

/**
 * Items shared with the member directly that they don't own: a grant to them, or someone's personal item opened to
 * the whole organization. The caller drops ones inside trashed folders.
 */
export async function sharedWith(db: D1Database, organizationId: string, memberId: string, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT ${VIEW} FROM storage_items s ${JOINS}
       WHERE s.organization_id = ?2 AND s.trashed_at IS NULL AND IFNULL(s.owner_member_id, '') != ?3
         AND (EXISTS (SELECT 1 FROM storage_grants g WHERE g.item_id = s.id AND g.member_id = ?3)
              OR (s.space = 'personal' AND s.org_access IS NOT NULL))
       ORDER BY s.updated_at DESC LIMIT 500`,
    )
    .bind(userId, organizationId, memberId)
    .all<ItemView>()
  return results
}

/** Trashed items the member trashed or owns, newest first. */
export async function trash(db: D1Database, organizationId: string, memberId: string, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT ${VIEW} FROM storage_items s ${JOINS}
       WHERE s.organization_id = ?2 AND s.trashed_at IS NOT NULL AND (s.trashed_by = ?1 OR s.owner_member_id = ?3)
       ORDER BY s.trashed_at DESC LIMIT 500`,
    )
    .bind(userId, organizationId, memberId)
    .all<ItemView>()
  return results
}

/** Whether a live item with this name (ignoring case) is already in the folder or at the top of the space. */
export async function nameTaken(
  db: D1Database,
  where: { organizationId: string; space: Space; parentId: string | null; ownerMemberId: string },
  name: string,
  exceptId = '',
): Promise<boolean> {
  const scope = where.parentId
    ? db.prepare(
        `SELECT 1 FROM storage_items WHERE parent_id = ? AND name = ? COLLATE NOCASE AND trashed_at IS NULL AND id != ?`,
      ).bind(where.parentId, name, exceptId)
    : where.space === 'personal'
      ? db.prepare(
          `SELECT 1 FROM storage_items WHERE organization_id = ? AND space = 'personal' AND parent_id IS NULL
             AND owner_member_id = ? AND name = ? COLLATE NOCASE AND trashed_at IS NULL AND id != ?`,
        ).bind(where.organizationId, where.ownerMemberId, name, exceptId)
      : db.prepare(
          `SELECT 1 FROM storage_items WHERE organization_id = ? AND space = 'organization' AND parent_id IS NULL
             AND name = ? COLLATE NOCASE AND trashed_at IS NULL AND id != ?`,
        ).bind(where.organizationId, name, exceptId)
  return !!(await scope.first())
}

export function insert(db: D1Database, row: Omit<ItemRow, 'trashed_at' | 'trashed_by'>): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO storage_items (id, organization_id, space, parent_id, kind, name, owner_member_id, org_access, file_id,
         version, size_bytes, content_type, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.organization_id,
      row.space,
      row.parent_id,
      row.kind,
      row.name,
      row.owner_member_id,
      row.org_access,
      row.file_id,
      row.version,
      row.size_bytes,
      row.content_type,
      row.created_by,
      row.created_at,
      row.updated_by,
      row.updated_at,
    )
}

export function rename(db: D1Database, id: string, name: string, userId: string, now: string): D1PreparedStatement {
  return db
    .prepare('UPDATE storage_items SET name = ?, updated_by = ?, updated_at = ? WHERE id = ?')
    .bind(name, userId, now, id)
}

/** Moves an item, and switches the space of everything inside it when it crosses into the other space. */
export function move(db: D1Database, id: string, to: { space: Space; parentId: string | null }, now: string) {
  return [
    db.prepare('UPDATE storage_items SET parent_id = ?, space = ?, updated_at = ? WHERE id = ?').bind(to.parentId, to.space, now, id),
    db
      .prepare(
        `WITH RECURSIVE down(id) AS (
           SELECT id FROM storage_items WHERE parent_id = ?1
           UNION ALL SELECT s.id FROM storage_items s JOIN down ON s.parent_id = down.id
         )
         UPDATE storage_items SET space = ?2 WHERE id IN (SELECT id FROM down) AND space != ?2`,
      )
      .bind(id, to.space),
  ]
}

/** Points a file item at a new current version. Only if it's still at `expectedVersion` (check `meta.changes`). */
export function setVersion(
  db: D1Database,
  id: string,
  v: { expectedVersion: number; version: number; fileId: string; size: number; contentType: string; userId: string; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE storage_items SET file_id = ?, version = ?, size_bytes = ?, content_type = ?, updated_by = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .bind(v.fileId, v.version, v.size, v.contentType, v.userId, v.now, id, v.expectedVersion)
}

export function setTrashed(db: D1Database, id: string, trashed: { at: string; by: string } | null): D1PreparedStatement {
  return db
    .prepare('UPDATE storage_items SET trashed_at = ?, trashed_by = ? WHERE id = ?')
    .bind(trashed?.at ?? null, trashed?.by ?? null, id)
}

/** Deletes items for good. Children go by cascade; the trigger marks every version's file for the purge. */
export function removeMany(db: D1Database, ids: string[]): D1PreparedStatement {
  return db.prepare('DELETE FROM storage_items WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids))
}

/** Items that have been in the trash since before `before`, oldest first. */
export async function listExpiredTrash(db: D1Database, before: string, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM storage_items WHERE trashed_at < ? ORDER BY trashed_at LIMIT ?')
    .bind(before, limit)
    .all<{ id: string }>()
  return results.map((r) => r.id)
}

// Grants

export type GrantView = { member_id: string; role: StorageRole; user_id: string; name: string | null; email: string }

export async function grants(db: D1Database, itemIds: string[]): Promise<(GrantView & { item_id: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT g.item_id, g.member_id, g.role, m.user_id, u.name, u.email FROM storage_grants g
       JOIN members m ON m.id = g.member_id JOIN users u ON u.id = m.user_id
       WHERE g.item_id IN (SELECT value FROM json_each(?)) ORDER BY g.created_at`,
    )
    .bind(JSON.stringify(itemIds))
    .all<GrantView & { item_id: string }>()
  return results
}

export function setGrant(
  db: D1Database,
  g: { itemId: string; memberId: string; role: StorageRole; userId: string; now: string },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO storage_grants (item_id, member_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (item_id, member_id) DO UPDATE SET role = excluded.role`,
    )
    .bind(g.itemId, g.memberId, g.role, g.userId, g.now)
}

export function removeGrant(db: D1Database, itemId: string, memberId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM storage_grants WHERE item_id = ? AND member_id = ?').bind(itemId, memberId)
}

export function setOrgAccess(db: D1Database, id: string, access: OrgAccess | null): D1PreparedStatement {
  return db.prepare('UPDATE storage_items SET org_access = ? WHERE id = ?').bind(access, id)
}

// Public links

export type LinkRow = { token: string; item_id: string; organization_id: string; created_by: string | null; created_at: string }

/** The public links on any of `itemIds` (an item's chain), to show which one makes it public. */
export async function links(db: D1Database, itemIds: string[]): Promise<(LinkRow & { created_by_name: string | null })[]> {
  if (!itemIds.length) return []
  const { results } = await db
    .prepare(
      `SELECT l.*, u.name AS created_by_name FROM storage_links l LEFT JOIN users u ON u.id = l.created_by
       WHERE l.item_id IN (${itemIds.map(() => '?').join(',')})`,
    )
    .bind(...itemIds)
    .all<LinkRow & { created_by_name: string | null }>()
  return results
}

export function findLink(db: D1Database, token: string): Promise<LinkRow | null> {
  return db.prepare('SELECT * FROM storage_links WHERE token = ?').bind(token).first<LinkRow>()
}

/** Adds a link unless the item has one already (two managers turning it on at once get the same link). */
export function insertLink(db: D1Database, row: LinkRow): D1PreparedStatement {
  return db
    .prepare('INSERT INTO storage_links (token, item_id, organization_id, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (item_id) DO NOTHING')
    .bind(row.token, row.item_id, row.organization_id, row.created_by, row.created_at)
}

export function removeLink(db: D1Database, itemId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM storage_links WHERE item_id = ?').bind(itemId)
}

// Members, for the share dialog

export async function organizationMembers(db: D1Database, organizationId: string) {
  const { results } = await db
    .prepare(
      `SELECT m.id, m.role, u.name, u.email FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ? ORDER BY COALESCE(u.name, u.email)`,
    )
    .bind(organizationId)
    .all<{ id: string; role: string; name: string | null; email: string }>()
  return results
}

// Usage, for the sidebar

/** Bytes and file count of live (not trashed) current versions: one person's My Files, and the team folders. */
export async function usage(db: D1Database, organizationId: string, memberId: string) {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN space = 'personal' AND top_owner = ?2 THEN size_bytes END), 0) AS personal_bytes,
         COUNT(CASE WHEN space = 'personal' AND top_owner = ?2 THEN 1 END) AS personal_files,
         COALESCE(SUM(CASE WHEN space = 'organization' THEN size_bytes END), 0) AS organization_bytes,
         COUNT(CASE WHEN space = 'organization' THEN 1 END) AS organization_files
       FROM (
         WITH RECURSIVE up(id, top, depth) AS (
           SELECT id, id, 0 FROM storage_items WHERE organization_id = ?1 AND kind = 'file' AND trashed_at IS NULL
           UNION ALL
           SELECT up.id, p.parent_id, up.depth + 1 FROM up JOIN storage_items p ON p.id = up.top
           WHERE p.parent_id IS NOT NULL AND up.depth < ${MAX_DEPTH}
         )
         SELECT f.space, f.size_bytes,
           (SELECT t.owner_member_id FROM up JOIN storage_items t ON t.id = up.top
             WHERE up.id = f.id ORDER BY up.depth DESC LIMIT 1) AS top_owner
         FROM storage_items f WHERE f.organization_id = ?1 AND f.kind = 'file' AND f.trashed_at IS NULL
       )`,
    )
    .bind(organizationId, memberId)
    .first<{ personal_bytes: number; personal_files: number; organization_bytes: number; organization_files: number }>()
  return row ?? { personal_bytes: 0, personal_files: 0, organization_bytes: 0, organization_files: 0 }
}

/** Live items in the trash that the member trashed or owns. */
export async function trashCount(db: D1Database, organizationId: string, memberId: string, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM storage_items WHERE organization_id = ? AND trashed_at IS NOT NULL
         AND (trashed_by = ? OR owner_member_id = ?)`,
    )
    .bind(organizationId, userId, memberId)
    .first<{ n: number }>()
  return row?.n ?? 0
}
