import { Hono } from 'hono';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../../services/authorization';
import { can } from '../../services/capabilities';
import { type FileVersionRow, finalizeUploadedVersion } from '../../services/file-upload-common';
import { type CompletedPartInput, completeMultipartUpload } from '../../services/multipart-storage-provider';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';
import { normalizeVersionComment } from '../file-versions/shared';
import {
  handleMultipartError,
} from './shared';

export function registerMultipartCompleteRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/files/multipart/complete — combine parts, head()-verify size & quota, commit D1 + AI queue */
  routes.post('/complete', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      fileId?: string;
      versionId?: string;
      parts?: CompletedPartInput[];
      comment?: unknown;
    } | null;

    if (!body?.fileId || !body?.versionId || !Array.isArray(body.parts) || body.parts.length === 0) {
      return c.json({ error: 'fileId, versionId, and non-empty parts[] are required' }, 400);
    }
    const parsedComment = normalizeVersionComment(body.comment);
    if (!parsedComment.ok) {
      return c.json({ error: parsedComment.error }, 400);
    }

    for (const part of body.parts) {
      if (
        !Number.isInteger(part?.partNumber) ||
        part.partNumber < 1 ||
        typeof part.etag !== 'string' ||
        !part.etag.trim()
      ) {
        return c.json({ error: 'Each part requires integer partNumber and etag' }, 400);
      }
    }

    const version = await c.env.DB.prepare(
      'SELECT * FROM file_versions WHERE tenant_id = ? AND file_id = ? AND id = ?'
    )
      .bind(user.tenantId, body.fileId, body.versionId)
      .first<FileVersionRow>();
    if (!version) {
      return c.json({ error: 'File version not found' }, 404);
    }
    if (version.upload_status !== 'pending' || !version.r2_upload_id) {
      return c.json({ error: 'Multipart upload is not in pending state' }, 409);
    }

    if (version.uploaded_by !== user.id) {
      const access = await resolveTargetAccess(c.env.DB, user, 'file', body.fileId);
      if (!can(access?.capabilities, 'item.upload_version')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
    }

    try {
      await completeMultipartUpload(
        c.env,
        version.r2_object_key,
        version.r2_upload_id,
        body.parts
      );
    } catch (err) {
      return c.json(
        { error: `Failed to assemble multipart upload: ${(err as Error).message}`, code: 'MULTIPART_COMPLETE_FAILED' },
        400
      );
    }

    try {
      const result = await finalizeUploadedVersion(
        c.env.DB,
        c.env.BUCKET,
        c.env.JOBS_QUEUE,
        user,
        { fileId: body.fileId, versionId: body.versionId }
      );
      if (parsedComment.value !== null) {
        await c.env.DB.prepare(
          'UPDATE file_versions SET comment = ? WHERE tenant_id = ? AND id = ?'
        )
          .bind(parsedComment.value, user.tenantId, body.versionId)
          .run();
      }
      await emitTenantSyncSignal(c, {
        tenantId: user.tenantId,
        eventKind: 'file.upload_complete',
        scopeFolderIds: [result.file.folder_id],
      });
      return c.json(result);
    } catch (err) {
      return handleMultipartError(c, err);
    }
  });


}
