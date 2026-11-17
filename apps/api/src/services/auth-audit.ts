/**
 * P12-3 / TOM-66 auth-control audit writer.
 *
 * Kept separate from `routes/auth/shared.ts` so middleware and services can
 * record blocked authentication attempts without importing the route layer
 * (which would create a middleware -> route -> middleware cycle).
 */
export async function recordAuthControlAudit(
  db: D1Database,
  params: {
    tenantId: string;
    actorId: string | null;
    actorEmail: string | null;
    actorIp: string;
    action: string;
    targetId: string;
    status: 'allowed' | 'blocked';
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action,
         target_type, target_id, status, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'auth', ?, ?, ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      params.tenantId,
      params.actorId,
      params.actorEmail,
      params.actorIp,
      params.action,
      params.targetId,
      params.status,
      JSON.stringify(params.metadata),
      new Date().toISOString()
    )
    .run();
}
