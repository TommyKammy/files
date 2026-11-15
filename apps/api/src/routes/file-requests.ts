import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import {
  decryptCookiePayload,
  encryptCookiePayload,
  generateRandomToken,
  sha256Hex,
  timingSafeEqual,
} from '../services/crypto-utils';
import {
  buildR2ObjectKey,
  FileUploadError,
  finalizeUploadedVersion,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from '../services/file-upload-common';
import { getShareUnlockSecret } from '../services/shared-link-security';
import { issueSignedStorageUrl } from '../services/storage-url-provider';
import { emitTenantSyncSignal } from '../services/sync-notifier';
import type { AuthUser, ClassificationLabel } from '../types/api';
import type { OidcEnv, OidcHonoEnv } from '../types/oidc';

const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB
const DEFAULT_RATE_LIMIT_PER_MIN = 15;
const SUBMISSION_TOKEN_TTL_MS = 30 * 60 * 1000;

const DANGEROUS_EXTENSIONS = new Set([
  'exe',
  'bat',
  'cmd',
  'sh',
  'bash',
  'ps1',
  'vbs',
  'vbe',
  'msi',
  'scr',
  'jar',
  'dll',
  'com',
  'pif',
  'html',
  'htm',
  'svg',
  'xhtml',
  'hta',
  'cpl',
  'js',
  'mjs',
  'cjs',
  'php',
  'asp',
  'aspx',
  'jsp',
]);

interface FileRequestRow {
  id: string;
  tenant_id: string;
  folder_id: string;
  token_hash: string;
  title: string;
  description: string | null;
  require_submitter_email: number;
  max_file_size_bytes: number;
  allowed_extensions: string | null;
  submission_count: number;
  expires_at: string | null;
  is_active: number;
  created_by: string;
  created_at: string;
}

interface SubmissionGrantPayload {
  requestId: string;
  fileId: string;
  versionId: string;
  submitterEmail: string | null;
  exp: number;
}

type FileRequestRuntimeEnv = OidcEnv & {
  TURNSTILE_SECRET_KEY?: string;
  FILE_REQUEST_RATE_LIMIT_PER_MIN?: string;
};

function getClientIp(req: { header: (name: string) => string | undefined }): string {
  return (
    req.header('CF-Connecting-IP') ??
    req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

function parseAllowedExtensionsJson(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.replace(/^\./, '').trim().toLowerCase())
      .filter(Boolean);
    return cleaned.length > 0 ? cleaned : null;
  } catch {
    return null;
  }
}

function formatUtcTimestampCompact(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

function appendTimestampSuffix(fileName: string, now: Date, nonceSuffix?: string): string {
  const stamp = formatUtcTimestampCompact(now) + (nonceSuffix ? `_${nonceSuffix}` : '');
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < fileName.length - 1) {
    const base = fileName.slice(0, dotIdx);
    const ext = fileName.slice(dotIdx);
    const maxBaseLen = Math.max(1, 255 - stamp.length - ext.length - 1);
    return `${base.slice(0, maxBaseLen)}_${stamp}${ext}`;
  }
  const maxBaseLen = Math.max(1, 255 - stamp.length - 1);
  return `${fileName.slice(0, maxBaseLen)}_${stamp}`;
}

async function verifyTurnstileToken(
  secretKey: string,
  token: string,
  remoteIp: string
): Promise<boolean> {
  const form = new URLSearchParams();
  form.set('secret', secretKey);
  form.set('response', token);
  if (remoteIp && remoteIp !== 'unknown') {
    form.set('remoteip', remoteIp);
  }
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok) return false;
  const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
  return data?.success === true;
}

