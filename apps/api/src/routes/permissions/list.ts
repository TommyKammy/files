import { Hono } from 'hono';
import {
  areAdvancedRolesEnabled,
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../services/authorization';
import {
  can,
  filterFileTargetRoles,
  isAdvancedResourceRole,
  synthesizeEffectiveAccess,
} from '../../services/capabilities';
import type { ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  PermissionListRow,
  VALID_TARGET_TYPES,
} from './shared';

export function registerPermissionListRoute(routes: Hono<OidcHonoEnv>) {
  /** GET /api/permissions?targetType=folder|file&targetId=... */
  routes.get('/permissions', async (c) => {
    const user = getAuthenticatedUser(c);
    const targetType = c.req.query('targetType') as 'folder' | 'file' | undefined;
    const targetId = c.req.query('targetId');

    if (!targetType || !VALID_TARGET_TYPES.has(targetType) || !targetId) {
      return c.json({ error: 'targetType (folder|file) and targetId are required' }, 400);
    }

    const access = await resolveTargetAccess(c.env.DB, user, targetType, targetId);
    if (!access || access.deletedAt !== null) {
      return c.json({ error: 'Target resource not found' }, 404);
    }
    if (!can(access.capabilities, 'permission.view')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    let sql: string;
    let bindings: unknown[];

    if (targetType === 'folder') {
      sql = `
        SELECT p.id,
               p.target_type,
               p.target_id,
               p.grantee_type,
               p.grantee_id,
               p.role,
               p.granted_by,
               p.created_at,
               COALESCE(u.display_name, g.name) AS grantee_name,
               u.email AS grantee_email,
               anc.name AS source_name,
               CASE WHEN p.target_id = ? THEN 0 ELSE 1 END AS is_inherited
          FROM folder_closures fc
          JOIN permissions p
            ON p.tenant_id = fc.tenant_id
           AND p.target_type = 'folder'
           AND p.target_id = fc.ancestor_id
          LEFT JOIN folders anc ON anc.id = p.target_id
          LEFT JOIN users u ON p.grantee_type = 'user' AND u.id = p.grantee_id
          LEFT JOIN groups g ON p.grantee_type = 'group' AND g.id = p.grantee_id
         WHERE fc.tenant_id = ? AND fc.descendant_id = ?
         ORDER BY is_inherited ASC, p.created_at ASC`;
      bindings = [targetId, user.tenantId, targetId];
    } else {
      sql = `
        SELECT p.id,
               p.target_type,
               p.target_id,
               p.grantee_type,
               p.grantee_id,
               p.role,
               p.granted_by,
               p.created_at,
               COALESCE(u.display_name, g.name) AS grantee_name,
               u.email AS grantee_email,
               CASE WHEN p.target_type = 'file' THEN NULL ELSE anc.name END AS source_name,
               CASE WHEN p.target_type = 'file' THEN 0 ELSE 1 END AS is_inherited
          FROM permissions p
          LEFT JOIN folders anc ON p.target_type = 'folder' AND anc.id = p.target_id
          LEFT JOIN users u ON p.grantee_type = 'user' AND u.id = p.grantee_id
          LEFT JOIN groups g ON p.grantee_type = 'group' AND g.id = p.grantee_id
         WHERE p.tenant_id = ?
           AND (
             (p.target_type = 'file' AND p.target_id = ?)
             OR (
               p.target_type = 'folder'
               AND ? IS NOT NULL
               AND p.target_id IN (
                 SELECT fc.ancestor_id
                   FROM folder_closures fc
                  WHERE fc.tenant_id = ? AND fc.descendant_id = ?
               )
             )
           )
         ORDER BY is_inherited ASC, p.created_at ASC`;
      bindings = [
        user.tenantId,
        targetId,
        access.folderId,
        user.tenantId,
        access.folderId ?? '',
      ];
    }

    const [rows, advancedRolesEnabled, membershipRows] = await Promise.all([
      c.env.DB.prepare(sql).bind(...bindings).all<PermissionListRow>(),
      areAdvancedRolesEnabled(c.env.DB, user.tenantId),
      c.env.DB.prepare(
        'SELECT group_id FROM group_members WHERE user_id = ?'
      )
        .bind(user.id)
        .all<{ group_id: string }>(),
    ]);

    const myGroupIds = new Set(
      membershipRows.results.map((row) => row.group_id)
    );

    /**
     * One grantee can hold several rows (direct + inherited, user + group).
     * Compose them non-linearly so the UI can show `Viewer + Uploader` instead
     * of whichever single row happened to sort first.
     */
    const rolesByGrantee = new Map<string, ResourceRole[]>();
    for (const row of rows.results) {
      const key = `${row.grantee_type}:${row.grantee_id}`;
      const roles = rolesByGrantee.get(key) ?? [];
      roles.push(row.role);
      rolesByGrantee.set(key, roles);
    }
    const synthesizedByGrantee = new Map<
      string,
      ReturnType<typeof synthesizeEffectiveAccess>
    >();
    for (const [key, roles] of rolesByGrantee) {
      const applicableRoles =
        targetType === 'file' ? filterFileTargetRoles(roles) : roles;
      synthesizedByGrantee.set(
        key,
        synthesizeEffectiveAccess(applicableRoles)
      );
    }

    const effectiveBreakdown = rows.results
      .filter(
        (row) =>
          // Advanced roles are folder-only and never contribute to file access.
          (targetType !== 'file' || !isAdvancedResourceRole(row.role)) &&
          (row.grantee_type === 'user'
            ? row.grantee_id === user.id
            : myGroupIds.has(row.grantee_id))
      )
      .map((row) => ({
        granteeType: row.grantee_type,
        granteeId: row.grantee_id,
        role: row.role,
        inherited: row.is_inherited === 1,
        sourceName: row.source_name,
        targetId: row.target_id,
      }));

    return c.json({
      targetType,
      targetId,
      effectiveRole: access.effectiveRole,
      capabilities: access.capabilities,
      grantedRoles: access.grantedRoles,
      advancedRolesEnabled,
      effectiveBreakdown,
      permissions: rows.results.map((r) => {
        const key = `${r.grantee_type}:${r.grantee_id}`;
        const synthesized = synthesizedByGrantee.get(key);
        return {
          id: r.id,
          targetType: r.target_type,
          targetId: r.target_id,
          granteeType: r.grantee_type,
          granteeId: r.grantee_id,
          granteeName: r.grantee_name,
          granteeEmail: r.grantee_email,
          role: r.role,
          inherited: r.is_inherited === 1,
          sourceName: r.source_name,
          grantedBy: r.granted_by,
          createdAt: r.created_at,
          synthesizedRole: synthesized?.effectiveRole ?? null,
          synthesizedCapabilities: synthesized?.capabilities ?? [],
        };
      }),
    });
  });

}
