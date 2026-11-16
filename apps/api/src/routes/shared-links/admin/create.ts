import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../../services/audit';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../../services/authorization';
import { can } from '../../../services/capabilities';
import { generateRandomToken, sha256Hex } from '../../../services/crypto-utils';
import { hashSharePassword } from '../../../services/shared-link-security';
import { buildSyncChangeStmt } from '../../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../../services/sync-notifier';
import type { ClassificationLabel, ShareAccessScope } from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import {
  CONFIDENTIAL_MAX_EXPIRY_DAYS,
  DEFAULT_MAX_EXPIRY_DAYS,
  SharedLinkRow,
  TenantPolicyRow,
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

    if (!can(access.capabilities, 'share_link.create')) {
      return c.json({ error: 'Forbidden: share permission required' }, 403);
    }

    // `viewer_uploader` can create links but cannot manage them, so its links
    // must be display-only (no download) to stay inside its capability set.
    const canManageLinks = can(access.capabilities, 'share_link.manage');

    const folderToCheck = body.targetType === 'folder' ? targetId : access.folderId;
    const [policy, ancestorConf] = await Promise.all([
      c.env.DB.prepare(
        'SELECT enforce_company_only_links, require_watermark_confidential, max_link_expiration_days FROM tenant_policies WHERE tenant_id = ?'
      )
        .bind(user.tenantId)
        .first<TenantPolicyRow>(),
      hasConfidentialAncestor(c.env.DB, user.tenantId, folderToCheck),
    ]);

    const effectiveClassification: ClassificationLabel =
      access.classification === 'confidential' || ancestorConf
        ? 'confidential'
        : access.classification;

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

    if (policy?.enforce_company_only_links === 1 && accessScope === 'public') {
      return c.json(
        {
          error: 'Tenant policy enforces company-only shared links',
          code: 'PUBLIC_SHARE_DISABLED_BY_POLICY',
        },
        403
      );
    }

    const isConfidential = effectiveClassification === 'confidential';
    const maxExpiryDays = isConfidential
      ? CONFIDENTIAL_MAX_EXPIRY_DAYS
      : (policy?.max_link_expiration_days ?? DEFAULT_MAX_EXPIRY_DAYS);

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

    // Server-side governance enforcement for confidential items
    const canDownload = isConfidential
      ? false
      : canManageLinks && body.canDownload !== false;
    const requireWatermark = isConfidential || !canManageLinks
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
           can_download, require_watermark, password_hash, expires_at,
           max_downloads, download_count, created_by, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).bind(
        linkId,
        user.tenantId,
        tokenHash,
        body.targetType,
        targetId,
        accessScope,
        canDownload ? 1 : 0,
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
