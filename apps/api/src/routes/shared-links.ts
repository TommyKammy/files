import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  sessionAuthMiddleware,
  shouldUseSecureHostCookie,
} from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import { generateRandomToken, sha256Hex } from '../services/crypto-utils';
import {
  getShareUnlockCookieName,
  getShareUnlockSecret,
  hashSharePassword,
  isActiveWebContent,
  issueShareUnlockToken,
  maskViewerIp,
  verifySharePassword,
  verifyShareUnlockToken,
} from '../services/shared-link-security';
import {
  issueSignedStorageUrl,
  resolveSafeDisposition,
} from '../services/storage-url-provider';
import { buildSyncChangeStmt } from '../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../services/sync-notifier';
import type {
  AuthUser,
  ClassificationLabel,
  ShareAccessScope,
} from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIDENTIAL_MAX_EXPIRY_DAYS = 7;
const DEFAULT_MAX_EXPIRY_DAYS = 30;
const MAX_PASSWORD_FAILURES = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const PREVIEW_URL_TTL_SECONDS = 300;
const VALID_SCOPES = new Set<ShareAccessScope>([
  'public',
  'company_only',
  'collaborators_only',
]);

interface SharedLinkRow {
  id: string;
  tenant_id: string;
  token_hash: string;
  target_type: 'file' | 'folder';
  target_id: string;
  access_scope: ShareAccessScope;
  can_download: number;
  require_watermark: number;
  password_hash: string | null;
  failed_password_attempts: number;
  locked_until: string | null;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  created_by: string;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
}

interface TenantPolicyRow {
  enforce_company_only_links: number;
  require_watermark_confidential: number;
  max_link_expiration_days: number;
}

interface ShareTargetFileRow {
  id: string;
  tenant_id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number;
  upload_state: string;
  classification: ClassificationLabel;
  deleted_at: string | null;
  r2_object_key: string | null;
}

interface ShareTargetFolderRow {
  id: string;
  tenant_id: string;
  name: string;
  classification: ClassificationLabel;
  deleted_at: string | null;
}

