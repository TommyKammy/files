import { buildAuditLogStmt } from './audit';
import type { AuthUser } from '../types/api';

/**
 * P10-2 / TOM-60 guest access auditing.
 *
 * Every read/write of shared content by an external guest is recorded as
 * `guest.access` with a stable `operation` and the guest's `externalOrg`.
 * Member traffic is ignored so the audit trail stays focused on external risk.
 */
export function buildGuestAccessAuditStmt(
  db: D1Database,
  user: AuthUser,
  operation: string,
  targetType: string,
  targetId: string,
  nowIso = new Date().toISOString()
): D1PreparedStatement | null {
  if (user.userType !== 'guest') return null;
  return buildAuditLogStmt(db, {
    tenantId: user.tenantId,
    actorId: user.id,
    actorEmail: user.email,
    actorIp: user.ipAddress,
    action: 'guest.access',
    targetType,
    targetId,
    metadata: {
      operation,
      externalOrg: user.externalOrg ?? null,
    },
    nowIso,
  });
}

export async function recordGuestAccess(
  db: D1Database,
  user: AuthUser,
  operation: string,
  targetType: string,
  targetId: string
): Promise<void> {
  const statement = buildGuestAccessAuditStmt(
    db,
    user,
    operation,
    targetType,
    targetId
  );
  if (statement) {
    await statement.run();
  }
}
