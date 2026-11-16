import { chunkArray } from '../../utils/batch';

const R2_DELETE_CHUNK_SIZE = 100;

export interface FileVersionObjectRow {
  id: string;
  file_id: string;
  r2_object_key: string;
  r2_upload_id: string | null;
}

export async function selectUnreferencedR2Keys(
  db: D1Database,
  candidateVersions: ReadonlyArray<Pick<FileVersionObjectRow, 'id' | 'r2_object_key'>>
): Promise<string[]> {
  if (candidateVersions.length === 0) return [];

  const uniqueVersions = new Map<string, string>();
  for (const row of candidateVersions) {
    if (row.id && row.r2_object_key) {
      uniqueVersions.set(row.id, row.r2_object_key);
    }
  }

  const candidateCountByKey = new Map<string, number>();
  for (const key of uniqueVersions.values()) {
    candidateCountByKey.set(key, (candidateCountByKey.get(key) ?? 0) + 1);
  }

  const uniqueKeys = [...candidateCountByKey.keys()];
  const totalRefsByKey = new Map<string, number>();

  for (const keyChunk of chunkArray(uniqueKeys, 30)) {
    const placeholders = keyChunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT r2_object_key, COUNT(*) AS total_refs
           FROM file_versions
          WHERE r2_object_key IN (${placeholders})
          GROUP BY r2_object_key`
      )
      .bind(...keyChunk)
      .all<{ r2_object_key: string; total_refs: number }>();

    for (const row of res.results) {
      totalRefsByKey.set(row.r2_object_key, Number(row.total_refs ?? 0));
    }
  }

  return uniqueKeys.filter((key) => {
    const totalRefs = totalRefsByKey.get(key) ?? 0;
    const batchRefs = candidateCountByKey.get(key) ?? 0;
    return totalRefs <= batchRefs;
  });
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
