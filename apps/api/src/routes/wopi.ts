import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import type { FileRow } from '../services/file-upload-common';
import { issueWopiSessionToken } from '../services/wopi-token';
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
  const canWrite = hasAtLeastRole(role, 'editor');
  const sessionId = crypto.randomUUID();
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
      lockMode: 'wopi_collab',
      accessToken: issued.token,
      accessTokenExpiresAt: issued.expiresAt,
      wopiFileUrl: `/wopi/files/${encodeURIComponent(fileId)}`,
    },
    201
  );
});