function getClientIp(req: { header: (name: string) => string | undefined }, user: AuthUser | null): string {
  return (
    user?.ipAddress ??
    req.header('CF-Connecting-IP') ??
    req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

function formatLinkSummary(row: SharedLinkRow) {
  const nowMs = Date.now();
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    accessScope: row.access_scope,
    canDownload: row.can_download === 1,
    requireWatermark: row.require_watermark === 1,
    hasPassword: Boolean(row.password_hash),
    isLocked: Boolean(row.locked_until && Date.parse(row.locked_until) > nowMs),
    lockedUntil: row.locked_until,
    expiresAt: row.expires_at,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function parseExpirationIso(
  expiresAtRaw: unknown,
  expiresInDaysRaw: unknown,
  maxDays: number,
  forceDeadline: boolean
): { ok: true; expiresAt: string | null } | { ok: false; error: string } {
  const nowMs = Date.now();
  const maxMs = nowMs + maxDays * DAY_MS;

  let requestedMs: number | null = null;
  if (typeof expiresAtRaw === 'string' && expiresAtRaw.trim()) {
    const parsed = Date.parse(expiresAtRaw.trim());
    if (Number.isNaN(parsed)) {
      return { ok: false, error: 'Invalid expiresAt ISO timestamp' };
    }
    requestedMs = parsed;
  } else if (typeof expiresInDaysRaw === 'number' && Number.isFinite(expiresInDaysRaw)) {
    if (expiresInDaysRaw <= 0) {
      return { ok: false, error: 'expiresInDays must be positive' };
    }
    requestedMs = nowMs + expiresInDaysRaw * DAY_MS;
  }

  if (requestedMs !== null) {
    if (requestedMs <= nowMs) {
      return { ok: false, error: 'Expiration timestamp must be in the future' };
    }
    return {
      ok: true,
      expiresAt: new Date(Math.min(requestedMs, maxMs)).toISOString(),
    };
  }

  return {
    ok: true,
    expiresAt: forceDeadline ? new Date(maxMs).toISOString() : null,
  };
}

async function hasConfidentialAncestor(
  db: D1Database,
  tenantId: string,
  folderId: string | null
): Promise<boolean> {
  if (!folderId) return false;
  const hit = await db
    .prepare(
      `SELECT 1 FROM folder_closures fc
       JOIN folders f ON f.id = fc.ancestor_id
       WHERE fc.tenant_id = ? AND fc.descendant_id = ? AND f.classification = 'confidential' AND f.deleted_at IS NULL
       LIMIT 1`
    )
    .bind(tenantId, folderId)
    .first();
  return Boolean(hit);
}

/** Authenticated shared-link management API (`/api/shared-links`) */
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

/** Public & session-scoped share delivery routes (`/api/s/:token/*`) */
export const publicShareRoutes = new Hono<OidcHonoEnv>();

publicShareRoutes.use('*', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
});

publicShareRoutes.use('*', sessionAuthMiddleware({ required: false }));

async function loadAndAuthorizeShareLink(
  db: D1Database,
  rawToken: string,
  user: AuthUser | null
): Promise<
  | { ok: true; link: SharedLinkRow; tokenHash: string }
  | { ok: false; status: 401 | 403 | 404 | 410; error: string; code: string; link?: SharedLinkRow }
> {
  if (!rawToken || rawToken.length < 16) {
    return { ok: false, status: 404, error: 'Shared link not found', code: 'LINK_NOT_FOUND' };
  }
  const tokenHash = await sha256Hex(rawToken);
  const link = await db
    .prepare('SELECT * FROM shared_links WHERE token_hash = ?')
    .bind(tokenHash)
    .first<SharedLinkRow>();

  if (!link) {
    return { ok: false, status: 404, error: 'Shared link not found', code: 'LINK_NOT_FOUND' };
  }
  if (link.revoked_at !== null) {
    return { ok: false, status: 410, error: 'Shared link has been revoked', code: 'LINK_REVOKED' };
  }
  if (link.expires_at && Date.parse(link.expires_at) <= Date.now()) {
    return { ok: false, status: 410, error: 'Shared link has expired', code: 'LINK_EXPIRED' };
  }

  if (link.access_scope !== 'public') {
    if (!user) {
      return {
        ok: false,
        status: 401,
        error: 'Authentication is required to access this shared link',
        code: 'AUTH_REQUIRED',
      };
    }
    if (user.tenantId !== link.tenant_id) {
      return {
        ok: false,
        status: 403,
        error: 'Forbidden: cross-tenant access denied',
        code: 'TENANT_MISMATCH',
        link,
      };
    }
    const userRow = await db
      .prepare('SELECT status FROM users WHERE id = ? AND tenant_id = ?')
      .bind(user.id, user.tenantId)
      .first<{ status: string }>();
    if (!userRow || userRow.status !== 'active') {
      return {
        ok: false,
        status: 403,
        error: 'Forbidden: active user account required',
        code: 'USER_NOT_ACTIVE',
        link,
      };
    }

    if (link.access_scope === 'collaborators_only') {
      const targetAccess = await resolveTargetAccess(
        db,
        user,
        link.target_type,
        link.target_id
      );
      if (!hasAtLeastRole(targetAccess?.effectiveRole, 'previewer')) {
        return {
          ok: false,
          status: 403,
          error: 'Forbidden: collaborator permission required',
          code: 'COLLABORATOR_REQUIRED',
          link,
        };
      }
    }
  }

  return { ok: true, link, tokenHash };
}

function readUnlockToken(
  c: Context<OidcHonoEnv>,
  linkId: string,
  bodyUnlockToken?: unknown
): string | undefined {
  const headerToken = c.req.header('X-Share-Unlock');
  if (headerToken) return headerToken;
  if (typeof bodyUnlockToken === 'string' && bodyUnlockToken) return bodyUnlockToken;
  return getCookie(c, getShareUnlockCookieName(linkId));
}

publicShareRoutes.get('/:token/meta', async (c) => {
  const user = c.get('user');
  const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }
  const { link, tokenHash } = auth;

  let unlocked = true;
  if (link.password_hash) {
    const unlockSecret = getShareUnlockSecret(c.env);
    unlocked = await verifyShareUnlockToken(
      unlockSecret,
      readUnlockToken(c, link.id),
      link.id,
      tokenHash
    );
  }

  let fileMeta: {
    id: string;
    name: string;
    extension: string | null;
    mimeType: string | null;
    sizeBytes: number;
    classification: ClassificationLabel;
  } | null = null;
  let folderMeta: { id: string; name: string; classification: ClassificationLabel } | null = null;
  let folderFiles: Array<{
    id: string;
    name: string;
    mimeType: string | null;
    sizeBytes: number;
    classification: ClassificationLabel;
  }> = [];

  if (link.target_type === 'file') {
    const file = await c.env.DB.prepare(
      `SELECT id, name, extension, mime_type, size_bytes, classification, upload_state, deleted_at
       FROM files WHERE tenant_id = ? AND id = ?`
    )
      .bind(link.tenant_id, link.target_id)
      .first<ShareTargetFileRow>();
    if (!file || file.deleted_at !== null || file.upload_state !== 'active') {
      return c.json({ error: 'Shared file is no longer available', code: 'TARGET_UNAVAILABLE' }, 404);
    }
    if (unlocked) {
      fileMeta = {
        id: file.id,
        name: file.name,
        extension: file.extension,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        classification: file.classification,
      };
    }
  } else {
    const folder = await c.env.DB.prepare(
      'SELECT id, name, classification, deleted_at FROM folders WHERE tenant_id = ? AND id = ?'
    )
      .bind(link.tenant_id, link.target_id)
      .first<ShareTargetFolderRow>();
    if (!folder || folder.deleted_at !== null) {
      return c.json({ error: 'Shared folder is no longer available', code: 'TARGET_UNAVAILABLE' }, 404);
    }
    if (unlocked) {
      folderMeta = {
        id: folder.id,
        name: folder.name,
        classification: folder.classification,
      };
      const listed = await c.env.DB.prepare(
        `SELECT id, name, mime_type, size_bytes, classification
         FROM files
         WHERE tenant_id = ? AND folder_id = ? AND upload_state = 'active' AND deleted_at IS NULL
         ORDER BY name ASC LIMIT 200`
      )
        .bind(link.tenant_id, folder.id)
        .all<{
          id: string;
          name: string;
          mime_type: string | null;
          size_bytes: number;
          classification: ClassificationLabel;
        }>();
      folderFiles = listed.results.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mime_type,
        sizeBytes: f.size_bytes,
        classification: f.classification,
      }));
    }
  }

  const nowMs = Date.now();
  return c.json({
    targetType: link.target_type,
    accessScope: link.access_scope,
    canDownload: link.can_download === 1,
    requireWatermark: link.require_watermark === 1,
    requiresPassword: Boolean(link.password_hash),
    unlocked,
    isLocked: Boolean(link.locked_until && Date.parse(link.locked_until) > nowMs),
    lockedUntil: link.locked_until,
    expiresAt: link.expires_at,
    maxDownloads: link.max_downloads,
    downloadCount: link.download_count,
    file: fileMeta,
    folder: folderMeta,
    folderFiles,
  });
});

