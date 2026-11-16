import { Hono } from 'hono';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import { type FileVersionRow } from '../../services/file-upload-common';
import { computeMultipartPlan, MAX_MULTIPART_PARTS, PART_URLS_BATCH_MAX } from '../../services/multipart-storage-provider';
import { issueSignedMultipartPartUrl } from '../../services/storage-url-provider';
import type { OidcHonoEnv } from '../../types/oidc';

export function registerMultipartPartUrlsRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/files/multipart/part-urls — issue signed PUT URLs (max 100 parts per call) */
  routes.post('/part-urls', async (c) => {
    const user = getAuthenticatedUser(c);
    const body = (await c.req.json().catch(() => null)) as {
      fileId?: string;
      versionId?: string;
      partNumbers?: number[];
    } | null;

    if (!body?.fileId || !body?.versionId || !Array.isArray(body.partNumbers)) {
      return c.json({ error: 'fileId, versionId, and partNumbers[] are required' }, 400);
    }
    if (body.partNumbers.length === 0 || body.partNumbers.length > PART_URLS_BATCH_MAX) {
      return c.json(
        { error: `partNumbers must contain between 1 and ${PART_URLS_BATCH_MAX} entries` },
        400
      );
    }

    const version = await c.env.DB.prepare(
      'SELECT * FROM file_versions WHERE tenant_id = ? AND file_id = ? AND id = ?'
    )
      .bind(user.tenantId, body.fileId, body.versionId)
      .first<FileVersionRow>();
    if (!version || version.upload_status !== 'pending' || !version.r2_upload_id) {
      return c.json({ error: 'Active pending multipart upload not found' }, 404);
    }

    if (version.uploaded_by !== user.id) {
      const access = await resolveTargetAccess(c.env.DB, user, 'file', body.fileId);
      if (!hasAtLeastRole(access?.effectiveRole, 'editor')) {
        return c.json({ error: 'Forbidden' }, 403);
      }
    }

    const plan = computeMultipartPlan(version.size_bytes);
    const uniqueParts = [...new Set(body.partNumbers)];
    for (const partNum of uniqueParts) {
      if (!Number.isInteger(partNum) || partNum < 1 || partNum > plan.totalParts || partNum > MAX_MULTIPART_PARTS) {
        return c.json(
          { error: `Invalid partNumber ${partNum} (valid range: 1..${plan.totalParts})` },
          400
        );
      }
    }

    const parts = await Promise.all(
      uniqueParts.map((partNumber) =>
        issueSignedMultipartPartUrl(c.env, {
          objectKey: version.r2_object_key,
          tenantId: user.tenantId,
          uploadId: version.r2_upload_id!,
          partNumber,
          maxSizeBytes: plan.partSizeBytes,
          expiresInSeconds: 3600,
        })
      )
    );

    return c.json({
      fileId: body.fileId,
      versionId: body.versionId,
      uploadId: version.r2_upload_id,
      parts,
    });
  });


}
