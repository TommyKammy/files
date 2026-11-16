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
import {
  findWaterfallInheritanceConflicts,
  getPermissionInheritanceMode,
} from '../../services/permission-inheritance';
import {
  computeEffectivePermissionsCapabilities,
  grantableRolesForCaller,
  resolveEffectiveInvitePolicy,
} from '../../services/invite-policy';
import { getGuestPolicy } from '../../services/external-guests';
import {
  buildGuestInvitationMailPreview,
  projectGuestPolicy,
} from '../../services/guest-collaboration';
import type { ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  PermissionListRow,
  VALID_TARGET_TYPES,
} from './shared';

interface GuestInvitationListRow {
  id: string;
  user_id: string | null;
  email: string;
  display_name: string;
  external_org: string | null;
  invited_by: string;
  invited_by_name: string | null;
  role: ResourceRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  resend_count: number;
  last_sent_at: string | null;
  created_at: string;
  updated_at: string;
  target_name: string | null;
}

function effectiveInvitationStatus(
  status: GuestInvitationListRow['status'],
  expiresAt: string,
  nowIso: string
): GuestInvitationListRow['status'] {
  if (status === 'pending' && expiresAt <= nowIso) return 'expired';
  return status;
}

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

    const policyFolderId = targetType === 'folder' ? targetId : access.folderId;
    const resolvedInvitePolicy = await resolveEffectiveInvitePolicy(
      c.env.DB,
      user.tenantId,
      policyFolderId
    );
    const effectiveCapabilities = computeEffectivePermissionsCapabilities(
      access.capabilities,
      access.effectiveRole,
      resolvedInvitePolicy.effectivePolicy,
      user.role
    );
    const canManage = can(access.capabilities, 'permission.manage');
    const canInvite = can(effectiveCapabilities, 'permission.invite');
    if (!can(access.capabilities, 'permission.view') && !canInvite) {
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
               u.user_type AS grantee_user_type,
               u.external_org AS grantee_external_org,
               u.expires_at AS grantee_expires_at,
               u.last_login_at AS grantee_last_login_at,
               u.invited_by AS grantee_invited_by,
               inviter.display_name AS grantee_invited_by_name,
               u.status AS grantee_account_status,
               (
                 SELECT gi.status
                   FROM guest_invitations gi
                  WHERE gi.tenant_id = u.tenant_id
                    AND gi.user_id = u.id
                  ORDER BY gi.created_at DESC, gi.rowid DESC
                  LIMIT 1
               ) AS grantee_invitation_status,
               anc.name AS source_name,
               CASE WHEN p.target_id = ? THEN 0 ELSE 1 END AS is_inherited
          FROM folder_closures fc
          JOIN permissions p
            ON p.tenant_id = fc.tenant_id
           AND p.target_type = 'folder'
           AND p.target_id = fc.ancestor_id
          LEFT JOIN folders anc ON anc.id = p.target_id
          LEFT JOIN users u ON p.grantee_type = 'user' AND u.id = p.grantee_id
          LEFT JOIN users inviter ON inviter.id = u.invited_by
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
               u.user_type AS grantee_user_type,
               u.external_org AS grantee_external_org,
               u.expires_at AS grantee_expires_at,
               u.last_login_at AS grantee_last_login_at,
               u.invited_by AS grantee_invited_by,
               inviter.display_name AS grantee_invited_by_name,
               u.status AS grantee_account_status,
               (
                 SELECT gi.status
                   FROM guest_invitations gi
                  WHERE gi.tenant_id = u.tenant_id
                    AND gi.user_id = u.id
                  ORDER BY gi.created_at DESC, gi.rowid DESC
                  LIMIT 1
               ) AS grantee_invitation_status,
               CASE WHEN p.target_type = 'file' THEN NULL ELSE anc.name END AS source_name,
               CASE WHEN p.target_type = 'file' THEN 0 ELSE 1 END AS is_inherited
          FROM permissions p
          LEFT JOIN folders anc ON p.target_type = 'folder' AND anc.id = p.target_id
          LEFT JOIN users u ON p.grantee_type = 'user' AND u.id = p.grantee_id
          LEFT JOIN users inviter ON inviter.id = u.invited_by
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

    const [
      rows,
      advancedRolesEnabled,
      membershipRows,
      permissionInheritanceMode,
      guestInvitationRows,
      guestPolicy,
    ] = await Promise.all([
      c.env.DB.prepare(sql).bind(...bindings).all<PermissionListRow>(),
      areAdvancedRolesEnabled(c.env.DB, user.tenantId),
      c.env.DB.prepare(
        'SELECT group_id FROM group_members WHERE user_id = ?'
      )
        .bind(user.id)
        .all<{ group_id: string }>(),
      getPermissionInheritanceMode(c.env.DB, user.tenantId),
      c.env.DB.prepare(
        `SELECT gi.id,
                gi.user_id,
                gi.email,
                gi.display_name,
                gi.external_org,
                gi.invited_by,
                inviter.display_name AS invited_by_name,
                gi.role,
                gi.status,
                gi.expires_at,
                gi.accepted_at,
                gi.revoked_at,
                gi.resend_count,
                gi.last_sent_at,
                gi.created_at,
                gi.updated_at,
                COALESCE(f.name, fl.name) AS target_name
           FROM guest_invitations gi
           LEFT JOIN users inviter ON inviter.id = gi.invited_by
           LEFT JOIN folders f
             ON gi.target_type = 'folder'
            AND f.tenant_id = gi.tenant_id
            AND f.id = gi.target_id
           LEFT JOIN files fl
             ON gi.target_type = 'file'
            AND fl.tenant_id = gi.tenant_id
            AND fl.id = gi.target_id
          WHERE gi.tenant_id = ?
            AND gi.target_type = ?
            AND gi.target_id = ?
          ORDER BY gi.created_at DESC
          LIMIT 100`
      )
        .bind(user.tenantId, targetType, targetId)
        .all<GuestInvitationListRow>(),
      getGuestPolicy(c.env.DB, user.tenantId),
    ]);
    const nowIso = new Date().toISOString();

    const guestInvitations = guestInvitationRows.results.map((row) => {
      const status = effectiveInvitationStatus(
        row.status,
        row.expires_at,
        nowIso
      );
      return {
        id: row.id,
        userId: row.user_id,
        email: row.email,
        displayName: row.display_name,
        externalOrg: row.external_org,
        invitedBy: row.invited_by,
        invitedByName: row.invited_by_name,
        role: row.role,
        status,
        expiresAt: row.expires_at,
        acceptedAt: row.accepted_at,
        revokedAt: row.revoked_at,
        resendCount: row.resend_count,
        lastSentAt: row.last_sent_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        mailPreview: buildGuestInvitationMailPreview({
          displayName: row.display_name,
          externalOrg: row.external_org,
          targetType,
          targetName: row.target_name,
          role: row.role,
          expiresAt: row.expires_at,
          invitedByName: row.invited_by_name,
        }),
      };
    });

    const inheritanceConflicts =
      permissionInheritanceMode === 'waterfall'
        ? await findWaterfallInheritanceConflicts(c.env.DB, user.tenantId)
        : [];
    const conflictByPermission = new Map(
      inheritanceConflicts.map((conflict) => [conflict.permissionId, conflict])
    );

    const grantableRoles = grantableRolesForCaller({
      targetType,
      callerCapabilities: access.capabilities,
      callerRole: access.effectiveRole,
      canManage,
      canInvite,
      advancedRolesEnabled,
    });

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
      permissionInheritanceMode,
      accessMode: access.accessMode,
      effectiveRole: access.effectiveRole,
      capabilities: effectiveCapabilities,
      effectiveCapabilities,
      grantedRoles: access.grantedRoles,
      advancedRolesEnabled,
      canManage,
      canInvite,
      invitePolicy: {
        tenantPolicy: resolvedInvitePolicy.tenantPolicy,
        folderOwnPolicy: resolvedInvitePolicy.ownPolicy,
        effectivePolicy: resolvedInvitePolicy.effectivePolicy,
        inheritedFloor: resolvedInvitePolicy.parentFloor,
        sourceFolderId: resolvedInvitePolicy.sourceFolderId,
        sourceFolderName: resolvedInvitePolicy.sourceFolderName,
        canEditFolderPolicy:
          targetType === 'folder' && canManage,
      },
      grantableRoles,
      effectiveBreakdown,
      guestInvitations,
      guestPolicy: projectGuestPolicy(guestPolicy, {
        advancedRolesEnabled,
        targetType,
      }),
      permissions: rows.results.map((r) => {
        const key = `${r.grantee_type}:${r.grantee_id}`;
        const synthesized = synthesizedByGrantee.get(key);
        const conflict = conflictByPermission.get(r.id);
        const inherited = r.is_inherited === 1;
        const waterfallLocked =
          permissionInheritanceMode === 'waterfall' &&
          (inherited || Boolean(conflict));
        return {
          id: r.id,
          targetType: r.target_type,
          targetId: r.target_id,
          granteeType: r.grantee_type,
          granteeId: r.grantee_id,
          granteeName: r.grantee_name,
          granteeEmail: r.grantee_email,
          granteeUserType: r.grantee_user_type ?? 'member',
          granteeExternalOrg: r.grantee_external_org,
          granteeExpiresAt: r.grantee_expires_at,
          granteeLastLoginAt: r.grantee_last_login_at,
          granteeInvitedBy: r.grantee_invited_by,
          granteeInvitedByName: r.grantee_invited_by_name,
          granteeStatus:
            r.grantee_user_type === 'guest'
              ? r.grantee_invitation_status ??
                (r.grantee_account_status === 'active' ? 'accepted' : 'revoked')
              : null,
          role: r.role,
          inherited,
          sourceName: r.source_name,
          grantedBy: r.granted_by,
          createdAt: r.created_at,
          synthesizedRole: synthesized?.effectiveRole ?? null,
          synthesizedCapabilities: synthesized?.capabilities ?? [],
          waterfallLocked,
          ...(waterfallLocked && inherited
            ? {
                ancestorFolderId: r.target_id,
                ancestorFolderName: r.source_name,
                ancestorRole: r.role,
              }
            : {}),
          ...(conflict
            ? {
                ancestorFolderId: conflict.ancestorFolderId,
                ancestorFolderName: conflict.ancestorFolderName,
                ancestorRole: conflict.ancestorRole,
              }
            : {}),
        };
      }),
    });
  });

}
