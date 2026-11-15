import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  sessionAuthMiddleware,
  shouldUseSecureHostCookie,
} from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import { generateRandomToken, sha256Hex } from '../../services/crypto-utils';
import {
  getShareUnlockCookieName,
  getShareUnlockSecret,
  hashSharePassword,
  isActiveWebContent,
  issueShareUnlockToken,
  maskViewerIp,
  verifySharePassword,
  verifyShareUnlockToken,
} from '../../services/shared-link-security';
import {
  issueSignedStorageUrl,
  resolveSafeDisposition,
} from '../../services/storage-url-provider';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type {
  AuthUser,
  ClassificationLabel,
  ShareAccessScope,
} from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  CONFIDENTIAL_MAX_EXPIRY_DAYS,
  DEFAULT_MAX_EXPIRY_DAYS,
  SharedLinkRow,
  TenantPolicyRow,
  VALID_SCOPES,
  formatLinkSummary,
  hasConfidentialAncestor,
  parseExpirationIso,
} from './shared';

export const sharedLinksRoutes = new Hono<OidcHonoEnv>();
sharedLinksRoutes.use('*', sessionAuthMiddleware({ required: true }));

sharedLinksRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const targetType = c.req.query('targetType');
  const targetId = c.req.query('targetId');

  if ((targetType !== 'file' && targetType !== 'folder') || !targetId) {
    return c.json({ error: 'targetType (file|folder) and targetId are required' }, 400);
  }

  const access = await resolveTargetAccess(c.env.DB, user, targetType, targetId);
  if (!access || access.deletedAt !== null) {
    return c.json({ error: 'Target not found' }, 404);
  }
  if (!hasAtLeastRole(access.effectiveRole, 'viewer') && user.role === 'member') {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const rows = await c.env.DB.prepare(
    `SELECT * FROM shared_links
     WHERE tenant_id = ? AND target_type = ? AND target_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`
  )
    .bind(user.tenantId, targetType, targetId)
    .all<SharedLinkRow>();

  return c.json({
    links: rows.results.map(formatLinkSummary),
  });
});

sharedLinksRoutes.post('/', async (c) => {
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

  if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
    return c.json({ error: 'Forbidden: editor role or higher required to share' }, 403);
  }

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
  const canDownload = isConfidential ? false : body.canDownload !== false;
  const requireWatermark = isConfidential
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

sharedLinksRoutes.delete('/:id', async (c) => {
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

  let targetFolderId: string | null = link.target_type === 'folder' ? link.target_id : null;
  if (
    link.created_by !== user.id &&
    user.role !== 'sys_admin' &&
    user.role !== 'sec_admin'
  ) {
    const access = await resolveTargetAccess(
      c.env.DB,
      user,
      link.target_type,
      link.target_id
    );
    if (!hasAtLeastRole(access?.effectiveRole, 'editor')) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    targetFolderId = link.target_type === 'folder' ? link.target_id : (access?.folderId ?? null);
  } else if (link.target_type === 'file') {
    const fileRow = await c.env.DB.prepare(
      'SELECT folder_id FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, link.target_id)
      .first<{ folder_id: string | null }>();
    targetFolderId = fileRow?.folder_id ?? null;
  }

  const nowIso = new Date().toISOString();
  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE shared_links SET revoked_at = ?, revoked_by = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL'
    ).bind(nowIso, user.id, user.tenantId, linkId),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'shared_link.revoke',
      targetType: link.target_type,
      targetId: link.target_id,
      metadata: { linkId },
      nowIso,
    }),
    buildSyncChangeStmt(c.env.DB, {
      tenantId: user.tenantId,
      entityType: 'shared_link',
      entityId: linkId,
      folderId: targetFolderId,
      targetUserId: link.created_by,
      action: 'shared_link.revoke',
      payload: {
        linkId,
        targetType: link.target_type,
        targetId: link.target_id,
        revokedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  await emitTenantSyncSignal(c, {
    tenantId: user.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind: 'shared_link.revoke',
    scopeFolderIds: [targetFolderId],
    revoked: true,
  });

  return c.json({ ok: true, revokedAt: nowIso });
});

