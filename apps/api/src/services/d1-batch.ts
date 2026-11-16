/**
 * D1 batch helpers shared by admin routes and services. The safe statement
 * ceiling keeps every generated batch well below D1's host-parameter limit.
 */
export const D1_BATCH_STATEMENTS_SAFE_LIMIT = 30;

/** Flush grouped per-entity atomic statement batches without splitting a group across chunks. */
export async function executeGroupedBatches(
  db: D1Database,
  groups: D1PreparedStatement[][]
): Promise<D1Result[]> {
  const results: D1Result[] = [];
  let current: D1PreparedStatement[] = [];
  for (const stmts of groups) {
    if (
      current.length > 0 &&
      current.length + stmts.length > D1_BATCH_STATEMENTS_SAFE_LIMIT
    ) {
      results.push(...(await db.batch(current)));
      current = [];
    }
    current.push(...stmts);
  }
  if (current.length > 0) {
    results.push(...(await db.batch(current)));
  }
  return results;
}

/** Execute a flat statement list in safe-order chunks. */
export async function executeStatementChunks(
  db: D1Database,
  statements: readonly D1PreparedStatement[]
): Promise<D1Result[]> {
  const results: D1Result[] = [];
  for (let index = 0; index < statements.length; index += D1_BATCH_STATEMENTS_SAFE_LIMIT) {
    results.push(
      ...(await db.batch(
        statements.slice(index, index + D1_BATCH_STATEMENTS_SAFE_LIMIT)
      ))
    );
  }
  return results;
}