async function resolveFolderRequestClassification(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<ClassificationLabel> {
  const row = await db
    .prepare(
      `SELECT 1 FROM folder_closures fc
       JOIN folders f ON f.id = fc.ancestor_id
       WHERE fc.tenant_id = ? AND fc.descendant_id = ? AND f.classification = 'confidential' AND f.deleted_at IS NULL
       LIMIT 1`
    )
    .bind(tenantId, folderId)
    .first();
  // Always default external dropbox submissions to at least 'internal'
  return row ? 'confidential' : 'internal';
}

function formatInternalFileRequest(row: FileRequestRow) {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    description: row.description,
    requireSubmitterEmail: row.require_submitter_email === 1,
    maxFileSizeBytes: row.max_file_size_bytes,
    allowedExtensions: parseAllowedExtensionsJson(row.allowed_extensions),
    submissionCount: row.submission_count,
    expiresAt: row.expires_at,
    isActive: row.is_active === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Authenticated File Request management (`/api/file-requests`) */
export const fileRequestsRoutes = new Hono<OidcHonoEnv>();
fileRequestsRoutes.use('*', sessionAuthMiddleware({ required: true }));

fileRequestsRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const folderId = c.req.query('folderId');

  if (folderId) {
    const access = await resolveTargetAccess(c.env.DB, user, 'folder', folderId);
    if (!access || access.deletedAt !== null) {
      return c.json({ error: 'Folder not found' }, 404);
    }
    if (!hasAtLeastRole(access.effectiveRole, 'viewer') && user.role === 'member') {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const rows = await c.env.DB.prepare(
      `SELECT * FROM file_requests
       WHERE tenant_id = ? AND folder_id = ? AND is_active = 1
       ORDER BY created_at DESC`
    )
      .bind(user.tenantId, folderId)
      .all<FileRequestRow>();
    return c.json({ fileRequests: rows.results.map(formatInternalFileRequest) });
  }

  const rows = await c.env.DB.prepare(
    `SELECT * FROM file_requests
     WHERE tenant_id = ? AND created_by = ? AND is_active = 1
     ORDER BY created_at DESC LIMIT 100`
  )
    .bind(user.tenantId, user.id)
    .all<FileRequestRow>();
  return c.json({ fileRequests: rows.results.map(formatInternalFileRequest) });
});

fileRequestsRoutes.post('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    folderId?: unknown;
    title?: unknown;
    description?: unknown;
    requireSubmitterEmail?: unknown;
    maxFileSizeBytes?: unknown;
    allowedExtensions?: unknown;
    expiresAt?: unknown;
    expiresInDays?: unknown;
  } | null;

  if (!body || typeof body.folderId !== 'string' || !body.folderId.trim()) {
    return c.json({ error: 'folderId and title are required' }, 400);
  }
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 160) {
    return c.json({ error: 'title must be a non-empty string (<= 160 chars)' }, 400);
  }

  const folderId = body.folderId.trim();
  const folderAccess = await resolveTargetAccess(c.env.DB, user, 'folder', folderId);
  if (!folderAccess || folderAccess.deletedAt !== null) {
    return c.json({ error: 'Destination folder not found' }, 404);
  }
  if (!hasAtLeastRole(folderAccess.effectiveRole, 'editor')) {
    return c.json({ error: 'Forbidden: editor role or higher required on target folder' }, 403);
  }

  let maxFileSizeBytes = DEFAULT_MAX_FILE_SIZE_BYTES;
  if (body.maxFileSizeBytes !== undefined && body.maxFileSizeBytes !== null) {
    if (
      typeof body.maxFileSizeBytes !== 'number' ||
      !Number.isInteger(body.maxFileSizeBytes) ||
      body.maxFileSizeBytes < 1 ||
      body.maxFileSizeBytes > DEFAULT_MAX_FILE_SIZE_BYTES
    ) {
      return c.json(
        { error: `maxFileSizeBytes must be between 1 and ${DEFAULT_MAX_FILE_SIZE_BYTES}` },
        400
      );
    }
    maxFileSizeBytes = body.maxFileSizeBytes;
  }

  let allowedExtensionsJson: string | null = null;
  if (body.allowedExtensions !== undefined && body.allowedExtensions !== null) {
    if (!Array.isArray(body.allowedExtensions)) {
      return c.json({ error: 'allowedExtensions must be an array of extensions' }, 400);
    }
    const normalized: string[] = [];
    for (const rawExt of body.allowedExtensions) {
      if (typeof rawExt !== 'string') {
        return c.json({ error: 'Each extension must be a string' }, 400);
      }
      const ext = rawExt.replace(/^\./, '').trim().toLowerCase();
      if (!ext || !/^[a-z0-9]{1,16}$/.test(ext)) {
        return c.json({ error: `Invalid extension format: ${rawExt}` }, 400);
      }
      if (DANGEROUS_EXTENSIONS.has(ext)) {
        return c.json(
          {
            error: `Extension .${ext} is blocked by security policy`,
            code: 'DANGEROUS_EXTENSION_FORBIDDEN',
          },
          400
        );
      }
      if (!normalized.includes(ext)) normalized.push(ext);
    }
    if (normalized.length > 0) {
      allowedExtensionsJson = JSON.stringify(normalized);
    }
  }

  let expiresAt: string | null = null;
  if (typeof body.expiresAt === 'string' && body.expiresAt.trim()) {
    const ms = Date.parse(body.expiresAt.trim());
    if (Number.isNaN(ms) || ms <= Date.now()) {
      return c.json({ error: 'expiresAt must be a valid future ISO timestamp' }, 400);
    }
    expiresAt = new Date(ms).toISOString();
  } else if (typeof body.expiresInDays === 'number' && Number.isFinite(body.expiresInDays)) {
    if (body.expiresInDays <= 0 || body.expiresInDays > 365) {
      return c.json({ error: 'expiresInDays must be between 1 and 365' }, 400);
    }
    expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  }

  const description =
    typeof body.description === 'string' && body.description.trim()
      ? body.description.trim().slice(0, 1000)
      : null;

  const requestId = crypto.randomUUID();
  const rawToken = generateRandomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const nowIso = new Date().toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO file_requests (
         id, tenant_id, folder_id, token_hash, title, description,
         require_submitter_email, max_file_size_bytes, allowed_extensions,
         submission_count, expires_at, is_active, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`
    ).bind(
      requestId,
      user.tenantId,
      folderId,
      tokenHash,
      body.title.trim(),
      description,
      body.requireSubmitterEmail ? 1 : 0,
      maxFileSizeBytes,
      allowedExtensionsJson,
      expiresAt,
      user.id,
      nowIso
    ),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'file_request.create',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: folderAccess.classification,
      metadata: {
        fileRequestId: requestId,
        maxFileSizeBytes,
        allowedExtensions: parseAllowedExtensionsJson(allowedExtensionsJson),
        expiresAt,
      },
      nowIso,
    }),
  ]);

  const created = await c.env.DB.prepare('SELECT * FROM file_requests WHERE id = ?')
    .bind(requestId)
    .first<FileRequestRow>();

  return c.json(
    {
      fileRequest: created ? formatInternalFileRequest(created) : null,
      token: rawToken,
      requestUrl: `/fr/${rawToken}`,
    },
    201
  );
});

fileRequestsRoutes.delete('/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const requestId = c.req.param('id');

  const reqRow = await c.env.DB.prepare(
    'SELECT * FROM file_requests WHERE tenant_id = ? AND id = ?'
  )
    .bind(user.tenantId, requestId)
    .first<FileRequestRow>();

  if (!reqRow || reqRow.is_active === 0) {
    return c.json({ error: 'File request not found' }, 404);
  }

  if (
    reqRow.created_by !== user.id &&
    user.role !== 'sys_admin' &&
    user.role !== 'sec_admin'
  ) {
    const access = await resolveTargetAccess(c.env.DB, user, 'folder', reqRow.folder_id);
    if (!hasAtLeastRole(access?.effectiveRole, 'editor')) {
      return c.json({ error: 'Forbidden' }, 403);
    }
  }

  const nowIso = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE file_requests SET is_active = 0 WHERE tenant_id = ? AND id = ?'
    ).bind(user.tenantId, requestId),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'file_request.deactivate',
      targetType: 'folder',
      targetId: reqRow.folder_id,
      metadata: { fileRequestId: requestId },
      nowIso,
    }),
  ]);

  return c.json({ ok: true });
});

/** Public Blind Dropbox API (`/api/fr/:token/*`) */
export const publicFileRequestsRoutes = new Hono<OidcHonoEnv>();

publicFileRequestsRoutes.use('*', async (c, next) => {
  await next();
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
});

async function loadActiveFileRequest(
  db: D1Database,
  rawToken: string
): Promise<
  | { ok: true; fileRequest: FileRequestRow }
  | { ok: false; status: 404 | 410; error: string; code: string }
> {
  if (!rawToken || rawToken.length < 16) {
    return { ok: false, status: 404, error: 'File request not found', code: 'REQUEST_NOT_FOUND' };
  }
  const tokenHash = await sha256Hex(rawToken);
  const reqRow = await db
    .prepare('SELECT * FROM file_requests WHERE token_hash = ?')
    .bind(tokenHash)
    .first<FileRequestRow>();

  if (!reqRow) {
    return { ok: false, status: 404, error: 'File request not found', code: 'REQUEST_NOT_FOUND' };
  }
  if (reqRow.is_active !== 1) {
    return { ok: false, status: 410, error: 'File request is closed', code: 'REQUEST_CLOSED' };
  }
  if (reqRow.expires_at && Date.parse(reqRow.expires_at) <= Date.now()) {
    return { ok: false, status: 410, error: 'File request has expired', code: 'REQUEST_EXPIRED' };
  }

  const folder = await db
    .prepare('SELECT deleted_at FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(reqRow.tenant_id, reqRow.folder_id)
    .first<{ deleted_at: string | null }>();
  if (!folder || folder.deleted_at !== null) {
    return { ok: false, status: 410, error: 'File request is no longer available', code: 'TARGET_UNAVAILABLE' };
  }

  return { ok: true, fileRequest: reqRow };
}

/** GET /api/fr/:token — strict blind metadata (never exposes folderId or existing files) */
publicFileRequestsRoutes.get('/:token', async (c) => {
  const loaded = await loadActiveFileRequest(c.env.DB, c.req.param('token'));
  if (!loaded.ok) {
    return c.json({ error: loaded.error, code: loaded.code }, loaded.status);
  }
  const fr = loaded.fileRequest;
  const runtimeEnv = c.env as FileRequestRuntimeEnv;

  return c.json({
    title: fr.title,
    description: fr.description,
    requireSubmitterEmail: fr.require_submitter_email === 1,
    maxFileSizeBytes: fr.max_file_size_bytes,
    allowedExtensions: parseAllowedExtensionsJson(fr.allowed_extensions),
    expiresAt: fr.expires_at,
    turnstileEnabled: Boolean(runtimeEnv.TURNSTILE_SECRET_KEY),
  });
});

/** POST /api/fr/:token/upload-init — validate extension, size, rate-limit, quota & issue upload URL */
publicFileRequestsRoutes.post('/:token/upload-init', async (c) => {
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

publicFileRequestsRoutes.post('/:token/upload-complete', (c) => handleFileRequestComplete(c));
publicFileRequestsRoutes.post('/:token/complete', (c) => handleFileRequestComplete(c));
