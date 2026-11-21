import { loadTargetUser, projectRow, requireMemberTarget } from './shared';
import type { AdminUserDetailResult, RawAdminUserRow } from './types';

export async function loadAdminUserDetail(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<AdminUserDetailResult | null> {
  const target = await loadTargetUser(db, tenantId, userId);
  if (!target) return null;
  requireMemberTarget(target);

  const [row, rootFolders, groups, sessionRow, auditRows] = await Promise.all([
    db
      .prepare(
        `SELECT u.id, u.email, u.display_name, u.department, u.role, u.status,
                u.storage_quota_bytes, u.last_login_at, u.created_at, u.updated_at,
                COALESCE(s.total_bytes, 0) AS used_bytes,
                COALESCE(s.file_count, 0) AS file_count
           FROM users u
           LEFT JOIN user_storage_stats s
             ON s.tenant_id = u.tenant_id AND s.user_id = u.id
          WHERE u.tenant_id = ? AND u.id = ? AND u.user_type = 'member'`
      )
      .bind(tenantId, userId)
      .first<RawAdminUserRow>(),
    db
      .prepare(
        `SELECT DISTINCT f.id, f.name, f.classification, f.created_at
           FROM folders f
           JOIN permissions p
             ON p.tenant_id = f.tenant_id
            AND p.target_type = 'folder'
            AND p.target_id = f.id
            AND p.grantee_type = 'user'
            AND p.grantee_id = ?
            AND p.role = 'owner'
          WHERE f.tenant_id = ?
            AND f.parent_id IS NULL
            AND f.deleted_at IS NULL
          ORDER BY f.name ASC`
      )
      .bind(userId, tenantId)
      .all<{
        id: string;
        name: string;
        classification: string;
        created_at: string;
      }>(),
    db
      .prepare(
        `SELECT g.id, g.name
           FROM groups g
           JOIN group_members gm ON gm.group_id = g.id
          WHERE g.tenant_id = ? AND gm.user_id = ?
          ORDER BY g.name ASC`
      )
      .bind(tenantId, userId)
      .all<{ id: string; name: string }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM sessions
          WHERE tenant_id = ? AND user_id = ?
            AND revoked_at IS NULL AND expires_at > ?`
      )
      .bind(tenantId, userId, new Date().toISOString())
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT id, action, status, actor_email, actor_ip, target_type,
                target_id, metadata_json, created_at
           FROM audit_logs
          WHERE tenant_id = ?
            AND action LIKE 'admin.user.%'
            AND (target_id = ? OR json_extract(metadata_json, '$.userId') = ?)
          ORDER BY created_at DESC, id DESC
          LIMIT 20`
      )
      .bind(tenantId, userId, userId)
      .all<{
        id: string;
        action: string;
        status: 'allowed' | 'blocked';
        actor_email: string | null;
        actor_ip: string | null;
        target_type: string | null;
        target_id: string | null;
        metadata_json: string | null;
        created_at: string;
      }>(),
  ]);

  if (!row) return null;

  return {
    user: {
      ...projectRow(row),
      updatedAt: row.updated_at ?? target.updated_at,
    },
    rootFolders: rootFolders.results.map((folder) => ({
      id: folder.id,
      name: folder.name,
      classification: folder.classification,
      createdAt: folder.created_at,
    })),
    groups: groups.results.map((group) => ({
      id: group.id,
      name: group.name,
    })),
    activeSessionCount: sessionRow?.count ?? 0,
    recentAuditLogs: auditRows.results.map((log) => ({
      id: log.id,
      action: log.action,
      status: log.status,
      actorEmail: log.actor_email,
      actorIp: log.actor_ip,
      targetType: log.target_type,
      targetId: log.target_id,
      metadata: log.metadata_json
        ? (JSON.parse(log.metadata_json) as Record<string, unknown>)
        : null,
      createdAt: log.created_at,
    })),
  };
}
