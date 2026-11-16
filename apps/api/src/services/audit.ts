import type { ConditionalWriteGuard } from './statement-guard';

export interface AuditLogInput {
  tenantId: string;
  actorId: string | null;
  actorEmail: string | null;
  actorIp: string | null;
  action: string;
  targetType: string;
  targetId: string;
  classificationSnapshot?: string | null;
  status?: 'allowed' | 'blocked';
  metadata?: Record<string, unknown>;
  nowIso?: string;
}

const AUDIT_LOG_COLUMNS =
  'id, tenant_id, actor_id, actor_email, actor_ip, action, target_type, target_id, classification_snapshot, status, metadata_json, created_at';
const AUDIT_LOG_VALUES = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?';

/** Build a synchronous D1 statement to append an audit log inside `DB.batch()`. */
export function buildAuditLogStmt(
  db: D1Database,
  input: AuditLogInput,
  guard?: ConditionalWriteGuard
): D1PreparedStatement {
  const bindings: Array<string | number | null> = [
    crypto.randomUUID(),
    input.tenantId,
    input.actorId,
    input.actorEmail,
    input.actorIp,
    input.action,
    input.targetType,
    input.targetId,
    input.classificationSnapshot ?? null,
    input.status ?? 'allowed',
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.nowIso ?? new Date().toISOString(),
  ];

  if (!guard) {
    return db
      .prepare(`INSERT INTO audit_logs (${AUDIT_LOG_COLUMNS}) VALUES (${AUDIT_LOG_VALUES})`)
      .bind(...bindings);
  }

  return db
    .prepare(
      `INSERT INTO audit_logs (${AUDIT_LOG_COLUMNS})
       SELECT ${AUDIT_LOG_VALUES}
        WHERE ${guard.sql}`
    )
    .bind(...bindings, ...(guard.bindings ?? []));
}
