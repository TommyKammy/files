import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import { getAuthenticatedUser } from '../../services/authorization';
import {
  buildClosedRootReport,
  getFolderStructureMode,
  type FolderStructureMode,
} from '../../services/folder-structure';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import {
  findWaterfallInheritanceConflicts,
  getPermissionInheritanceMode,
  isPermissionInheritanceMode,
  type PermissionInheritanceMode,
} from '../../services/permission-inheritance';
import {
  getTenantInvitePolicy,
  isInvitePolicy,
  type InvitePolicy,
} from '../../services/invite-policy';
import {
  DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE,
  isExternalDomainExistingGuestMode,
  parseDomainAllowlistJson,
  validateDomainAllowlistInput,
  type ExternalDomainExistingGuestMode,
} from '../../services/external-guests';
import { applyExternalDomainGuestPolicy } from '../../services/admin-guests';
import {
  DEFAULT_ADMIN_CONTENT_INSPECT_POLICY,
  isAdminContentInspectPolicy,
} from '../../services/admin-content';
import type { AiClassificationMode } from '../../types/classification';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  VALID_AI_MODES,
} from './shared';

function parseFolderStructureMode(value: unknown): FolderStructureMode | null {
  return value === 'open' || value === 'closed' ? value : null;
}

function projectPolicy(
  policy: Record<string, unknown>,
  folderStructureMode: FolderStructureMode,
  permissionInheritanceMode: PermissionInheritanceMode,
  invitePolicy: InvitePolicy
): Record<string, unknown> {
  return {
    ...policy,
    // camelCase projection for API consumers; the raw snake_case column stays
    // for D1/backwards-compatible readers.
    advancedRolesEnabled: policy.advanced_roles_enabled === 1,
    allowSharedLinkEdit: policy.allow_shared_link_edit === 1,
    allowPublicEditLinks: policy.allow_public_edit_links === 1,
    allowViewerShareLinks: policy.allow_viewer_share_links === 1,
    allowExternalCollaborators: policy.allow_external_collaborators === 1,
    externalDomainAllowlist: parseDomainAllowlistJson(
      policy.external_domain_allowlist_json
    ),
    guestInvitationExpiryDays: Number(policy.guest_invitation_expiry_days ?? 14),
    guestSessionMaxHours: Number(policy.guest_session_max_hours ?? 24),
    allowGuestElevatedRoles: policy.allow_guest_elevated_roles === 1,
    externalDomainExistingGuestMode:
      policy.external_domain_existing_guest_mode === 'suspend_existing'
        ? 'suspend_existing'
        : DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE,
    folderStructureMode,
    permissionInheritanceMode,
    invitePolicy,
    adminContentInspectPolicy: isAdminContentInspectPolicy(
      policy.admin_content_inspect_policy
    )
      ? policy.admin_content_inspect_policy
      : DEFAULT_ADMIN_CONTENT_INSPECT_POLICY,
  };
}

