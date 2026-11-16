import { chunkArray } from '../utils/batch';

export type R2ReferenceCandidate = {
  id: string;
  r2_object_key: string;
};

/**
 * Return R2 keys from `candidateVersions` that have no references outside the
 * current deletion batch. Protects CoW-shared objects from premature deletion.
 */
export async function selectUnreferencedR2Keys(
  db: D1Database,
  candidateVersions: ReadonlyArray<R2ReferenceCandidate>
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
