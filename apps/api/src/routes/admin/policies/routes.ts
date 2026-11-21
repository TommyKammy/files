import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../../services/audit';
import { getAuthenticatedUser } from '../../../services/authorization';
import { buildSyncChangeStmt } from '../../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../../services/sync-notifier';
import {
  findWaterfallInheritanceConflicts,
  getPermissionInheritanceMode,
} from '../../../services/permission-inheritance';
import {
  DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE,
  isExternalDomainExistingGuestMode,
  parseDomainAllowlistJson,
  type ExternalDomainExistingGuestMode,
} from '../../../services/external-guests';
import { applyExternalDomainGuestPolicy } from '../../../services/admin-guests';
import {
  isIpAllowlistScope,
  isIpAllowed,
  parseIpAllowlistJson,
  resolveClientIp,
  type IpAllowlistScope,
} from '../../../services/ip-allowlist';
import type { OidcHonoEnv } from '../../../types/oidc';
import { applyGeneralPolicyUpdates } from './general-policies';
import {
  applyAuthControlPolicyUpdates,
  applyGuestPolicyUpdates,
  applyWorkspacePolicyUpdates,
} from './guest-and-auth-policies';
import {
  loadTenantPoliciesPayload,
  type ExistingTenantPolicyRow,
  type PolicyPatchBody,
  type PolicyPatchState,
} from './shared';

export function registerAdminPolicyRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET / PATCH /api/admin/policies — tenant governance policy settings */
  routes.get('/policies', async (c) => {
    const user = getAuthenticatedUser(c);
    return c.json(await loadTenantPoliciesPayload(c.env.DB, user.tenantId));
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
    const body = (await c.req.json().catch(() => null)) as PolicyPatchBody | null;

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required' }, 400);
    }

    const existingRow = await c.env.DB.prepare(
      `SELECT external_domain_allowlist_json,
              external_domain_existing_guest_mode,
              ip_allowlist_enabled,
              ip_allowlist_scope,
              ip_allowlist_json,
              require_sso_login,
              sso_allowed_domains_json,
              quota_warn_threshold_pct,
              quota_critical_threshold_pct
         FROM tenant_policies WHERE tenant_id = ?`
    )
      .bind(user.tenantId)
      .first<ExistingTenantPolicyRow>();

    const state: PolicyPatchState = {
      updates: [],
      binds: [],
      effectiveDomainAllowlist: parseDomainAllowlistJson(
        existingRow?.external_domain_allowlist_json
      ),
      effectiveExistingGuestMode: isExternalDomainExistingGuestMode(
        existingRow?.external_domain_existing_guest_mode
      )
        ? (existingRow!.external_domain_existing_guest_mode as ExternalDomainExistingGuestMode)
        : DEFAULT_EXTERNAL_DOMAIN_EXISTING_GUEST_MODE,
      effectiveIpAllowlistEnabled: existingRow?.ip_allowlist_enabled === 1,
      effectiveIpAllowlistScope: isIpAllowlistScope(existingRow?.ip_allowlist_scope)
        ? (existingRow!.ip_allowlist_scope as IpAllowlistScope)
        : 'admin_only',
      effectiveIpAllowlist: parseIpAllowlistJson(existingRow?.ip_allowlist_json),
    };

    const errorResponse =
      applyGeneralPolicyUpdates(c, body, user, state) ??
      applyGuestPolicyUpdates(c, body, user, state) ??
      applyAuthControlPolicyUpdates(c, body, user, state) ??
      applyWorkspacePolicyUpdates(c, body, user, existingRow, state);
    if (errorResponse) return errorResponse;

    if (state.updates.length === 0) {
      return c.json({ error: 'No policy fields provided' }, 400);
    }

    // Self-lockout prevention: when the effective allowlist is enabled, the
    // administrator performing the write must still be able to reach the admin
    // console. This also runs for unrelated policy updates while enabled, so a
    // stale allowlist can never be "fixed" from a blocked address.
    if (state.effectiveIpAllowlistEnabled) {
      const clientIp = resolveClientIp(c);
      if (!isIpAllowed(clientIp, state.effectiveIpAllowlist)) {
        return c.json(
          {
            error:
              'This update would lock the current administrator out of the tenant',
            code: 'SELF_IP_LOCKOUT_PREVENTED',
            ip: clientIp,
            scope: state.effectiveIpAllowlistScope,
          },
          400
        );
      }
    }

    const nowIso = new Date().toISOString();
    state.updates.push('updated_by = ?', 'updated_at = ?');
    state.binds.push(user.id, nowIso, user.tenantId);

    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tenant_policies SET ${state.updates.join(', ')} WHERE tenant_id = ?`
      ).bind(...state.binds),
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
            allowlist: state.effectiveDomainAllowlist,
            mode: state.effectiveExistingGuestMode,
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

    const payload = await loadTenantPoliciesPayload(c.env.DB, user.tenantId);
    return c.json({
      ...payload,
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