export function registerAdminPolicyRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET / PATCH /api/admin/policies — tenant governance policy settings */
  routes.get('/policies', async (c) => {
    const user = getAuthenticatedUser(c);
    const [policy, folderStructureMode, permissionInheritanceMode, invitePolicy] =
      await Promise.all([
        c.env.DB.prepare('SELECT * FROM tenant_policies WHERE tenant_id = ?')
          .bind(user.tenantId)
          .first<Record<string, unknown>>(),
        getFolderStructureMode(c.env.DB, user.tenantId),
        getPermissionInheritanceMode(c.env.DB, user.tenantId),
        getTenantInvitePolicy(c.env.DB, user.tenantId),
      ]);
    const [closedModeReport, inheritanceConflictReport] = await Promise.all([
      folderStructureMode === 'closed'
        ? buildClosedRootReport(c.env.DB, user.tenantId)
        : Promise.resolve(null),
      findWaterfallInheritanceConflicts(c.env.DB, user.tenantId),
    ]);
    return c.json({
      policy: policy
        ? projectPolicy(
            policy,
            folderStructureMode,
            permissionInheritanceMode,
            invitePolicy
          )
        : null,
      folderStructureMode,
      permissionInheritanceMode,
      invitePolicy,
      ...(closedModeReport ? { closedModeReport } : {}),
      inheritanceConflictReport,
    });
  });

  /** GET /api/admin/policies/inheritance-conflicts — read-only review for sec_admin too */
  routes.get('/policies/inheritance-conflicts', async (c) => {
    const user = getAuthenticatedUser(c);
    const [permissionInheritanceMode, conflicts] = await Promise.all([
      getPermissionInheritanceMode(c.env.DB, user.tenantId),
      findWaterfallInheritanceConflicts(c.env.DB, user.tenantId),
    ]);
    return c.json({
      permissionInheritanceMode,
      conflicts,
    });
  });

  routes.patch('/policies', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      enforceCompanyOnlyLinks?: boolean;
      requireWatermarkConfidential?: boolean;
      maxLinkExpirationDays?: number;
      sessionMaxHours?: number;
      trashRetentionDays?: number;
      aiClassificationMode?: AiClassificationMode;
      aiAutoApplyThreshold?: number | null;
      advancedRolesEnabled?: boolean;
      allowSharedLinkEdit?: boolean;
      allowPublicEditLinks?: boolean;
      allowViewerShareLinks?: boolean;
      folderStructureMode?: unknown;
      permissionInheritanceMode?: unknown;
      invitePolicy?: unknown;
      allowExternalCollaborators?: unknown;
      externalDomainAllowlist?: unknown;
      guestInvitationExpiryDays?: unknown;
      guestSessionMaxHours?: unknown;
      allowGuestElevatedRoles?: unknown;
      externalDomainExistingGuestMode?: unknown;
      adminContentInspectPolicy?: unknown;
    } | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required' }, 400);
    }

    const existingGuestPolicyRow = await c.env.DB.prepare(
      `SELECT external_domain_allowlist_json,
              external_domain_existing_guest_mode
         FROM tenant_policies WHERE tenant_id = ?`
    )
      .bind(user.tenantId)
      .first<{
        external_domain_allowlist_json: string | null;
        external_domain_existing_guest_mode: string | null;
      }>();
    let effectiveDomainAllowlist = parseDomainAllowlistJson(
      existingGuestPolicyRow?.external_domain_allowlist_json
    );
    let effectiveExistingGuestMode: ExternalDomainExistingGuestMode =
      isExternalDomainExistingGuestMode(
        existingGuestPolicyRow?.external_domain_existing_guest_mode
      )
        ? (existingGuestPolicyRow!.external_domain_existing_guest_mode as ExternalDomainExistingGuestMode)
        : DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE;

    const updates: string[] = [];
    const binds: unknown[] = [];

    if (body.folderStructureMode !== undefined) {
      if (user.role !== 'sys_admin') {
        return c.json(
          {
            error: 'Only sys_admin can change folder structure mode',
            code: 'SYS_ADMIN_REQUIRED',
          },
          403
        );
      }
      const mode = parseFolderStructureMode(body.folderStructureMode);
      if (!mode) {
        return c.json(
          {
            error: "folderStructureMode must be 'open' or 'closed'",
            code: 'INVALID_FOLDER_STRUCTURE_MODE',
          },
          400
        );
      }
      updates.push('folder_structure_mode = ?');
      binds.push(mode);
    }

    if (body.permissionInheritanceMode !== undefined) {
      if (user.role !== 'sys_admin') {
        return c.json(
          {
            error: 'Only sys_admin can change permission inheritance mode',
            code: 'SYS_ADMIN_REQUIRED',
          },
          403
        );
      }
      if (!isPermissionInheritanceMode(body.permissionInheritanceMode)) {
        return c.json(
          {
            error: "permissionInheritanceMode must be 'additive' or 'waterfall'",
            code: 'INVALID_PERMISSION_INHERITANCE_MODE',
          },
          400
        );
      }
      updates.push('permission_inheritance_mode = ?');
      binds.push(body.permissionInheritanceMode);
    }

    if (body.invitePolicy !== undefined) {
      if (user.role !== 'sys_admin') {
        return c.json(
          {
            error: 'Only sys_admin can change the tenant invite policy',
            code: 'SYS_ADMIN_REQUIRED',
          },
          403
        );
      }
      if (!isInvitePolicy(body.invitePolicy)) {
        return c.json(
          {
            error: "invitePolicy must be 'owners', 'editors' or 'admins'",
            code: 'INVALID_INVITE_POLICY',
          },
          400
        );
      }
      updates.push('invite_policy = ?');
      binds.push(body.invitePolicy);
    }

    if (body.adminContentInspectPolicy !== undefined) {
      if (user.role !== 'sys_admin') {
        return c.json(
          {
            error:
              'Only sys_admin can change the admin content inspection policy',
            code: 'SYS_ADMIN_REQUIRED',
          },
          403
        );
      }
      if (!isAdminContentInspectPolicy(body.adminContentInspectPolicy)) {
        return c.json(
          {
            error:
              "adminContentInspectPolicy must be 'disabled', 'deny_confidential' or 'watermark_confidential'",
            code: 'INVALID_ADMIN_CONTENT_INSPECT_POLICY',
          },
          400
        );
      }
      updates.push('admin_content_inspect_policy = ?');
      binds.push(body.adminContentInspectPolicy);
    }

    if (body.enforceCompanyOnlyLinks !== undefined) {
      updates.push('enforce_company_only_links = ?');
      binds.push(body.enforceCompanyOnlyLinks ? 1 : 0);
    }
    if (body.requireWatermarkConfidential !== undefined) {
      updates.push('require_watermark_confidential = ?');
      binds.push(body.requireWatermarkConfidential ? 1 : 0);
    }
    if (body.maxLinkExpirationDays !== undefined) {
      if (!Number.isInteger(body.maxLinkExpirationDays) || body.maxLinkExpirationDays < 1 || body.maxLinkExpirationDays > 365) {
        return c.json({ error: 'maxLinkExpirationDays must be integer 1..365' }, 400);
      }
      updates.push('max_link_expiration_days = ?');
      binds.push(body.maxLinkExpirationDays);
    }
    if (body.sessionMaxHours !== undefined) {
      if (!Number.isInteger(body.sessionMaxHours) || body.sessionMaxHours < 1 || body.sessionMaxHours > 720) {
        return c.json({ error: 'sessionMaxHours must be integer 1..720' }, 400);
      }
      updates.push('session_max_hours = ?');
      binds.push(body.sessionMaxHours);
    }
    if (body.trashRetentionDays !== undefined) {
      if (!Number.isInteger(body.trashRetentionDays) || body.trashRetentionDays < 1 || body.trashRetentionDays > 3650) {
        return c.json({ error: 'trashRetentionDays must be integer 1..3650' }, 400);
      }
      updates.push('trash_retention_days = ?');
      binds.push(body.trashRetentionDays);
    }
    if (body.aiClassificationMode !== undefined) {
      if (!VALID_AI_MODES.has(body.aiClassificationMode)) {
        return c.json({ error: 'Invalid aiClassificationMode' }, 400);
      }
      updates.push('ai_classification_mode = ?');
      binds.push(body.aiClassificationMode);
    }
    if (body.advancedRolesEnabled !== undefined) {
      if (typeof body.advancedRolesEnabled !== 'boolean') {
        return c.json({ error: 'advancedRolesEnabled must be a boolean' }, 400);
      }
      updates.push('advanced_roles_enabled = ?');
      binds.push(body.advancedRolesEnabled ? 1 : 0);
    }

    for (const [field, column] of [
      ['allowSharedLinkEdit', 'allow_shared_link_edit'],
      ['allowPublicEditLinks', 'allow_public_edit_links'],
      ['allowViewerShareLinks', 'allow_viewer_share_links'],
    ] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') {
        return c.json({ error: `${field} must be a boolean` }, 400);
      }
      updates.push(`${column} = ?`);
      binds.push(value ? 1 : 0);
    }

    // P10-1 external guest policies: sys_admin only, sec_admin remains read-only.
    const guestPolicyFieldsProvided =
      body.allowExternalCollaborators !== undefined ||
      body.externalDomainAllowlist !== undefined ||
      body.guestInvitationExpiryDays !== undefined ||
      body.guestSessionMaxHours !== undefined ||
      body.allowGuestElevatedRoles !== undefined ||
      body.externalDomainExistingGuestMode !== undefined;
    if (guestPolicyFieldsProvided && user.role !== 'sys_admin') {
      return c.json(
        {
          error: 'Only sys_admin can change external guest policies',
          code: 'SYS_ADMIN_REQUIRED',
        },
        403
      );
    }

    if (body.allowExternalCollaborators !== undefined) {
      if (typeof body.allowExternalCollaborators !== 'boolean') {
        return c.json(
          { error: 'allowExternalCollaborators must be a boolean', code: 'INVALID_GUEST_POLICY' },
          400
        );
      }
      updates.push('allow_external_collaborators = ?');
      binds.push(body.allowExternalCollaborators ? 1 : 0);
    }
    if (body.allowGuestElevatedRoles !== undefined) {
      if (typeof body.allowGuestElevatedRoles !== 'boolean') {
        return c.json(
          { error: 'allowGuestElevatedRoles must be a boolean', code: 'INVALID_GUEST_POLICY' },
          400
        );
      }
      updates.push('allow_guest_elevated_roles = ?');
      binds.push(body.allowGuestElevatedRoles ? 1 : 0);
    }
    if (body.externalDomainAllowlist !== undefined) {
      const validation = validateDomainAllowlistInput(body.externalDomainAllowlist);
      if (!validation.ok) {
        const wildcardDomains = validation.wildcard ?? [];
        return c.json(
          {
            error:
              wildcardDomains.length > 0
                ? 'ワイルドカード (*) は不可です。完全一致ドメインのみ許可されます。'
                : `Invalid external guest domain(s): ${validation.invalid.join(', ')}`,
            code:
              wildcardDomains.length > 0
                ? 'WILDCARD_DOMAIN_NOT_ALLOWED'
                : 'INVALID_DOMAIN_ALLOWLIST',
            invalidDomains: validation.invalid,
            ...(wildcardDomains.length > 0 ? { wildcardDomains } : {}),
          },
          400
        );
      }
      updates.push('external_domain_allowlist_json = ?');
      binds.push(JSON.stringify(validation.domains));
      effectiveDomainAllowlist = validation.domains;
    }
    if (body.externalDomainExistingGuestMode !== undefined) {
      if (!isExternalDomainExistingGuestMode(body.externalDomainExistingGuestMode)) {
        return c.json(
          {
            error:
              "externalDomainExistingGuestMode must be 'reject_new_only' or 'suspend_existing'",
            code: 'INVALID_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE',
          },
          400
        );
      }
      updates.push('external_domain_existing_guest_mode = ?');
      binds.push(body.externalDomainExistingGuestMode);
      effectiveExistingGuestMode = body.externalDomainExistingGuestMode;
    }
    if (body.guestInvitationExpiryDays !== undefined) {
      if (
        typeof body.guestInvitationExpiryDays !== 'number' ||
        !Number.isInteger(body.guestInvitationExpiryDays) ||
        body.guestInvitationExpiryDays < 1 ||
        body.guestInvitationExpiryDays > 365
      ) {
        return c.json(
          {
            error: 'guestInvitationExpiryDays must be integer 1..365',
            code: 'INVALID_GUEST_POLICY',
          },
          400
        );
      }
      updates.push('guest_invitation_expiry_days = ?');
      binds.push(body.guestInvitationExpiryDays);
    }
    if (body.guestSessionMaxHours !== undefined) {
      if (
        typeof body.guestSessionMaxHours !== 'number' ||
        !Number.isInteger(body.guestSessionMaxHours) ||
        body.guestSessionMaxHours < 1 ||
        body.guestSessionMaxHours > 168
      ) {
        return c.json(
          {
            error: 'guestSessionMaxHours must be integer 1..168',
            code: 'INVALID_GUEST_POLICY',
          },
          400
        );
      }
      updates.push('guest_session_max_hours = ?');
      binds.push(body.guestSessionMaxHours);
    }
    if (body.aiAutoApplyThreshold !== undefined) {
      if (
        body.aiAutoApplyThreshold !== null &&
        (typeof body.aiAutoApplyThreshold !== 'number' ||
          body.aiAutoApplyThreshold < 0.7 ||
          body.aiAutoApplyThreshold > 1)
      ) {
        return c.json({ error: 'aiAutoApplyThreshold must be null or 0.70..1.00' }, 400);
      }
      updates.push('ai_auto_apply_threshold = ?');
      binds.push(body.aiAutoApplyThreshold);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No policy fields provided' }, 400);
    }

    const nowIso = new Date().toISOString();
    updates.push('updated_by = ?', 'updated_at = ?');
    binds.push(user.id, nowIso, user.tenantId);

    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tenant_policies SET ${updates.join(', ')} WHERE tenant_id = ?`
      ).bind(...binds),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'admin.policy_updated',
        targetType: 'tenant_policy',
        targetId: user.tenantId,
        metadata: body as Record<string, unknown>,
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'policy',
        entityId: user.tenantId,
        action: 'admin.policy_updated',
        payload: {
          updatedFields: Object.keys(body),
          ...(body.folderStructureMode !== undefined
            ? { folderStructureMode: body.folderStructureMode }
            : {}),
          ...(body.permissionInheritanceMode !== undefined
            ? { permissionInheritanceMode: body.permissionInheritanceMode }
            : {}),
          ...(body.invitePolicy !== undefined
            ? { invitePolicy: body.invitePolicy }
            : {}),
          ...(body.adminContentInspectPolicy !== undefined
            ? {
                adminContentInspectPolicy: body.adminContentInspectPolicy,
              }
            : {}),
          ...(body.externalDomainExistingGuestMode !== undefined
            ? {
                externalDomainExistingGuestMode:
                  body.externalDomainExistingGuestMode,
              }
            : {}),
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    const externalDomainPolicy =
      body.externalDomainAllowlist !== undefined ||
      body.externalDomainExistingGuestMode !== undefined
        ? await applyExternalDomainGuestPolicy({
            db: c.env.DB,
            tenantId: user.tenantId,
            allowlist: effectiveDomainAllowlist,
            mode: effectiveExistingGuestMode,
            actor: user,
            nowIso,
          })
        : null;

    const policySyncSeq = extractLastSyncSeq(batchResults);
    const syncSeq = Math.max(
      policySyncSeq ?? 0,
      externalDomainPolicy?.syncSeq ?? 0
    );
    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: syncSeq > 0 ? syncSeq : policySyncSeq,
      eventKind: 'admin.policy_updated',
      ...(externalDomainPolicy
        ? { metadata: { affectedGuestCount: externalDomainPolicy.affectedGuestCount } }
        : {}),
    });

    const [updated, folderStructureMode, permissionInheritanceMode, invitePolicy] =
      await Promise.all([
        c.env.DB.prepare('SELECT * FROM tenant_policies WHERE tenant_id = ?')
          .bind(user.tenantId)
          .first<Record<string, unknown>>(),
        getFolderStructureMode(c.env.DB, user.tenantId),
        getPermissionInheritanceMode(c.env.DB, user.tenantId),
        getTenantInvitePolicy(c.env.DB, user.tenantId),
      ]);
    const [closedModeReport, inheritanceConflictReport] = await Promise.all([
      folderStructureMode === 'closed'
        ? buildClosedRootReport(c.env.DB, user.tenantId)
        : Promise.resolve(null),
      findWaterfallInheritanceConflicts(c.env.DB, user.tenantId),
    ]);
    return c.json({
      policy: updated
        ? projectPolicy(
            updated,
            folderStructureMode,
            permissionInheritanceMode,
            invitePolicy
          )
        : null,
      folderStructureMode,
      permissionInheritanceMode,
      invitePolicy,
      ...(closedModeReport ? { closedModeReport } : {}),
      inheritanceConflictReport,
      ...(externalDomainPolicy
        ? {
            externalDomainPolicy: {
              mode: externalDomainPolicy.mode,
              affectedGuestCount: externalDomainPolicy.affectedGuestCount,
              suspendedGuestIds: externalDomainPolicy.suspendedGuestIds,
            },
          }
        : {}),
    });
  });
}
