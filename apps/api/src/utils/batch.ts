/** Split an array into fixed-size chunks (respecting D1 SQLite bind limits). */
export function chunkArray<T>(items: readonly T[], size = 30): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Execute D1 statements across bounded sequential `DB.batch()` calls. */
export async function executeBatchChunks(
  db: D1Database,
  statements: D1PreparedStatement[],
  batchSize = 30
): Promise<D1Result[]> {
  const results: D1Result[] = [];
  for (const chunk of chunkArray(statements, batchSize)) {
    const chunkResults = await db.batch(chunk);
    results.push(...chunkResults);
  }
  return results;
}