publicShareRoutes.post('/:token/verify-password', async (c) => {
  const user = c.get('user');
  const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }
  const { link, tokenHash } = auth;

  if (!link.password_hash) {
    return c.json({ ok: true, unlocked: true });
  }

  const clientIp = getClientIp(c.req, user);
  const nowIso = new Date().toISOString();

  if (link.locked_until && Date.parse(link.locked_until) > Date.now()) {
    await c.env.DB.batch([
      buildAuditLogStmt(c.env.DB, {
        tenantId: link.tenant_id,
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
        actorIp: clientIp,
        action: 'shared_link.password_locked',
        targetType: link.target_type,
        targetId: link.target_id,
        status: 'blocked',
        metadata: { linkId: link.id, lockedUntil: link.locked_until },
        nowIso,
      }),
    ]);
    return c.json(
      {
        error: 'Link is temporarily locked due to too many failed password attempts',
        code: 'LINK_LOCKED',
        lockedUntil: link.locked_until,
      },
      423
    );
  }

  const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
  if (!body || typeof body.password !== 'string') {
    return c.json({ error: 'password is required' }, 400);
  }

  const isMatch = await verifySharePassword(body.password, link.password_hash);
  if (!isMatch) {
    const candidateLockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS).toISOString();
    const updated = await c.env.DB.prepare(
      `UPDATE shared_links
       SET failed_password_attempts = CASE
             WHEN locked_until IS NOT NULL AND julianday(locked_until) <= julianday(?) THEN 1
             ELSE failed_password_attempts + 1
           END,
           locked_until = CASE
             WHEN (
               CASE
                 WHEN locked_until IS NOT NULL AND julianday(locked_until) <= julianday(?) THEN 1
                 ELSE failed_password_attempts + 1
               END
             ) >= ? THEN ?
             ELSE NULL
           END
       WHERE id = ?
       RETURNING failed_password_attempts, locked_until`
    )
      .bind(nowIso, nowIso, MAX_PASSWORD_FAILURES, candidateLockedUntil, link.id)
      .first<{ failed_password_attempts: number; locked_until: string | null }>();

    const attempts = updated?.failed_password_attempts ?? MAX_PASSWORD_FAILURES;
    const lockedUntil = updated?.locked_until ?? null;

    await c.env.DB.batch([
      buildAuditLogStmt(c.env.DB, {
        tenantId: link.tenant_id,
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
        actorIp: clientIp,
        action: 'shared_link.password_failed',
        targetType: link.target_type,
        targetId: link.target_id,
        status: 'blocked',
        metadata: { linkId: link.id, attempts, lockedUntil },
        nowIso,
      }),
    ]);

    if (lockedUntil) {
      return c.json(
        {
          error: 'Too many failed password attempts. Link locked for 15 minutes.',
          code: 'LINK_LOCKED',
          lockedUntil,
          remainingAttempts: 0,
        },
        423
      );
    }

    return c.json(
      {
        error: 'Incorrect password',
        code: 'INVALID_PASSWORD',
        remainingAttempts: Math.max(0, MAX_PASSWORD_FAILURES - attempts),
      },
      401
    );
  }

  const unlockSecret = getShareUnlockSecret(c.env);
  const unlockToken = await issueShareUnlockToken(unlockSecret, link.id, tokenHash);

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE shared_links SET failed_password_attempts = 0, locked_until = NULL WHERE id = ?'
    ).bind(link.id),
    buildAuditLogStmt(c.env.DB, {
      tenantId: link.tenant_id,
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      actorIp: clientIp,
      action: 'shared_link.password_verified',
      targetType: link.target_type,
      targetId: link.target_id,
      status: 'allowed',
      metadata: { linkId: link.id },
      nowIso,
    }),
  ]);

  setCookie(c, getShareUnlockCookieName(link.id), unlockToken, {
    httpOnly: true,
    secure: shouldUseSecureHostCookie(c.env, c.req.url),
    sameSite: 'Lax',
    path: '/api/s',
    maxAge: 1800,
  });

  return c.json({ ok: true, unlocked: true, unlockToken });
});

