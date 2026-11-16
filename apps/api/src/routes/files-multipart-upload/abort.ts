import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import { type FileRow, type FileVersionRow } from '../../services/file-upload-common';
import { abortMultipartUpload } from '../../services/multipart-storage-provider';
import type { OidcHonoEnv } from '../../types/oidc';

export function registerMultipartAbortRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/files/multipart/abort — abort R2 multipart upload & clean pending DB state */
  routes.post('/abort', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      fileId?: string;
      versionId?: string;
    } | null;

    if (!body?.fileId || !body?.versionId) {
      return c.json({ error: 'fileId and versionId are required' }, 400);
    }

    const [file, version] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
        .bind(user.tenantId, body.fileId)
        .first<FileRow>(),
      c.env.DB.prepare(
        'SELECT * FROM file_versions WHERE tenant_id = ? AND file_id = ? AND id = ?'
      )
        .bind(user.tenantId, body.fileId, body.versionId)
        .first<FileVersionRow>(),
    ]);

    if (!file || !version) {
      return c.json({ error: 'Pending upload not found' }, 404);
    }
    if (version.upload_status !== 'pending') {
      return c.json({ error: 'Upload is already finalized or aborted' }, 409);
    }
    if (version.uploaded_by !== user.id) {
      const access = await resolveTargetAccess(c.env.DB, user, 'file', file.id);
      if (!hasAtLeastRole(access?.effectiveRole, 'editor')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
    }

    if (version.r2_upload_id) {
      await abortMultipartUpload(c.env, version.r2_object_key, version.r2_upload_id);
    }
    await c.env.BUCKET.delete(version.r2_object_key).catch(() => {});

    const nowIso = new Date().toISOString();
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM file_versions WHERE tenant_id = ? AND id = ?').bind(
        user.tenantId,
        version.id
      ),
    ];

    if (file.upload_state === 'pending') {
      stmts.push(
        c.env.DB.prepare("DELETE FROM permissions WHERE tenant_id = ? AND target_type = 'file' AND target_id = ?").bind(
          user.tenantId,
          file.id
        ),
        c.env.DB.prepare('DELETE FROM files WHERE tenant_id = ? AND id = ?').bind(
          user.tenantId,
          file.id
        )
      );
    }

    stmts.push(
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'file.multipart_abort',
        targetType: 'file',
        targetId: file.id,
        classificationSnapshot: file.classification,
        metadata: { versionId: version.id, uploadId: version.r2_upload_id },
        nowIso,
      })
    );

    await c.env.DB.batch(stmts);
    return c.json({ ok: true, abortedVersionId: version.id });
  });

}
