import { Hono } from 'hono';
import { getScimContext, insertScimAuditStmt, type ScimUserDbRow } from '../../services/scim-helpers';
import { type ScimHonoEnv } from '../../types/scim';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { extractLastSyncSeq } from '../../services/sync-notifier';

export const USER_SELECT_COLUMNS =
  'id, tenant_id, idp_issuer, external_idp_id, email, display_name, department, status, created_at, updated_at';

export const scimUsersRoutes = new Hono<ScimHonoEnv>();
export async function applyUserUpdate(
  db: D1Database,
  existing: ScimUserDbRow,
  updates: {
    externalIdpId?: string | null;
    email?: string;
    displayName?: string;
    department?: string | null;
    active?: boolean;
  },
  scim: ReturnType<typeof getScimContext>,
  actorIp: string
): Promise<{ user: ScimUserDbRow; syncSeq: number | null }> {
  const nextEmail = updates.email ?? existing.email;
  const nextDisplayName = updates.displayName ?? existing.display_name;
  const nextDepartment =
    updates.department !== undefined ? updates.department : existing.department;
  const nextExternalId =
    updates.externalIdpId !== undefined ? updates.externalIdpId : existing.external_idp_id;
  const nextStatus: 'active' | 'suspended' =
    updates.active === undefined
      ? existing.status
      : updates.active
        ? 'active'
        : 'suspended';

  const nowIso = new Date().toISOString();
  const isSuspending = nextStatus === 'suspended';

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE users
            SET idp_issuer = COALESCE(idp_issuer, ?),
                external_idp_id = ?,
                email = ?,
                display_name = ?,
                department = ?,
                status = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      )
      .bind(
        scim.idpIssuer,
        nextExternalId,
        nextEmail,
        nextDisplayName,
        nextDepartment,
        nextStatus,
        nowIso,
        scim.tenantId,
        existing.id
      ),
  ];

  // Immediately revoke all active sessions whenever active=false / suspended is applied
  if (isSuspending) {
    statements.push(
      db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, scim.tenantId, existing.id)
    );
    if (existing.status !== 'suspended') {
      statements.push(
        buildSyncChangeStmt(db, {
          tenantId: scim.tenantId,
          entityType: 'user',
          entityId: existing.id,
          targetUserId: existing.id,
          action: 'user.suspended',
          payload: {
            previousStatus: existing.status,
            status: 'suspended',
            updatedAt: nowIso,
          },
          nowIso,
        })
      );
    }
  }

  statements.push(
    insertScimAuditStmt(db, {
      scim,
      actorIp,
      action:
        isSuspending && existing.status !== 'suspended'
          ? 'scim.user_suspend'
          : 'scim.user_update',
      targetType: 'user',
      targetId: existing.id,
      metadata: {
        previousStatus: existing.status,
        nextStatus,
        email: nextEmail,
      },
      nowIso,
    })
  );

  const batchResults = await db.batch(statements);

  return {
    user: {
      ...existing,
      idp_issuer: existing.idp_issuer ?? scim.idpIssuer,
      external_idp_id: nextExternalId,
      email: nextEmail,
      display_name: nextDisplayName,
      department: nextDepartment,
      status: nextStatus,
      updated_at: nowIso,
    },
    syncSeq: extractLastSyncSeq(batchResults),
  };
}

