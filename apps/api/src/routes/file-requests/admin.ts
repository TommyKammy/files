import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  requireMemberUser,
  resolveTargetAccess,
} from '../../services/authorization';
import { can } from '../../services/capabilities';
import { generateRandomToken, sha256Hex } from '../../services/crypto-utils';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  DANGEROUS_EXTENSIONS,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  FileRequestRow,
  formatInternalFileRequest,
  parseAllowedExtensionsJson,
} from './shared';

export const fileRequestsRoutes = new Hono<OidcHonoEnv>();
fileRequestsRoutes.use(
  '*',
  sessionAuthMiddleware({ required: true }),
  requireMemberUser
);

fileRequestsRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const folderId = c.req.query('folderId');

  if (folderId) {
    const access = await resolveTargetAccess(c.env.DB, user, 'folder', folderId);
    if (!access || access.deletedAt !== null) {
      return c.json({ error: 'Folder not found' }, 404);
    }
    if (!can(access.capabilities, 'permission.view') && user.role === 'member') {
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
  if (!can(folderAccess.capabilities, 'folder.create')) {
    return c.json(
      { error: 'Forbidden: folder create permission required on target folder' },
      403
    );
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
    if (!can(access?.capabilities, 'folder.create')) {
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

