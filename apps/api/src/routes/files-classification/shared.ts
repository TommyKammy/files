import type { ClassificationLabel } from '../../types/api';

export const ASSIGNABLE_CLASSIFICATIONS = new Set<ClassificationLabel>([
  'confidential',
  'internal',
  'public',
]);

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

