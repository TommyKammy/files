import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../../services/audit';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../../services/authorization';
import { can } from '../../../services/capabilities';
import { generateRandomToken, sha256Hex } from '../../../services/crypto-utils';
import { hashSharePassword } from '../../../services/shared-link-security';
import {
  canDownloadForPermissionLevel,
  getShareLinkPolicyFlags,
  isSharePermissionLevel,
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

export function registerSharedLinkCreateRoute(routes: Hono<OidcHonoEnv>) {
  routes.post('/', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      targetType?: unknown;
      targetId?: unknown;
      accessScope?: unknown;
      permissionLevel?: unknown;
      canDownload?: unknown;
      requireWatermark?: unknown;
      password?: unknown;
      expiresAt?: unknown;
      expiresInDays?: unknown;
      maxDownloads?: unknown;
    } | null;

    if (
      !body ||
      (body.targetType !== 'file' && body.targetType !== 'folder') ||
      typeof body.targetId !== 'string' ||
      !body.targetId.trim()
    ) {
      return c.json({ error: 'targetType (file|folder) and targetId are required' }, 400);
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

    const accessScope: ShareAccessScope =
      typeof body.accessScope === 'string' && VALID_SCOPES.has(body.accessScope as ShareAccessScope)
        ? (body.accessScope as ShareAccessScope)
        : body.accessScope === undefined
          ? 'company_only'
          : (null as unknown as ShareAccessScope);

    if (!accessScope) {
      return c.json({ error: 'Invalid accessScope' }, 400);
    }

    const targetId = body.targetId.trim();
    const access = await resolveTargetAccess(c.env.DB, user, body.targetType, targetId);
    if (
      !access ||
      access.deletedAt !== null ||
      (body.targetType === 'file' && access.uploadState !== 'active')
    ) {
      return c.json({ error: 'Target resource not found' }, 404);
    }

    const [policy, ancestorConf] = await Promise.all([
      getShareLinkPolicyFlags(c.env.DB, user.tenantId),
      hasConfidentialAncestor(
        c.env.DB,
        user.tenantId,
        body.targetType === 'folder' ? targetId : access.folderId
      ),
    ]);

    const isViewerRole = access.effectiveRole === 'viewer';
    const viewerShareAllowed =
      isViewerRole && policy.allow_viewer_share_links === 1;
    if (!can(access.capabilities, 'share_link.create') && !viewerShareAllowed) {
      return c.json({ error: 'Forbidden: share permission required' }, 403);
    }

    // `viewer` / `viewer_uploader` can create links but cannot manage them, so
    // every link they create must stay display-only.
    const canManageLinks = can(access.capabilities, 'share_link.manage');
    const viewOnlyRestricted = isViewerRole || !canManageLinks;

    let permissionLevel: SharePermissionLevel = isSharePermissionLevel(
      body.permissionLevel
    )
      ? body.permissionLevel
      : body.canDownload === false
        ? 'view'
        : 'download';

    if (viewOnlyRestricted && permissionLevel !== 'view') {
      // Legacy callers (and the current SharePopover for viewer_uploader) omit
      // `permissionLevel`; keep their historic display-only clamp. An explicit
      // request for download/edit is a policy violation.
      if (body.permissionLevel !== undefined) {
        return c.json(
          {
            error:
              'Trusted view-only link creation is limited to display-only links',
            code: 'SHARED_LINK_VIEWER_VIEW_ONLY',
          },
          403
        );
      }
      permissionLevel = 'view';
    }
    if (viewOnlyRestricted) {
      permissionLevel = 'view';
    }

    const folderToCheck = body.targetType === 'folder' ? targetId : access.folderId;
    const effectiveClassification: ClassificationLabel =
      access.classification === 'confidential' || ancestorConf
        ? 'confidential'
        : access.classification;
    const isConfidential = effectiveClassification === 'confidential';

    if (
      (effectiveClassification === 'confidential' || effectiveClassification === 'unset') &&
      accessScope === 'public'
    ) {
      return c.json(
        {
          error: `Public links are forbidden for ${effectiveClassification} content`,
          code: 'PUBLIC_SHARE_FORBIDDEN_FOR_CLASSIFICATION',
        },
        403
      );
    }

    if (policy.enforce_company_only_links === 1 && accessScope === 'public') {
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
      // Preserve the legacy governance clamp: confidential links are always
      // display-only with a mandatory watermark.
      permissionLevel = 'view';
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
      if (accessScope === 'public') {
        if (policy.allow_public_edit_links !== 1) {
          return c.json(
            {
              error: 'Public edit links are disabled by tenant policy',
              code: 'PUBLIC_EDIT_LINK_DISABLED',
            },
            403
          );
        }
        const hasPassword =
          typeof body.password === 'string' && body.password.trim().length > 0;
        const hasExplicitExpiry =
          (typeof body.expiresAt === 'string' && body.expiresAt.trim().length > 0) ||
          (typeof body.expiresInDays === 'number' && Number.isFinite(body.expiresInDays));
        if (!hasPassword || !hasExplicitExpiry) {
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

    const maxExpiryDays = isConfidential
      ? CONFIDENTIAL_MAX_EXPIRY_DAYS
      : (policy.max_link_expiration_days ?? DEFAULT_MAX_EXPIRY_DAYS);

    const expiryParsed = parseExpirationIso(
      body.expiresAt,
      body.expiresInDays,
      maxExpiryDays,
      isConfidential
    );
    if (!expiryParsed.ok) {
      return c.json({ error: expiryParsed.error }, 400);
    }

    let maxDownloads: number | null = null;
    if (body.maxDownloads !== undefined && body.maxDownloads !== null) {
      if (
        typeof body.maxDownloads !== 'number' ||
        !Number.isInteger(body.maxDownloads) ||
        body.maxDownloads < 1 ||
        body.maxDownloads > 1_000_000
      ) {
        return c.json({ error: 'maxDownloads must be a positive integer' }, 400);
      }
      maxDownloads = body.maxDownloads;
    }

    let passwordHash: string | null = null;
    if (body.password !== undefined && body.password !== null && body.password !== '') {
      if (typeof body.password !== 'string' || body.password.length > 256) {
        return c.json({ error: 'password must be a string up to 256 characters' }, 400);
      }
      passwordHash = await hashSharePassword(body.password);
    }

    const canDownload =
      canDownloadForPermissionLevel(permissionLevel) === 1 && !isConfidential;
    const requireWatermark =
      isConfidential || viewOnlyRestricted || permissionLevel === 'view'
        ? true
        : Boolean(body.requireWatermark);

    const linkId = crypto.randomUUID();
    const rawToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const nowIso = new Date().toISOString();

    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, permission_level, require_watermark, password_hash,
           expires_at, max_downloads, download_count, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).bind(
        linkId,
        user.tenantId,
        tokenHash,
        body.targetType,
        targetId,
        accessScope,
        canDownload ? 1 : 0,
        permissionLevel,
        requireWatermark ? 1 : 0,
        passwordHash,
        expiryParsed.expiresAt,
        maxDownloads,
        user.id,
        nowIso
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'shared_link.create',
        targetType: body.targetType,
        targetId,
        classificationSnapshot: effectiveClassification,
        metadata: {
          linkId,
          accessScope,
          permissionLevel,
          canDownload,
          requireWatermark,
          hasPassword: Boolean(passwordHash),
          expiresAt: expiryParsed.expiresAt,
          maxDownloads,
        },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'shared_link',
        entityId: linkId,
        folderId: folderToCheck,
        targetUserId: user.id,
        action: 'shared_link.create',
        payload: {
          linkId,
          targetType: body.targetType,
          targetId,
          accessScope,
          permissionLevel,
          canDownload,
          requireWatermark,
          expiresAt: expiryParsed.expiresAt,
          maxDownloads,
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'shared_link.create',
      scopeFolderIds: [folderToCheck],
    });

    const created = await c.env.DB.prepare('SELECT * FROM shared_links WHERE id = ?')
      .bind(linkId)
      .first<SharedLinkRow>();

    return c.json(
      {
        link: created ? formatLinkSummary(created) : null,
        token: rawToken,
        shareUrl: `/s/${rawToken}`,
      },
      201
    );
  });
}
