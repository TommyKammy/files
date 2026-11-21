import { buildSyncChangeStmt } from '../sync-changes';
import type {
  AdminRootCoOwnerStatementBundle,
  AdminRootOwnerRef,
} from './types';

/**
 * Shared co-owner grant statements. Both the single-folder API and the bulk
 * grant API use this builder, so `owner` grants are never downgraded.
 */
export function buildAdminRootCoOwnerStatements(
  db: D1Database,
  input: {
    tenantId: string;
    folderId: string;
    userIds: readonly string[];
    groupIds: readonly string[];
    grantedBy: string;
    nowIso: string;
  }
): AdminRootCoOwnerStatementBundle {
  const statements: D1PreparedStatement[] = [];
  const syncStatements: D1PreparedStatement[] = [];

  for (const [granteeType, ids] of [
    ['user', input.userIds],
    ['group', input.groupIds],
  ] as const) {
    for (const granteeId of ids) {
      statements.push(
        db
          .prepare(
            `INSERT INTO permissions (
               id, tenant_id, target_type, target_id, grantee_type, grantee_id,
               role, granted_by, created_at
             ) VALUES (?, ?, 'folder', ?, ?, ?, 'co_owner', ?, ?)
             ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
             DO UPDATE SET
               role = CASE WHEN permissions.role = 'owner' THEN 'owner' ELSE 'co_owner' END,
               granted_by = CASE WHEN permissions.role = 'owner' THEN permissions.granted_by ELSE excluded.granted_by END`
          )
          .bind(
            crypto.randomUUID(),
            input.tenantId,
            input.folderId,
            granteeType,
            granteeId,
            input.grantedBy,
            input.nowIso
          )
      );
      syncStatements.push(
        buildSyncChangeStmt(db, {
          tenantId: input.tenantId,
          entityType: 'permission',
          entityId: `${input.folderId}:${granteeType}:${granteeId}`,
          folderId: input.folderId,
          action: 'permission.grant',
          payload: {
            targetType: 'folder',
            targetId: input.folderId,
            granteeType,
            granteeId,
            role: 'co_owner',
          },
          nowIso: input.nowIso,
        })
      );
    }
  }

  return { statements, syncStatements };
}

/**
 * Shared owner-transfer statements. The new owner is granted/promoted first and
 * previous owners are demoted/revoked afterwards inside the same D1 batch, so
 * no intermediate state can drop the last effective owner.
 */
export function buildAdminRootOwnerTransferStatements(
  db: D1Database,
  input: {
    tenantId: string;
    folderId: string;
    newOwnerUserId: string;
    demote: 'co_owner' | 'editor' | 'revoke';
    previousOwners: readonly AdminRootOwnerRef[];
    grantedBy: string;
    nowIso: string;
  }
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by, created_at
         ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)
         ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
         DO UPDATE SET role = 'owner', granted_by = excluded.granted_by`
      )
      .bind(
        crypto.randomUUID(),
        input.tenantId,
        input.folderId,
        input.newOwnerUserId,
        input.grantedBy,
        input.nowIso
      ),
  ];

  for (const previous of input.previousOwners) {
    if (input.demote === 'revoke') {
      statements.push(
        db
          .prepare(
            `DELETE FROM permissions
              WHERE tenant_id = ?
                AND target_type = 'folder'
                AND target_id = ?
                AND grantee_type = ?
                AND grantee_id = ?`
          )
          .bind(
            input.tenantId,
            input.folderId,
            previous.grantee_type,
            previous.grantee_id
          )
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE permissions
                SET role = ?, granted_by = ?
              WHERE tenant_id = ?
                AND target_type = 'folder'
                AND target_id = ?
                AND grantee_type = ?
                AND grantee_id = ?`
          )
          .bind(
            input.demote,
            input.grantedBy,
            input.tenantId,
            input.folderId,
            previous.grantee_type,
            previous.grantee_id
          )
      );
    }
  }

  return statements;
}
