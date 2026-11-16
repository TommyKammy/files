import { chunkArray } from '../../utils/batch';
import { selectUnreferencedR2Keys } from '../../services/r2-gc';

export { selectUnreferencedR2Keys } from '../../services/r2-gc';

const R2_DELETE_CHUNK_SIZE = 100;

export interface FileVersionObjectRow {
  id: string;
  file_id: string;
  r2_object_key: string;
  r2_upload_id: string | null;
}

export async function deleteR2ObjectsAndAbortMultipart(
  db: D1Database,
  bucket: R2Bucket,
  objects: ReadonlyArray<FileVersionObjectRow>
): Promise<void> {
  if (objects.length === 0) return;

  const deletableKeys = await selectUnreferencedR2Keys(db, objects);
  const deletableKeySet = new Set(deletableKeys);

  for (const obj of objects) {
    if (obj.r2_upload_id && deletableKeySet.has(obj.r2_object_key)) {
      try {
        await bucket.resumeMultipartUpload(obj.r2_object_key, obj.r2_upload_id).abort();
      } catch {
        // Upload may already be completed/aborted; proceed to object deletion
      }
    }
  }

  for (const keyChunk of chunkArray(deletableKeys, R2_DELETE_CHUNK_SIZE)) {
    await bucket.delete(keyChunk);
  }
}

export function buildInClauseDeleteStmts(
  db: D1Database,
  table: string,
  column: string,
  ids: readonly string[],
  extraWhere = ''
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const chunk of chunkArray(ids, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const whereClause = extraWhere
      ? `${extraWhere} AND ${column} IN (${placeholders})`
      : `${column} IN (${placeholders})`;
    stmts.push(db.prepare(`DELETE FROM ${table} WHERE ${whereClause}`).bind(...chunk));
  }
  return stmts;
}

export async function fetchVersionObjectsForFiles(
  db: D1Database,
  fileIds: readonly string[]
): Promise<FileVersionObjectRow[]> {
  const rows: FileVersionObjectRow[] = [];
  for (const chunk of chunkArray(fileIds, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT id, file_id, r2_object_key, r2_upload_id
           FROM file_versions
          WHERE file_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<FileVersionObjectRow>();
    rows.push(...res.results);
  }
  return rows;
}
