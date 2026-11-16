import { type Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  sessionAuthMiddleware,
  shouldUseSecureHostCookie,
} from '../../../middleware/session-auth';
import { buildAuditLogStmt } from '../../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../../services/authorization';
import { generateRandomToken, sha256Hex } from '../../../services/crypto-utils';
import {
  getShareUnlockCookieName,
  getShareUnlockSecret,
  hashSharePassword,
  isActiveWebContent,
  issueShareUnlockToken,
  maskViewerIp,
  verifySharePassword,
  verifyShareUnlockToken,
} from '../../../services/shared-link-security';
import {
  issueSignedStorageUrl,
  resolveSafeDisposition,
} from '../../../services/storage-url-provider';
import { buildSyncChangeStmt } from '../../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../../services/sync-notifier';
import type {
  AuthUser,
  ClassificationLabel,
  ShareAccessScope,
} from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import {
  LOCKOUT_DURATION_MS,
  MAX_PASSWORD_FAILURES,
  PREVIEW_URL_TTL_SECONDS,
  ShareTargetFileRow,
  ShareTargetFolderRow,
  SharedLinkRow,
  getClientIp,
} from '../shared';

import {
  loadAndAuthorizeShareLink,
  readUnlockToken,
} from './public-shared';
export function registerPublicShareUrlRoutes(routes: Hono<OidcHonoEnv>) {
  routes.post('/:token/url', async (c) => {
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
}
