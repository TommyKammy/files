import { buildAuditLogStmt } from '../../../services/audit';
import { generateRandomToken } from '../../../services/crypto-utils';
import {
  FileUploadError,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from '../../../services/file-upload-common';
import {
  DANGEROUS_EXTENSIONS,
  DEFAULT_RATE_LIMIT_PER_MIN,
  FileRequestRuntimeEnv,
  FileRequestRow,
  appendTimestampSuffix,
  parseAllowedExtensionsJson,
  verifyTurnstileToken,
} from '../shared';

export type UploadInitErrorStatus = 400 | 403 | 404 | 409 | 413 | 429;

export interface UploadInitValidation {
  storedName: string;
  extension: string | null;
  sizeBytes: number;
  mimeType: string;
  submitterEmail: string | null;
}

export type UploadInitValidationResult =
  | { ok: true; value: UploadInitValidation }
  | { ok: false; status: UploadInitErrorStatus; body: { error: string; code?: string } };

export async function validateUploadInitRequest({
  db,
  fileRequest,
  runtimeEnv,
  body,
  clientIp,
  nowIso,
}: {
  db: D1Database;
  fileRequest: FileRequestRow;
  runtimeEnv: FileRequestRuntimeEnv;
  body: {
    fileName?: unknown;
    mimeType?: unknown;
    sizeBytes?: unknown;
    submitterEmail?: unknown;
    turnstileToken?: unknown;
  } | null;
  clientIp: string;
  nowIso: string;
}): Promise<UploadInitValidationResult> {
  // Rate limit check per IP & per file request in trailing 60s window
  const parsedLimit = Number.parseInt(
    runtimeEnv.FILE_REQUEST_RATE_LIMIT_PER_MIN ?? '',
    10
  );
  const ipLimitPerMin =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? parsedLimit
      : DEFAULT_RATE_LIMIT_PER_MIN;
  const windowStartIso = new Date(Date.now() - 60_000).toISOString();

  const rateStats = await db
    .prepare(
      `SELECT
         SUM(CASE WHEN actor_ip = ? THEN 1 ELSE 0 END) AS ip_hits,
         COUNT(*) AS token_hits
       FROM audit_logs
       WHERE tenant_id = ? AND action = 'file_request.upload_init' AND created_at >= ?
         AND metadata_json LIKE ?`
    )
    .bind(
      clientIp,
      fileRequest.tenant_id,
      windowStartIso,
      `%${fileRequest.id}%`
    )
    .first<{ ip_hits: number | null; token_hits: number | null }>();

  if (
    (rateStats?.ip_hits ?? 0) >= ipLimitPerMin ||
    (rateStats?.token_hits ?? 0) >= ipLimitPerMin * 3
  ) {
    await db.batch([
      buildAuditLogStmt(db, {
        tenantId: fileRequest.tenant_id,
        actorId: null,
        actorEmail: null,
        actorIp: clientIp,
        action: 'file_request.rate_limited',
        targetType: 'folder',
        targetId: fileRequest.folder_id,
        status: 'blocked',
        metadata: {
          fileRequestId: fileRequest.id,
          ipHits: rateStats?.ip_hits ?? 0,
        },
        nowIso,
      }),
    ]);
    return {
      ok: false,
      status: 429,
      body: {
        error: 'Rate limit exceeded. Please wait before submitting more files.',
        code: 'RATE_LIMIT_EXCEEDED',
      },
    };
  }

  // Optional Turnstile check when secret configured
  if (runtimeEnv.TURNSTILE_SECRET_KEY) {
    if (
      typeof body?.turnstileToken !== 'string' ||
      !body.turnstileToken.trim()
    ) {
      return {
        ok: false,
        status: 403,
        body: {
          error: 'Turnstile challenge token required',
          code: 'TURNSTILE_FAILED',
        },
      };
    }
    const turnstileOk = await verifyTurnstileToken(
      runtimeEnv.TURNSTILE_SECRET_KEY,
      body.turnstileToken.trim(),
      clientIp
    );
    if (!turnstileOk) {
      return {
        ok: false,
        status: 403,
        body: {
          error: 'Turnstile challenge verification failed',
          code: 'TURNSTILE_FAILED',
        },
      };
    }
  }

  if (
    !body ||
    typeof body.sizeBytes !== 'number' ||
    !Number.isInteger(body.sizeBytes) ||
    body.sizeBytes < 1
  ) {
    return {
      ok: false,
      status: 400,
      body: { error: 'fileName and positive integer sizeBytes are required' },
    };
  }
  if (body.sizeBytes > fileRequest.max_file_size_bytes) {
    return {
      ok: false,
      status: 413,
      body: {
        error: `File exceeds maximum allowed size of ${fileRequest.max_file_size_bytes} bytes`,
        code: 'FILE_SIZE_LIMIT_EXCEEDED',
      },
    };
  }

  let submitterEmail: string | null = null;
  if (
    typeof body.submitterEmail === 'string' &&
    body.submitterEmail.trim()
  ) {
    const trimmedEmail = body.submitterEmail.trim().toLowerCase();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail) ||
      trimmedEmail.length > 254
    ) {
      return {
        ok: false,
        status: 400,
        body: { error: 'Invalid submitterEmail format' },
      };
    }
    submitterEmail = trimmedEmail;
  } else if (fileRequest.require_submitter_email === 1) {
    return {
      ok: false,
      status: 400,
      body: {
        error: 'submitterEmail is required for this file request',
        code: 'EMAIL_REQUIRED',
      },
    };
  }

  let validatedName: string;
  let extension: string | null;
  try {
    const parsed = validateFileNameAndExt(body.fileName);
    validatedName = parsed.name;
    extension = parsed.extension;
  } catch (err) {
    if (err instanceof FileUploadError) {
      return {
        ok: false,
        status: err.status,
        body: { error: err.message, code: err.code },
      };
    }
    throw err;
  }

  if (extension && DANGEROUS_EXTENSIONS.has(extension)) {
    await db.batch([
      buildAuditLogStmt(db, {
        tenantId: fileRequest.tenant_id,
        actorId: null,
        actorEmail: submitterEmail,
        actorIp: clientIp,
        action: 'file_request.blocked_extension',
        targetType: 'folder',
        targetId: fileRequest.folder_id,
        status: 'blocked',
        metadata: { fileRequestId: fileRequest.id, extension },
        nowIso,
      }),
    ]);
    return {
      ok: false,
      status: 403,
      body: {
        error: `File extension .${extension} is not permitted`,
        code: 'DANGEROUS_EXTENSION_BLOCKED',
      },
    };
  }

  const allowedList = parseAllowedExtensionsJson(
    fileRequest.allowed_extensions
  );
  if (allowedList && (!extension || !allowedList.includes(extension))) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Only files with extensions [${allowedList.join(', ')}] are accepted`,
        code: 'EXTENSION_NOT_ALLOWED',
      },
    };
  }

  const quota = await getTenantQuotaStatus(db, fileRequest.tenant_id);
  if (quota.usedBytes + body.sizeBytes > quota.quotaBytes) {
    return {
      ok: false,
      status: 413,
      body: { error: 'Tenant storage quota exceeded', code: 'QUOTA_EXCEEDED' },
    };
  }

  // Duplicate filename check in destination folder -> append YYYYMMDDHHmmss without exposing existence
  let storedName = validatedName;
  const existing = await db
    .prepare(
      `SELECT id FROM files
       WHERE tenant_id = ? AND folder_id = ? AND name = ? AND deleted_at IS NULL AND upload_state != 'failed'`
    )
    .bind(fileRequest.tenant_id, fileRequest.folder_id, storedName)
    .first();

  if (existing) {
    storedName = appendTimestampSuffix(validatedName, new Date());
    const stillExists = await db
      .prepare(
        `SELECT id FROM files
         WHERE tenant_id = ? AND folder_id = ? AND name = ? AND deleted_at IS NULL AND upload_state != 'failed'`
      )
      .bind(fileRequest.tenant_id, fileRequest.folder_id, storedName)
      .first();
    if (stillExists) {
      storedName = appendTimestampSuffix(
        validatedName,
        new Date(),
        generateRandomToken(3)
      );
    }
  }

  const mimeType =
    typeof body.mimeType === 'string' && body.mimeType.trim()
      ? body.mimeType.trim()
      : 'application/octet-stream';

  return {
    ok: true,
    value: {
      storedName,
      extension,
      sizeBytes: body.sizeBytes,
      mimeType,
      submitterEmail,
    },
  };
}
