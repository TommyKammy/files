import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../../middleware/session-auth';
import { buildAuditLogStmt } from '../../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../../services/authorization';
import {
  decryptCookiePayload,
  encryptCookiePayload,
  generateRandomToken,
  sha256Hex,
  timingSafeEqual,
} from '../../../services/crypto-utils';
import {
  buildR2ObjectKey,
  FileUploadError,
  finalizeUploadedVersion,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from '../../../services/file-upload-common';
import { getShareUnlockSecret } from '../../../services/shared-link-security';
import { issueSignedStorageUrl } from '../../../services/storage-url-provider';
import { emitTenantSyncSignal } from '../../../services/sync-notifier';
import type { AuthUser, ClassificationLabel } from '../../../types/api';
import type { OidcEnv, OidcHonoEnv } from '../../../types/oidc';
import {
  DANGEROUS_EXTENSIONS,
  DEFAULT_RATE_LIMIT_PER_MIN,
  FileRequestRow,
  FileRequestRuntimeEnv,
  SUBMISSION_TOKEN_TTL_MS,
  SubmissionGrantPayload,
  appendTimestampSuffix,
  getClientIp,
  parseAllowedExtensionsJson,
  resolveFolderRequestClassification,
  verifyTurnstileToken,
} from '../shared';
import {
  loadActiveFileRequest,
} from './public-shared';
export function registerPublicFileRequestUploadCompleteRoutes(routes: Hono<OidcHonoEnv>) {
  async function handleFileRequestComplete(c: {
    req: { param: (k: string) => string; json: <T>() => Promise<T>; header: (n: string) => string | undefined };
    env: OidcEnv;
    json: (data: unknown, status?: 200 | 400 | 403 | 404 | 409 | 410 | 413) => Response;
  }) {
    const loaded = await loadActiveFileRequest(c.env.DB, c.req.param('token'));
    if (!loaded.ok) {
      return c.json({ error: loaded.error, code: loaded.code }, loaded.status);
    }
    const fr = loaded.fileRequest;
    const clientIp = getClientIp(c.req);

    const body = (await c.req.json<{
      fileId?: unknown;
      versionId?: unknown;
      submissionToken?: unknown;
    }>().catch(() => null));

    if (
      !body ||
      typeof body.fileId !== 'string' ||
      typeof body.versionId !== 'string' ||
      typeof body.submissionToken !== 'string'
    ) {
      return c.json({ error: 'fileId, versionId, and submissionToken are required' }, 400);
    }

    const grant = await decryptCookiePayload<SubmissionGrantPayload>(
      getShareUnlockSecret(c.env),
      body.submissionToken
    );
    if (
      !grant ||
      grant.exp <= Date.now() ||
      !timingSafeEqual(grant.requestId, fr.id) ||
      !timingSafeEqual(grant.fileId, body.fileId) ||
      !timingSafeEqual(grant.versionId, body.versionId)
    ) {
      return c.json({ error: 'Invalid or expired submissionToken', code: 'INVALID_SUBMISSION_TOKEN' }, 403);
    }

    // Attribute technical DB ownership to fileRequest.created_by while recording submitter in audit_logs
    const syntheticUser: AuthUser = {
      id: fr.created_by,
      tenantId: fr.tenant_id,
      email: grant.submitterEmail ?? 'external-submitter',
      displayName: grant.submitterEmail ?? 'External Submitter',
      role: 'member',
      ipAddress: clientIp,
    };

    try {
      await finalizeUploadedVersion(c.env.DB, c.env.BUCKET, c.env.JOBS_QUEUE, syntheticUser, {
        fileId: body.fileId,
        versionId: body.versionId,
        maxAllowedBytes: fr.max_file_size_bytes + 1,
      });
    } catch (err) {
      if (err instanceof FileUploadError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }

    const nowIso = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE file_requests SET submission_count = submission_count + 1 WHERE tenant_id = ? AND id = ?'
      ).bind(fr.tenant_id, fr.id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: fr.tenant_id,
        actorId: null,
        actorEmail: grant.submitterEmail ?? 'external-submitter',
        actorIp: clientIp,
        action: 'file_request.submitted',
        targetType: 'file',
        targetId: body.fileId,
        status: 'allowed',
        metadata: { fileRequestId: fr.id, folderId: fr.folder_id },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: fr.tenant_id,
      eventKind: 'file.upload_complete',
      scopeFolderIds: [fr.folder_id],
    });

    return c.json({ ok: true, submittedAt: nowIso });
  }

  routes.post('/:token/upload-complete', (c) => handleFileRequestComplete(c));
  routes.post('/:token/complete', (c) => handleFileRequestComplete(c));

}
