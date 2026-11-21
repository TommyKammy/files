import { chunkArray } from '../../utils/batch';
import type { TrashItemRefInput, TrashItemType } from '../trash-items';
import {
  FILE_OWNER_ID_SQL,
  FOLDER_OWNER_ID_SQL,
  PERMISSION_QUERY_CHUNK,
  loadOwnerProfiles,
  summaryKey,
  type AdminTrashRefRow,
} from './shared';
import type { AdminTrashItemRef } from './types';

/**
 * Load exactly the requested tenant-scoped Trash rows and their owners. Used
 * before any write so a cross-tenant or unknown id can reject the whole request.
 */
export async function loadAdminTrashItemRefs(
  db: D1Database,
  tenantId: string,
  items: readonly TrashItemRefInput[]
): Promise<Map<string, AdminTrashItemRef>> {
  const folderIds = items
    .filter((item) => item.type === 'folder')
    .map((item) => item.id);
  const fileIds = items
    .filter((item) => item.type === 'file')
    .map((item) => item.id);
  const rows: Array<{ type: TrashItemType; row: AdminTrashRefRow }> = [];

  for (const chunk of chunkArray(folderIds, PERMISSION_QUERY_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT f.id, f.name, f.deleted_at, f.created_by, f.version,
                NULL AS current_version_num, NULL AS upload_state,
                (${FOLDER_OWNER_ID_SQL}) AS owner_id
           FROM folders f
          WHERE f.tenant_id = ? AND f.id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<AdminTrashRefRow>();
    for (const row of res.results) rows.push({ type: 'folder', row });
  }

  for (const chunk of chunkArray(fileIds, PERMISSION_QUERY_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT fl.id, fl.name, fl.deleted_at, fl.created_by,
                fl.current_version_num, fl.upload_state,
                NULL AS version,
                (${FILE_OWNER_ID_SQL}) AS owner_id
           FROM files fl
          WHERE fl.tenant_id = ? AND fl.id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<AdminTrashRefRow>();
    for (const row of res.results) rows.push({ type: 'file', row });
  }

  const profiles = await loadOwnerProfiles(
    db,
    tenantId,
    rows
      .map(({ row }) => row.owner_id ?? row.created_by)
      .filter((id): id is string => Boolean(id))
  );

  const refs = new Map<string, AdminTrashItemRef>();
  for (const { type, row } of rows) {
    const ownerId = row.owner_id ?? row.created_by;
    const profile = profiles.get(ownerId);
    refs.set(summaryKey(type, row.id), {
      type,
      id: row.id,
      name: row.name,
      ownerId,
      ownerName: profile?.name ?? '不明',
      ownerEmail: profile?.email ?? null,
      deletedAt: row.deleted_at,
      sourceVersion:
        type === 'file' ? row.current_version_num : row.version,
    });
  }
  return refs;
}