publicShareRoutes.post('/:token/url', async (c) => {
  const user = c.get('user');
  const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }
  const { link, tokenHash } = auth;
  const clientIp = getClientIp(c.req, user);
  const nowIso = new Date().toISOString();

  const body = (await c.req.json().catch(() => null)) as {
    intent?: unknown;
    fileId?: unknown;
    unlockToken?: unknown;
  } | null;

  if (link.password_hash) {
    if (link.locked_until && Date.parse(link.locked_until) > Date.now()) {
      return c.json(
        { error: 'Shared link is temporarily locked', code: 'LINK_LOCKED', lockedUntil: link.locked_until },
        423
      );
    }
    const unlockSecret = getShareUnlockSecret(c.env);
    const unlocked = await verifyShareUnlockToken(
      unlockSecret,
      readUnlockToken(c, link.id, body?.unlockToken),
      link.id,
      tokenHash
    );
    if (!unlocked) {
      return c.json({ error: 'Password verification required', code: 'PASSWORD_REQUIRED' }, 401);
    }
  }

  const intent: 'preview' | 'download' = body?.intent === 'download' ? 'download' : 'preview';

  // Resolve target file (directly or inside shared folder via folder_closures)
  let fileRow: ShareTargetFileRow | null = null;
  if (link.target_type === 'file') {
    fileRow = await c.env.DB.prepare(
      `SELECT f.id, f.tenant_id, f.folder_id, f.name, f.extension, f.mime_type, f.size_bytes,
              f.upload_state, f.classification, f.deleted_at, fv.r2_object_key
       FROM files f
       JOIN file_versions fv ON fv.id = f.current_version_id
       WHERE f.tenant_id = ? AND f.id = ?`
    )
      .bind(link.tenant_id, link.target_id)
      .first<ShareTargetFileRow>();
  } else {
    if (typeof body?.fileId !== 'string' || !body.fileId.trim()) {
      return c.json({ error: 'fileId is required for folder shared links' }, 400);
    }
    const targetFileId = body.fileId.trim();
    fileRow = await c.env.DB.prepare(
      `SELECT f.id, f.tenant_id, f.folder_id, f.name, f.extension, f.mime_type, f.size_bytes,
              f.upload_state, f.classification, f.deleted_at, fv.r2_object_key
       FROM files f
       JOIN file_versions fv ON fv.id = f.current_version_id
       JOIN folder_closures fc ON fc.tenant_id = f.tenant_id AND fc.descendant_id = f.folder_id
       JOIN folders root ON root.tenant_id = f.tenant_id AND root.id = fc.ancestor_id
       WHERE f.tenant_id = ? AND f.id = ? AND fc.ancestor_id = ? AND root.deleted_at IS NULL`
    )
      .bind(link.tenant_id, targetFileId, link.target_id)
      .first<ShareTargetFileRow>();
  }

  if (!fileRow || fileRow.deleted_at !== null || fileRow.upload_state !== 'active' || !fileRow.r2_object_key) {
    return c.json({ error: 'Shared file not found or unavailable', code: 'TARGET_UNAVAILABLE' }, 404);
  }

  if (intent === 'download' && link.can_download === 0) {
    await c.env.DB.batch([
      buildAuditLogStmt(c.env.DB, {
        tenantId: link.tenant_id,
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
        actorIp: clientIp,
        action: 'shared_link.download_blocked',
        targetType: 'file',
        targetId: fileRow.id,
        classificationSnapshot: fileRow.classification,
        status: 'blocked',
        metadata: { linkId: link.id, reason: 'can_download_disabled' },
        nowIso,
      }),
    ]);
    return c.json(
      { error: 'Downloads are disabled for this preview-only link', code: 'DOWNLOAD_DISABLED' },
      403
    );
  }

  const isActiveContent = isActiveWebContent(fileRow.name, fileRow.mime_type);
  if (intent === 'preview' && isActiveContent && link.can_download === 0) {
    await c.env.DB.batch([
      buildAuditLogStmt(c.env.DB, {
        tenantId: link.tenant_id,
        actorId: user?.id ?? null,
        actorEmail: user?.email ?? null,
        actorIp: clientIp,
        action: 'shared_link.active_content_blocked',
        targetType: 'file',
        targetId: fileRow.id,
        classificationSnapshot: fileRow.classification,
        status: 'blocked',
        metadata: { linkId: link.id, fileName: fileRow.name },
        nowIso,
      }),
    ]);
    return c.json(
      {
        error: 'Inline preview of active HTML/SVG content is blocked on preview-only links',
        code: 'ACTIVE_CONTENT_BLOCKED',
      },
      403
    );
  }

  // Atomic download count check & increment
  let updatedDownloadCount = link.download_count;
  if (intent === 'download') {
    const incremented = await c.env.DB.prepare(
      `UPDATE shared_links
       SET download_count = download_count + 1
       WHERE tenant_id = ?
         AND id = ?
         AND revoked_at IS NULL
         AND can_download = 1
         AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))
         AND (max_downloads IS NULL OR download_count < max_downloads)
       RETURNING download_count`
    )
      .bind(link.tenant_id, link.id, nowIso)
      .first<{ download_count: number }>();

    if (!incremented) {
      await c.env.DB.batch([
        buildAuditLogStmt(c.env.DB, {
          tenantId: link.tenant_id,
          actorId: user?.id ?? null,
          actorEmail: user?.email ?? null,
          actorIp: clientIp,
          action: 'shared_link.download_limit_exceeded',
          targetType: 'file',
          targetId: fileRow.id,
          classificationSnapshot: fileRow.classification,
          status: 'blocked',
          metadata: { linkId: link.id, maxDownloads: link.max_downloads },
          nowIso,
        }),
      ]);
      return c.json(
        { error: 'Shared link download limit exceeded or link no longer active', code: 'DOWNLOAD_LIMIT_EXCEEDED' },
        403
      );
    }
    updatedDownloadCount = incremented.download_count;
  }

  // Never serve active HTML/SVG inline; render as attachment & plain text
  const safeDisposition = resolveSafeDisposition(
    intent === 'download' ? 'attachment' : 'inline',
    fileRow.name,
    fileRow.mime_type ?? undefined
  );
  const safeContentType =
    intent === 'preview' && isActiveContent
      ? 'text/plain; charset=utf-8'
      : fileRow.mime_type ?? 'application/octet-stream';

  const signed = await issueSignedStorageUrl(c.env, {
    method: 'GET',
    objectKey: fileRow.r2_object_key,
    tenantId: link.tenant_id,
    expiresInSeconds: PREVIEW_URL_TTL_SECONDS,
    disposition: safeDisposition,
    filename: fileRow.name,
    contentType: safeContentType,
  });

  const requireWatermark =
    link.require_watermark === 1 || fileRow.classification === 'confidential';
  const viewerIdentifier = user?.email ?? `anon:${maskViewerIp(clientIp)}`;
  const watermarkText = requireWatermark ? `${viewerIdentifier} • ${nowIso}` : null;

  await c.env.DB.batch([
    buildAuditLogStmt(c.env.DB, {
      tenantId: link.tenant_id,
      actorId: user?.id ?? null,
      actorEmail: user?.email ?? null,
      actorIp: clientIp,
      action: intent === 'download' ? 'shared_link.download' : 'shared_link.preview',
      targetType: 'file',
      targetId: fileRow.id,
      classificationSnapshot: fileRow.classification,
      status: 'allowed',
      metadata: {
        linkId: link.id,
        disposition: safeDisposition,
        requireWatermark,
        downloadCount: updatedDownloadCount,
      },
      nowIso,
    }),
  ]);

  return c.json({
    url: signed.url,
    expiresAt: signed.expiresAt,
    expiresInSeconds: PREVIEW_URL_TTL_SECONDS,
    disposition: safeDisposition,
    safeRenderMode: isActiveContent ? 'source_text' : 'standard',
    requireWatermark,
    watermarkText,
    viewerIdentifier,
    downloadCount: updatedDownloadCount,
    maxDownloads: link.max_downloads,
    file: {
      id: fileRow.id,
      name: fileRow.name,
      mimeType: fileRow.mime_type,
      sizeBytes: fileRow.size_bytes,
      classification: fileRow.classification,
    },
  });
});
