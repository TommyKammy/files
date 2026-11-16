import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../../services/audit';
import { encryptCookiePayload, generateRandomToken } from '../../../services/crypto-utils';
import { buildR2ObjectKey, FileUploadError, getTenantQuotaStatus, validateFileNameAndExt } from '../../../services/file-upload-common';
import { getShareUnlockSecret } from '../../../services/shared-link-security';
import { issueSignedStorageUrl } from '../../../services/storage-url-provider';
import type { OidcHonoEnv } from '../../../types/oidc';
import {
  DANGEROUS_EXTENSIONS,
  DEFAULT_RATE_LIMIT_PER_MIN,
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

export function registerPublicFileRequestUploadInitRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/fr/:token/upload-init — validate extension, size, rate-limit, quota & issue upload URL */
  routes.post('/:token/upload-init', async (c) => {
    const loaded = await loadActiveFileRequest(c.env.DB, c.req.param('token'));
    if (!loaded.ok) {
      return c.json({ error: loaded.error, code: loaded.code }, loaded.status);
    }
    const fr = loaded.fileRequest;
    const runtimeEnv = c.env as FileRequestRuntimeEnv;
    const clientIp = getClientIp(c.req);

    const body = (await c.req.json().catch(() => null)) as {
      fileName?: unknown;
      mimeType?: unknown;
      sizeBytes?: unknown;
      submitterEmail?: unknown;
      turnstileToken?: unknown;
    } | null;

    // Rate limit check per IP & per file request in trailing 60s window
    const parsedLimit = Number.parseInt(runtimeEnv.FILE_REQUEST_RATE_LIMIT_PER_MIN ?? '', 10);
    const ipLimitPerMin =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_RATE_LIMIT_PER_MIN;
    const windowStartIso = new Date(Date.now() - 60_000).toISOString();

    const rateStats = await c.env.DB.prepare(
      `SELECT
         SUM(CASE WHEN actor_ip = ? THEN 1 ELSE 0 END) AS ip_hits,
         COUNT(*) AS token_hits
       FROM audit_logs
       WHERE tenant_id = ? AND action = 'file_request.upload_init' AND created_at >= ?
         AND metadata_json LIKE ?`
    )
      .bind(clientIp, fr.tenant_id, windowStartIso, `%${fr.id}%`)
      .first<{ ip_hits: number | null; token_hits: number | null }>();

    const nowIso = new Date().toISOString();
    if ((rateStats?.ip_hits ?? 0) >= ipLimitPerMin || (rateStats?.token_hits ?? 0) >= ipLimitPerMin * 3) {
      await c.env.DB.batch([
        buildAuditLogStmt(c.env.DB, {
          tenantId: fr.tenant_id,
          actorId: null,
          actorEmail: null,
          actorIp: clientIp,
          action: 'file_request.rate_limited',
          targetType: 'folder',
          targetId: fr.folder_id,
          status: 'blocked',
          metadata: { fileRequestId: fr.id, ipHits: rateStats?.ip_hits ?? 0 },
          nowIso,
        }),
      ]);
      return c.json(
        { error: 'Rate limit exceeded. Please wait before submitting more files.', code: 'RATE_LIMIT_EXCEEDED' },
        429
      );
    }

    // Optional Turnstile check when secret configured
    if (runtimeEnv.TURNSTILE_SECRET_KEY) {
      if (typeof body?.turnstileToken !== 'string' || !body.turnstileToken.trim()) {
        return c.json(
          { error: 'Turnstile challenge token required', code: 'TURNSTILE_FAILED' },
          403
        );
      }
      const turnstileOk = await verifyTurnstileToken(
        runtimeEnv.TURNSTILE_SECRET_KEY,
        body.turnstileToken.trim(),
        clientIp
      );
      if (!turnstileOk) {
        return c.json(
          { error: 'Turnstile challenge verification failed', code: 'TURNSTILE_FAILED' },
          403
        );
      }
    }

    if (!body || typeof body.sizeBytes !== 'number' || !Number.isInteger(body.sizeBytes) || body.sizeBytes < 1) {
      return c.json({ error: 'fileName and positive integer sizeBytes are required' }, 400);
    }
    if (body.sizeBytes > fr.max_file_size_bytes) {
      return c.json(
        {
          error: `File exceeds maximum allowed size of ${fr.max_file_size_bytes} bytes`,
          code: 'FILE_SIZE_LIMIT_EXCEEDED',
        },
        413
      );
    }

    let submitterEmail: string | null = null;
    if (typeof body.submitterEmail === 'string' && body.submitterEmail.trim()) {
      const trimmedEmail = body.submitterEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail) || trimmedEmail.length > 254) {
        return c.json({ error: 'Invalid submitterEmail format' }, 400);
      }
      submitterEmail = trimmedEmail;
    } else if (fr.require_submitter_email === 1) {
      return c.json({ error: 'submitterEmail is required for this file request', code: 'EMAIL_REQUIRED' }, 400);
    }

    let validatedName: string;
    let extension: string | null;
    try {
      const parsed = validateFileNameAndExt(body.fileName);
      validatedName = parsed.name;
      extension = parsed.extension;
    } catch (err) {
      if (err instanceof FileUploadError) {
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      throw err;
    }

    if (extension && DANGEROUS_EXTENSIONS.has(extension)) {
      await c.env.DB.batch([
        buildAuditLogStmt(c.env.DB, {
          tenantId: fr.tenant_id,
          actorId: null,
          actorEmail: submitterEmail,
          actorIp: clientIp,
          action: 'file_request.blocked_extension',
          targetType: 'folder',
          targetId: fr.folder_id,
          status: 'blocked',
          metadata: { fileRequestId: fr.id, extension },
          nowIso,
        }),
      ]);
      return c.json(
        { error: `File extension .${extension} is not permitted`, code: 'DANGEROUS_EXTENSION_BLOCKED' },
        403
      );
    }

    const allowedList = parseAllowedExtensionsJson(fr.allowed_extensions);
    if (allowedList && (!extension || !allowedList.includes(extension))) {
      return c.json(
        {
          error: `Only files with extensions [${allowedList.join(', ')}] are accepted`,
          code: 'EXTENSION_NOT_ALLOWED',
        },
        400
      );
    }

    const quota = await getTenantQuotaStatus(c.env.DB, fr.tenant_id);
    if (quota.usedBytes + body.sizeBytes > quota.quotaBytes) {
      return c.json(
        { error: 'Tenant storage quota exceeded', code: 'QUOTA_EXCEEDED' },
        413
      );
    }

    // Duplicate filename check in destination folder -> append YYYYMMDDHHmmss without exposing existence
    let storedName = validatedName;
    const existing = await c.env.DB.prepare(
      `SELECT id FROM files
       WHERE tenant_id = ? AND folder_id = ? AND name = ? AND deleted_at IS NULL AND upload_state != 'failed'`
    )
      .bind(fr.tenant_id, fr.folder_id, storedName)
      .first();

    if (existing) {
      storedName = appendTimestampSuffix(validatedName, new Date());
      const stillExists = await c.env.DB.prepare(
        `SELECT id FROM files
         WHERE tenant_id = ? AND folder_id = ? AND name = ? AND deleted_at IS NULL AND upload_state != 'failed'`
      )
        .bind(fr.tenant_id, fr.folder_id, storedName)
        .first();
      if (stillExists) {
        storedName = appendTimestampSuffix(validatedName, new Date(), generateRandomToken(3));
      }
    }

    const classification = await resolveFolderRequestClassification(
      c.env.DB,
      fr.tenant_id,
      fr.folder_id
    );
    const mimeType =
      typeof body.mimeType === 'string' && body.mimeType.trim()
        ? body.mimeType.trim()
        : 'application/octet-stream';

    const fileId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const r2ObjectKey = buildR2ObjectKey(fr.tenant_id, fileId, 1);

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, classification,
           created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, ?, ?)`
      ).bind(
        fileId,
        fr.tenant_id,
        fr.folder_id,
        storedName,
        extension,
        mimeType,
        body.sizeBytes,
        versionId,
        classification,
        fr.created_by,
        fr.created_by,
        nowIso,
        nowIso
      ),
      c.env.DB.prepare(
        `INSERT INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key,
           size_bytes, mime_type, upload_status, uploaded_by, created_at
         ) VALUES (?, ?, ?, 1, ?, ?, ?, 'pending', ?, ?)`
      ).bind(
        versionId,
        fr.tenant_id,
        fileId,
        r2ObjectKey,
        body.sizeBytes,
        mimeType,
        fr.created_by,
        nowIso
      ),
      buildAuditLogStmt(c.env.DB, {
        tenantId: fr.tenant_id,
        actorId: null,
        actorEmail: submitterEmail ?? 'external-submitter',
        actorIp: clientIp,
        action: 'file_request.upload_init',
        targetType: 'file',
        targetId: fileId,
        classificationSnapshot: classification,
        status: 'allowed',
        metadata: {
          fileRequestId: fr.id,
          fileName: storedName,
          sizeBytes: body.sizeBytes,
        },
        nowIso,
      }),
    ]);

    const signedPut = await issueSignedStorageUrl(c.env, {
      method: 'PUT',
      objectKey: r2ObjectKey,
      tenantId: fr.tenant_id,
      expiresInSeconds: 900,
      maxSizeBytes: body.sizeBytes,
      contentType: mimeType,
    });

    const grantSecret = getShareUnlockSecret(c.env);
    const submissionToken = await encryptCookiePayload(grantSecret, {
      requestId: fr.id,
      fileId,
      versionId,
      submitterEmail,
      exp: Date.now() + SUBMISSION_TOKEN_TTL_MS,
    } satisfies SubmissionGrantPayload);

    return c.json(
      {
        fileId,
        versionId,
        submissionToken,
        uploadUrl: signedPut.url,
        method: signedPut.method,
        requiredHeaders: signedPut.requiredHeaders,
        expiresAt: signedPut.expiresAt,
      },
      201
    );
  });


}
