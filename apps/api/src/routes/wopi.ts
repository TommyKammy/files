import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import type { FileRow } from '../services/file-upload-common';
import { getFileLockState } from '../services/file-lock';
import { getActiveWopiDraft } from '../services/wopi-drafts';
import { issueWopiSessionToken } from '../services/wopi-token';
import {
  buildWopiSrc,
  getWopiDiscovery,
  resolveWopiActionUrl,
} from '../services/wopi-discovery';
import type { OidcHonoEnv } from '../types/oidc';

export const wopiSessionRoutes = new Hono<OidcHonoEnv>();

wopiSessionRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** POST /api/files/:id/wopi-session — issue a short-lived WOPI access token. */
wopiSessionRoutes.post('/:id/wopi-session', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');

  const [access, file] = await Promise.all([
    resolveTargetAccess(c.env.DB, user, 'file', fileId),
    c.env.DB.prepare(
      'SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
    )
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);

  if (
    !access ||
    !file ||
    access.deletedAt !== null ||
    file.upload_state !== 'active'
  ) {
    return c.json({ error: 'File not found' }, 404);
  }
  if (!hasAtLeastRole(access.effectiveRole, 'previewer')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const role = access.effectiveRole!;
  const lock = await getFileLockState(c.env, fileId);
  const desktopLocked = lock?.mode === 'desktop_exclusive';
  const canWrite = hasAtLeastRole(role, 'editor') && !desktopLocked;
  const dlp = file.classification === 'confidential' || role === 'previewer';
  const readOnlyReason = canWrite
    ? null
    : desktopLocked
      ? 'desktop_lock'
      : dlp
        ? 'dlp'
        : 'permission';

  const [currentVersion, activeDraft] = await Promise.all([
    file.current_version_id
      ? c.env.DB.prepare(
          `SELECT id, r2_object_key FROM file_versions
            WHERE tenant_id = ? AND id = ? LIMIT 1`
        )
          .bind(user.tenantId, file.current_version_id)
          .first<{ id: string; r2_object_key: string }>()
      : null,
    getActiveWopiDraft(c.env.DB, user.tenantId, fileId),
  ]);
  if (!activeDraft) {
    if (!currentVersion) {
      return c.json(
        {
          error: 'このファイルには表示・編集できる実体がありません',
          code: 'WOPI_CONTENT_NOT_FOUND',
        },
        409
      );
    }
    const object = await c.env.BUCKET.head(currentVersion.r2_object_key);
    if (!object) {
      return c.json(
        {
          error: 'このファイルの実体がストレージに見つかりません',
          code: 'WOPI_CONTENT_NOT_FOUND',
        },
        409
      );
    }
  }
  const sessionId = crypto.randomUUID();
  const wopiSrc = buildWopiSrc(c.env, fileId);
  const discovery = await getWopiDiscovery(c.env).catch((err) => {
    console.warn('[wopi] Discovery resolution failed:', err);
    return null;
  });
  const wopiActionUrl = discovery
    ? resolveWopiActionUrl(discovery, {
        extension: file.extension ?? file.name.split('.').pop(),
        canWrite,
        wopiSrc,
      })
    : null;

  const issued = await issueWopiSessionToken(c.env, {
    sessionId,
    fileId,
    tenantId: user.tenantId,
    userId: user.id,
    role,
    canWrite,
  });

  await c.env.DB.prepare(
    `INSERT INTO wopi_sessions (
       id, tenant_id, file_id, user_id, role, can_write,
       access_token_hash, is_active, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`
  )
    .bind(
      sessionId,
      user.tenantId,
      fileId,
      user.id,
      role,
      canWrite ? 1 : 0,
      issued.tokenHash,
      issued.expiresAt
    )
    .run();

  return c.json(
    {
      sessionId,
      fileId,
      fileName: file.name,
      mimeType: file.mime_type,
      classification: file.classification,
      role,
      canWrite,
      readOnly: !canWrite,
      readOnlyReason,
      lockMode: 'wopi_collab',
      accessToken: issued.token,
      accessTokenExpiresAt: issued.expiresAt,
      wopiFileUrl: `/wopi/files/${encodeURIComponent(fileId)}`,
      wopiSrc,
      wopiActionUrl,
      collaboraOrigin: c.env.COLLABORA_URL ?? null,
    },
    201
  );
});
