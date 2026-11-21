import type { Context } from 'hono';
import { isPermissionInheritanceMode } from '../../../services/permission-inheritance';
import { isInvitePolicy } from '../../../services/invite-policy';
import { isAdminContentInspectPolicy } from '../../../services/admin-content';
import type { AuthUser } from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import { VALID_AI_MODES } from '../shared';
import {
  parseFolderStructureMode,
  sysAdminRequiredResponse,
  type PolicyPatchBody,
  type PolicyPatchState,
} from './shared';

export function applyGeneralPolicyUpdates(
  c: Context<OidcHonoEnv>,
  body: PolicyPatchBody,
  user: AuthUser,
  state: PolicyPatchState
): Response | null {
  const { updates, binds } = state;

  if (body.folderStructureMode !== undefined) {
    if (user.role !== 'sys_admin') {
      return sysAdminRequiredResponse(c, 'Only sys_admin can change folder structure mode');
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
      return sysAdminRequiredResponse(
        c,
        'Only sys_admin can change permission inheritance mode'
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
      return sysAdminRequiredResponse(
        c,
        'Only sys_admin can change the tenant invite policy'
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
      return sysAdminRequiredResponse(
        c,
        'Only sys_admin can change the admin content inspection policy'
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
    if (
      !Number.isInteger(body.maxLinkExpirationDays) ||
      body.maxLinkExpirationDays < 1 ||
      body.maxLinkExpirationDays > 365
    ) {
      return c.json({ error: 'maxLinkExpirationDays must be integer 1..365' }, 400);
    }
    updates.push('max_link_expiration_days = ?');
    binds.push(body.maxLinkExpirationDays);
  }
  if (body.sessionMaxHours !== undefined) {
    if (
      !Number.isInteger(body.sessionMaxHours) ||
      body.sessionMaxHours < 1 ||
      body.sessionMaxHours > 720
    ) {
      return c.json({ error: 'sessionMaxHours must be integer 1..720' }, 400);
    }
    updates.push('session_max_hours = ?');
    binds.push(body.sessionMaxHours);
  }
  if (body.trashRetentionDays !== undefined) {
    if (
      !Number.isInteger(body.trashRetentionDays) ||
      body.trashRetentionDays < 1 ||
      body.trashRetentionDays > 3650
    ) {
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

  return null;
}
