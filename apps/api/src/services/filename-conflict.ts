/**
 * Active file-name collision lookups shared by upload, move, restore and the
 * Trash bulk-restore service. Keeping this in `services/` prevents the route
 * layer from owning a rule that destructive/restore operations must agree on.
 */
export async function findActiveFileNameConflict(
  db: D1Database,
  tenantId: string,
  folderId: string | null,
  name: string,
  excludeFileId?: string
): Promise<boolean> {
  const excludeClause = excludeFileId ? 'AND id != ?' : '';
  const query =
    folderId === null
      ? `SELECT id FROM files
          WHERE tenant_id = ? AND folder_id IS NULL AND name = ?
            AND deleted_at IS NULL AND upload_state != 'failed' ${excludeClause}
          LIMIT 1`
      : `SELECT id FROM files
          WHERE tenant_id = ? AND folder_id = ? AND name = ?
            AND deleted_at IS NULL AND upload_state != 'failed' ${excludeClause}
          LIMIT 1`;
  const binds =
    folderId === null
      ? excludeFileId
        ? [tenantId, name, excludeFileId]
        : [tenantId, name]
      : excludeFileId
        ? [tenantId, folderId, name, excludeFileId]
        : [tenantId, folderId, name];
  const hit = await db.prepare(query).bind(...binds).first<{ id: string }>();
  return Boolean(hit);
}

const MAX_RESTORED_NAME_ATTEMPTS = 50;

function splitFileName(name: string): { stem: string; extension: string } {
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < name.length - 1) {
    return { stem: name.slice(0, dotIdx), extension: name.slice(dotIdx) };
  }
  return { stem: name, extension: '' };
}

/**
 * Resolve a non-conflicting name for a restored file using the same
 * `(Restored)` convention as folder restore, preserving the extension and the
 * 255-character filename bound.
 */
export async function resolveUniqueRestoredFileName(
  db: D1Database,
  tenantId: string,
  folderId: string | null,
  baseName: string
): Promise<string> {
  const { stem, extension } = splitFileName(baseName);
  for (let suffix = 1; suffix <= MAX_RESTORED_NAME_ATTEMPTS; suffix++) {
    const tag = suffix === 1 ? ' (Restored)' : ` (Restored ${suffix})`;
    const maxStemLength = Math.max(1, 255 - tag.length - extension.length);
    const candidate = `${stem.slice(0, maxStemLength)}${tag}${extension}`;
    if (
      !(await findActiveFileNameConflict(db, tenantId, folderId, candidate))
    ) {
      return candidate;
    }
  }
  const fallbackTag = ` (Restored ${crypto.randomUUID().slice(0, 6)})`;
  const maxStemLength = Math.max(1, 255 - fallbackTag.length - extension.length);
  return `${stem.slice(0, maxStemLength)}${fallbackTag}${extension}`;
}
