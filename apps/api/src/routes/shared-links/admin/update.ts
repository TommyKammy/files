import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../../services/audit';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../../services/authorization';
import { can } from '../../../services/capabilities';
import { unsealRecoverableToken } from '../../../services/crypto-utils';
import { hashSharePassword } from '../../../services/shared-link-security';
import {
  canDownloadForPermissionLevel,
  getShareLinkPolicyFlags,
  isSharePermissionLevel,
  resolvePermissionLevel,
  type SharePermissionLevel,
} from '../../../services/shared-link-permissions';
import { buildSyncChangeStmt } from '../../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../../services/sync-notifier';
import type { ClassificationLabel, ShareAccessScope } from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import {
  CONFIDENTIAL_MAX_EXPIRY_DAYS,
  DEFAULT_MAX_EXPIRY_DAYS,
  SharedLinkRow,
  VALID_SCOPES,
  formatLinkSummary,
  hasConfidentialAncestor,
  parseExpirationIso,
} from '../shared';

interface SyncFieldChange {
  from: unknown;
  to: unknown;
}

export function registerSharedLinkUpdateRoute(routes: Hono<OidcHonoEnv>) {
  routes.patch('/:id', async (c) => {
    const user = getAuthenticatedUser(c);
    const linkId = c.req.param('id');

    const link = await c.env.DB.prepare(
      'SELECT * FROM shared_links WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, linkId)
      .first<SharedLinkRow>();
    if (!link || link.revoked_at !== null) {
      return c.json({ error: 'Shared link not found' }, 404);
    }

    const body = (await c.req.json().catch(() => null)) as {
      permissionLevel?: unknown;
      accessScope?: unknown;
      requireWatermark?: unknown;
      password?: unknown;
      expiresAt?: unknown;
      expiresInDays?: unknown;
      maxDownloads?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'JSON body required' }, 400);
    }

    if (
      body.permissionLevel !== undefined &&
      !isSharePermissionLevel(body.permissionLevel)
    ) {
      return c.json(
        {
          error: "permissionLevel must be 'view', 'download' or 'edit'",
          code: 'INVALID_PERMISSION_LEVEL',
        },
        400
      );
    }
    if (
      body.accessScope !== undefined &&
      (typeof body.accessScope !== 'string' ||
        !VALID_SCOPES.has(body.accessScope as ShareAccessScope))
    ) {
      return c.json({ error: 'Invalid accessScope' }, 400);
    }
    if (
      body.requireWatermark !== undefined &&
      typeof body.requireWatermark !== 'boolean'
    ) {
      return c.json({ error: 'requireWatermark must be a boolean' }, 400);
    }
    if (
      body.password !== undefined &&
      body.password !== null &&
      (typeof body.password !== 'string' || body.password.length > 256)
    ) {
      return c.json({ error: 'password must be a string up to 256 characters' }, 400);
    }

    const targetAccess = await resolveTargetAccess(
      c.env.DB,
      user,
      link.target_type,
      link.target_id
    );
    const canManage = can(targetAccess?.capabilities, 'share_link.manage');
    const isAdmin = user.role === 'sys_admin' || user.role === 'sec_admin';
    if (link.created_by !== user.id && !canManage && !isAdmin) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const [policy, ancestorConf, targetRow] = await Promise.all([
      getShareLinkPolicyFlags(c.env.DB, user.tenantId),
      hasConfidentialAncestor(
        c.env.DB,
        user.tenantId,
        link.target_type === 'folder' ? link.target_id : targetAccess?.folderId ?? null
      ),
      link.target_type === 'file'
        ? c.env.DB.prepare(
            'SELECT classification FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
          )
            .bind(user.tenantId, link.target_id)
            .first<{ classification: ClassificationLabel }>()
        : c.env.DB.prepare(
            'SELECT classification FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
          )
            .bind(user.tenantId, link.target_id)
            .first<{ classification: ClassificationLabel }>(),
    ]);
    if (!targetRow) {
      return c.json({ error: 'Shared link target not found' }, 404);
    }

    const effectiveClassification: ClassificationLabel =
      targetRow.classification === 'confidential' || ancestorConf
        ? 'confidential'
        : targetRow.classification;
    const isConfidential = effectiveClassification === 'confidential';

    const nextAccessScope: ShareAccessScope =
      (body.accessScope as ShareAccessScope | undefined) ?? link.access_scope;
    const currentPermissionLevel = resolvePermissionLevel(link);
    let permissionLevel: SharePermissionLevel = isSharePermissionLevel(
      body.permissionLevel
    )
      ? body.permissionLevel
      : currentPermissionLevel;

    const requiresManageForWidening = permissionLevel !== 'view';
    if (requiresManageForWidening && !canManage && !isAdmin) {
      return c.json(
        {
          error:
            'View-only link creators can only keep display-only permission',
          code: 'SHARED_LINK_VIEWER_VIEW_ONLY',
        },
        403
      );
    }

    if (
      (effectiveClassification === 'confidential' || effectiveClassification === 'unset') &&
      nextAccessScope === 'public'
    ) {
      return c.json(
        {
          error: `Public links are forbidden for ${effectiveClassification} content`,
          code: 'PUBLIC_SHARE_FORBIDDEN_FOR_CLASSIFICATION',
        },
        403
      );
    }
    if (policy.enforce_company_only_links === 1 && nextAccessScope === 'public') {
      return c.json(
        {
          error: 'Tenant policy enforces company-only shared links',
          code: 'PUBLIC_SHARE_DISABLED_BY_POLICY',
        },
        403
      );
    }

    if (isConfidential) {
      if (permissionLevel === 'edit') {
        return c.json(
          {
            error: 'Edit shared links are forbidden for confidential content',
            code: 'CONFIDENTIAL_EDIT_LINK_FORBIDDEN',
          },
          403
        );
      }
      permissionLevel = 'view';
    }

    const passwordProvided = body.password !== undefined;
    const nextPasswordHash = passwordProvided
      ? typeof body.password === 'string' && body.password.trim().length > 0
        ? await hashSharePassword(body.password)
        : null
      : link.password_hash;

    let nextExpiresAt = link.expires_at;
    const expiryProvided =
      body.expiresAt !== undefined || body.expiresInDays !== undefined;
    if (expiryProvided) {
      const expiryParsed = parseExpirationIso(
        body.expiresAt,
        body.expiresInDays,
        isConfidential
          ? CONFIDENTIAL_MAX_EXPIRY_DAYS
          : (policy.max_link_expiration_days ?? DEFAULT_MAX_EXPIRY_DAYS),
        isConfidential
      );
      if (!expiryParsed.ok) {
        return c.json({ error: expiryParsed.error }, 400);
      }
      nextExpiresAt = expiryParsed.expiresAt;
    }

    if (permissionLevel === 'edit') {
      if (policy.allow_shared_link_edit !== 1) {
        return c.json(
          {
            error: 'Edit shared links are disabled by tenant policy',
            code: 'SHARED_LINK_EDIT_DISABLED',
          },
          403
        );
      }
      if (nextAccessScope === 'public') {
        if (policy.allow_public_edit_links !== 1) {
          return c.json(
            {
              error: 'Public edit links are disabled by tenant policy',
              code: 'PUBLIC_EDIT_LINK_DISABLED',
            },
            403
          );
        }
        if (!nextPasswordHash || !nextExpiresAt) {
          return c.json(
            {
              error:
                'Public edit links require both a password and an explicit expiry',
              code: 'PUBLIC_EDIT_REQUIRES_PASSWORD_AND_EXPIRY',
            },
            400
          );
        }
      }
    }

    let maxDownloads = link.max_downloads;
    if (body.maxDownloads !== undefined) {
      if (body.maxDownloads === null) {
        maxDownloads = null;
      } else if (
        typeof body.maxDownloads !== 'number' ||
        !Number.isInteger(body.maxDownloads) ||
        body.maxDownloads < 1 ||
        body.maxDownloads > 1_000_000
      ) {
        return c.json({ error: 'maxDownloads must be a positive integer' }, 400);
      } else {
        maxDownloads = body.maxDownloads;
      }
    }

    const canDownload =
      canDownloadForPermissionLevel(permissionLevel) === 1 && !isConfidential;
    const requireWatermark =
      isConfidential || permissionLevel === 'view'
        ? true
        : typeof body.requireWatermark === 'boolean'
          ? body.requireWatermark
          : link.require_watermark === 1;

    const syncChanges: Record<string, SyncFieldChange> = {};
    if (permissionLevel !== currentPermissionLevel) {
      syncChanges.permissionLevel = {
        from: currentPermissionLevel,
        to: permissionLevel,
      };
    }
    if (nextAccessScope !== link.access_scope) {
      syncChanges.accessScope = { from: link.access_scope, to: nextAccessScope };
    }
    if ((canDownload ? 1 : 0) !== link.can_download) {
      syncChanges.canDownload = {
        from: link.can_download === 1,
        to: canDownload,
      };
    }
    if ((requireWatermark ? 1 : 0) !== link.require_watermark) {
      syncChanges.requireWatermark = {
        from: link.require_watermark === 1,
        to: requireWatermark,
      };
    }
    if (nextExpiresAt !== link.expires_at) {
      syncChanges.expiresAt = { from: link.expires_at, to: nextExpiresAt };
    }
    if (maxDownloads !== link.max_downloads) {
      syncChanges.maxDownloads = { from: link.max_downloads, to: maxDownloads };
    }
    if (passwordProvided) {
      syncChanges.password = {
        from: Boolean(link.password_hash),
        to: Boolean(nextPasswordHash),
      };
    }

    if (Object.keys(syncChanges).length === 0) {
      return c.json({ error: 'No shared link fields provided' }, 400);
    }

    const folderId =
      link.target_type === 'folder' ? link.target_id : (targetAccess?.folderId ?? null);
    const nowIso = new Date().toISOString();
    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE shared_links
            SET permission_level = ?,
                access_scope = ?,
                can_download = ?,
                require_watermark = ?,
                password_hash = ?,
                expires_at = ?,
                max_downloads = ?
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`
      ).bind(
        permissionLevel,
        nextAccessScope,
        canDownload ? 1 : 0,
        requireWatermark ? 1 : 0,
        nextPasswordHash,
        nextExpiresAt,
        maxDownloads,
        user.tenantId,
        linkId
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'shared_link.update',
        targetType: link.target_type,
        targetId: link.target_id,
        classificationSnapshot: effectiveClassification,
        metadata: {
          linkId,
          permissionLevel,
          accessScope: nextAccessScope,
          canDownload,
          requireWatermark,
          sync_changes: syncChanges,
        },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'shared_link',
        entityId: linkId,
        folderId,
        targetUserId: link.created_by,
        action: 'shared_link.update',
        payload: {
          linkId,
          targetType: link.target_type,
          targetId: link.target_id,
          permissionLevel,
          accessScope: nextAccessScope,
          canDownload,
          requireWatermark,
          expiresAt: nextExpiresAt,
          maxDownloads,
          syncChanges,
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'shared_link.update',
      scopeFolderIds: [folderId],
      metadata: { linkId, permissionLevel },
    });

    const updated = await c.env.DB.prepare(
      'SELECT * FROM shared_links WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, linkId)
      .first<SharedLinkRow>();

    const token = updated
      ? await unsealRecoverableToken(c.env, updated.token_ciphertext)
      : null;

    return c.json({
      link: updated
        ? formatLinkSummary(updated, token ? `/s/${token}` : null)
        : null,
      syncChanges,
    });
  });
}
