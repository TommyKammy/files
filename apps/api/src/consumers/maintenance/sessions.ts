const SESSION_DELETE_BATCH_SIZE = 500;
const SESSION_MAX_ROUNDS = 10;

export async function purgeExpiredOrRevokedSessions(db: D1Database, nowIso: string): Promise<number> {
  let totalDeleted = 0;
  for (let round = 0; round < SESSION_MAX_ROUNDS; round++) {
    const res = await db
      .prepare(
        `DELETE FROM sessions
          WHERE id IN (
            SELECT id FROM sessions
             WHERE expires_at <= ? OR revoked_at IS NOT NULL
             LIMIT ?
          )`
      )
      .bind(nowIso, SESSION_DELETE_BATCH_SIZE)
      .run();
    const deleted = res.meta.changes ?? 0;
    totalDeleted += deleted;
    if (deleted < SESSION_DELETE_BATCH_SIZE) break;
  }
  return totalDeleted;
}
