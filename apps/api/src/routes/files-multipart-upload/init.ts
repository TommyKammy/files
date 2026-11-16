import { Hono } from 'hono';
import { getAuthenticatedUser } from '../../services/authorization';
import { initializePendingUpload } from '../../services/file-upload-common';
import { computeMultipartPlan, INITIAL_SIGNED_PARTS_LIMIT, initiateMultipartUpload } from '../../services/multipart-storage-provider';
import { issueSignedMultipartPartUrl } from '../../services/storage-url-provider';
import type { ClassificationLabel } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import { VALID_CLASSIFICATIONS } from '../../utils/classification';
import {
  MIN_MULTIPART_INIT_BYTES,
  handleMultipartError,
} from './shared';

export function registerMultipartInitRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/files/multipart/init — start multipart upload & issue up to 50 initial part URLs */
  routes.post('/init', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      folderId?: string | null;
      fileName?: unknown;
      mimeType?: string;
      sizeBytes?: number;
      classification?: ClassificationLabel;
      conflictPolicy?: 'fail' | 'new_version';
    } | null;

    if (!body || typeof body.sizeBytes !== 'number') {
      return c.json({ error: 'fileName and numeric sizeBytes are required' }, 400);
    }
    if (body.sizeBytes < MIN_MULTIPART_INIT_BYTES) {
      return c.json(
        {
          error: 'Files smaller than 5 MiB must use single upload (/api/files/upload-init)',
          code: 'USE_SINGLE_UPLOAD',
        },
        400
      );
    }
    if (body.classification !== undefined && !VALID_CLASSIFICATIONS.has(body.classification)) {
      return c.json({ error: 'Invalid classification value' }, 400);
    }

    const mimeType =
      typeof body.mimeType === 'string' && body.mimeType.trim()
        ? body.mimeType.trim()
        : 'application/octet-stream';

    try {
      const initialized = await initializePendingUpload(c.env.DB, user, {
        folderId: body.folderId ?? null,
        fileName: body.fileName,
        mimeType,
        sizeBytes: body.sizeBytes,
        requestedClassification: body.classification,
        conflictPolicy: body.conflictPolicy === 'new_version' ? 'new_version' : 'fail',
        multipart: true,
      });

      let uploadId: string;
      try {
        uploadId = await initiateMultipartUpload(c.env, initialized.r2ObjectKey, mimeType);
        await c.env.DB.prepare('UPDATE file_versions SET r2_upload_id = ? WHERE id = ?')
          .bind(uploadId, initialized.versionId)
          .run();
      } catch (initErr) {
        // Clean up pending DB rows so abandoned init leaves zero dangling pending state
        const cleanupStmts: D1PreparedStatement[] = [
          c.env.DB.prepare('DELETE FROM file_versions WHERE id = ?').bind(initialized.versionId),
        ];
        if (!initialized.isNewVersion) {
          cleanupStmts.push(
            c.env.DB.prepare("DELETE FROM permissions WHERE target_type = 'file' AND target_id = ?").bind(
              initialized.fileId
            ),
            c.env.DB.prepare('DELETE FROM files WHERE id = ?').bind(initialized.fileId)
          );
        }
        await c.env.DB.batch(cleanupStmts);
        throw initErr;
      }

      const plan = computeMultipartPlan(body.sizeBytes);
      const initialCount = Math.min(plan.totalParts, INITIAL_SIGNED_PARTS_LIMIT);
      const signedParts = await Promise.all(
        Array.from({ length: initialCount }, (_, idx) =>
          issueSignedMultipartPartUrl(c.env, {
            objectKey: initialized.r2ObjectKey,
            tenantId: user.tenantId,
            uploadId,
            partNumber: idx + 1,
            maxSizeBytes: plan.partSizeBytes,
            expiresInSeconds: 3600,
          })
        )
      );

      return c.json(
        {
          fileId: initialized.fileId,
          versionId: initialized.versionId,
          versionNum: initialized.versionNum,
          uploadId,
          r2ObjectKey: initialized.r2ObjectKey,
          classification: initialized.classification,
          partSizeBytes: plan.partSizeBytes,
          totalParts: plan.totalParts,
          parts: signedParts,
        },
        201
      );
    } catch (err) {
      return handleMultipartError(c, err);
    }
  });


}
