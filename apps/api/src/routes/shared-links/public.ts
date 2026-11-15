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
  LOCKOUT_DURATION_MS,
  MAX_PASSWORD_FAILURES,
  PREVIEW_URL_TTL_SECONDS,
  ShareTargetFileRow,
  ShareTargetFolderRow,
  SharedLinkRow,
  getClientIp,
} from './shared';

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
