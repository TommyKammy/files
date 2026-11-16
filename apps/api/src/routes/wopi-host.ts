import { Hono } from 'hono';
import { buildAuditLogStmt } from '../services/audit';
import {
  hasAtLeastRole,
  resolveTargetAccess,
} from '../services/authorization';
import type { FileRow } from '../services/file-upload-common';
import {
  finalizeWopiDraft,
  getActiveWopiDraft,
  saveWopiDraft,
} from '../services/wopi-drafts';
import {
  verifyWopiSessionToken,
  type WopiSessionRow,
  type WopiTokenPayload,
} from '../services/wopi-token';
import { emitTenantSyncSignal } from '../services/sync-notifier';
import { getFileLockState } from '../services/file-lock';
import { tryGetExecutionContext } from '../services/sync-notifier';
import type { OidcHonoEnv } from '../types/oidc';

export const wopiHostRoutes = new Hono<OidcHonoEnv>();

interface WopiUserRow {
  id: string;
  email: string;
  display_name: string;
}

interface WopiRequestContext {
  payload: WopiTokenPayload;
  session: WopiSessionRow;
  file: FileRow;
  user: WopiUserRow;
  canWrite: boolean;
}

function wopiError(
  status: 400 | 401 | 403 | 404 | 409 | 413 | 501 | 503,
  code: string,
  message: string,
  lock?: string
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (lock !== undefined) headers.set('X-WOPI-Lock', lock);
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers,
  });
}

function getAccessToken(c: {
  req: {
    query: (key: string) => string | undefined;
    header: (key: string) => string | undefined;
  };
}): string | null {
  const queryToken = c.req.query('access_token');
  if (queryToken) return queryToken;
  const auth = c.req.header('Authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim() || null;
  }
  return null;
}

function isWopiClientAllowed(
  env: { WOPI_ALLOWED_CLIENT_IPS?: string },
  clientIp: string
): boolean {
  const raw = env.WOPI_ALLOWED_CLIENT_IPS?.trim();
  if (!raw) return true;
  const allowed = new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return allowed.has(clientIp);
}

async function authenticateWopi(
  c: {
    env: OidcHonoEnv['Bindings'];
    req: {
      param: (key: string) => string;
      query: (key: string) => string | undefined;
      header: (key: string) => string | undefined;
    };
  },
  fileId: string
): Promise<WopiRequestContext | Response> {
  if (!isWopiClientAllowed(c.env, c.req.header('CF-Connecting-IP') ?? '')) {
    return wopiError(403, 'WOPI_CLIENT_FORBIDDEN', 'WOPI client IP is not allowed');
  }

  const verified = await verifyWopiSessionToken(
    c.env.DB,
    c.env,
    getAccessToken(c)
  );
  if (!verified) {
    return wopiError(401, 'WOPI_TOKEN_INVALID', 'Invalid or expired access token');
  }
  if (verified.payload.fileId !== fileId) {
    return wopiError(403, 'WOPI_FILE_MISMATCH', 'Access token does not match file');
  }

  const [access, file, user] = await Promise.all([
    resolveTargetAccess(
      c.env.DB,
      {
        id: verified.payload.userId,
        tenantId: verified.payload.tenantId,
      },
      'file',
      fileId
    ),
    c.env.DB.prepare(
      `SELECT * FROM files
        WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
    )
      .bind(verified.payload.tenantId, fileId)
      .first<FileRow>(),
    c.env.DB.prepare(
      `SELECT id, email, display_name FROM users
        WHERE tenant_id = ? AND id = ? AND status = 'active'`
    )
      .bind(verified.payload.tenantId, verified.payload.userId)
      .first<WopiUserRow>(),
  ]);

  if (
    !access ||
    access.deletedAt !== null ||
    !file ||
    file.upload_state !== 'active'
  ) {
    return wopiError(404, 'WOPI_FILE_NOT_FOUND', 'File not found');
  }
  if (!user) {
    return wopiError(401, 'WOPI_USER_INACTIVE', 'User is not active');
  }
  if (!hasAtLeastRole(access.effectiveRole, 'previewer')) {
    return wopiError(403, 'WOPI_FORBIDDEN', 'File access denied');
  }

  return {
    payload: verified.payload,
    session: {
      ...verified.session,
      role: access.effectiveRole!,
      can_write:
        verified.session.can_write === 1 &&
        hasAtLeastRole(access.effectiveRole, 'editor')
          ? 1
          : 0,
    },
    file,
    user,
    canWrite:
      verified.session.can_write === 1 &&
      hasAtLeastRole(access.effectiveRole, 'editor'),
  };
}

async function auditWopi(
  c: { env: OidcHonoEnv['Bindings'] },
  context: WopiRequestContext,
  action: 'wopi.read' | 'wopi.write',
  metadata: Record<string, unknown>,
  nowIso: string
): Promise<void> {
  await c.env.DB.batch([
    buildAuditLogStmt(c.env.DB, {
      tenantId: context.payload.tenantId,
      actorId: context.payload.userId,
      actorEmail: context.user.email,
      actorIp: 'wopi-client',
      action,
      targetType: 'file',
      targetId: context.file.id,
      classificationSnapshot: context.file.classification,
      metadata: {
        sessionId: context.session.id,
        ...metadata,
      },
      nowIso,
    }),
  ]);
}

/** GET /wopi/files/:fileId — CheckFileInfo */
wopiHostRoutes.get('/files/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  const context = await authenticateWopi(c, fileId);
  if (context instanceof Response) return context;

  const draft = await getActiveWopiDraft(
    c.env.DB,
    context.payload.tenantId,
    fileId
  );
  const lock = await getFileLockState(c.env, fileId);
  const desktopLocked = lock?.mode === 'desktop_exclusive';
  const canWrite = context.canWrite && !desktopLocked;
  const dlp =
    context.file.classification === 'confidential' ||
    context.session.role === 'previewer';

  return c.json({
    BaseFileName: context.file.name,
    Size: draft?.size_bytes ?? context.file.size_bytes,
    Version: draft?.id ?? String(context.file.meta_version),
    OwnerId: context.file.created_by,
    UserId: context.user.id,
    UserFriendlyName: context.user.display_name,
    UserCanWrite: canWrite,
    ReadOnly: !canWrite,
    SupportsUpdate: true,
    SupportsLocks: true,
    UserCanNotWriteRelative: true,
    DisablePrint: dlp,
    DisableExport: dlp,
    DisableCopy: dlp,
    HidePrintOption: dlp,
    HideSaveOption: dlp,
    HideExportOption: dlp,
    ...(dlp
      ? {
          WatermarkText: `${context.user.email} • ${new Date().toISOString()}`,
        }
      : {}),
    LastModifiedTime: draft?.updated_at ?? context.file.updated_at,
    FileExtension: context.file.extension ?? '',
    FileMimeType: draft?.mime_type ?? context.file.mime_type,
  });
});

/** GET /wopi/files/:fileId/contents — GetFile */
wopiHostRoutes.get('/files/:fileId/contents', async (c) => {
  const fileId = c.req.param('fileId');
  const context = await authenticateWopi(c, fileId);
  if (context instanceof Response) return context;

  const draft = await getActiveWopiDraft(
    c.env.DB,
    context.payload.tenantId,
    fileId
  );
  let objectKey = draft?.r2_object_key ?? null;
  let sizeBytes = draft?.size_bytes ?? context.file.size_bytes;
  let mimeType = draft?.mime_type ?? context.file.mime_type;
  let version = draft?.id ?? String(context.file.meta_version);

  if (!objectKey) {
    const currentVersion = await c.env.DB.prepare(
      `SELECT id, r2_object_key, size_bytes, mime_type
         FROM file_versions
        WHERE tenant_id = ? AND id = ?`
    )
      .bind(context.payload.tenantId, context.file.current_version_id)
      .first<{
        id: string;
        r2_object_key: string;
        size_bytes: number;
        mime_type: string;
      }>();
    if (!currentVersion) {
      return wopiError(404, 'WOPI_CONTENT_NOT_FOUND', 'File content not found');
    }
    objectKey = currentVersion.r2_object_key;
    sizeBytes = currentVersion.size_bytes;
    mimeType = currentVersion.mime_type;
    version = currentVersion.id;
  }

  const object = await c.env.BUCKET.get(objectKey);
  if (!object) {
    return wopiError(404, 'WOPI_CONTENT_NOT_FOUND', 'File content not found');
  }

  const nowIso = new Date().toISOString();
  await auditWopi(c, context, 'wopi.read', { sizeBytes, version }, nowIso);

  const headers = new Headers();
  headers.set('Content-Type', mimeType);
  headers.set('Content-Length', String(sizeBytes));
  headers.set('X-WOPI-ItemVersion', version);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { status: 200, headers });
});

/** POST /wopi/files/:fileId — LOCK / GET_LOCK / REFRESH_LOCK / UNLOCK / UNLOCK_AND_RELOCK */
wopiHostRoutes.post('/files/:fileId', async (c) => {
  const fileId = c.req.param('fileId');
  const context = await authenticateWopi(c, fileId);
  if (context instanceof Response) return context;

  if (!c.env.FILE_LOCK_HUB) {
    return wopiError(503, 'WOPI_LOCK_UNAVAILABLE', 'Lock service unavailable');
  }
  const stub = c.env.FILE_LOCK_HUB.get(
    c.env.FILE_LOCK_HUB.idFromName(fileId)
  );
  const override = (c.req.header('X-WOPI-Override') ?? '').toUpperCase();
  const lockId = c.req.header('X-WOPI-Lock') ?? '';
  const oldLockId = c.req.header('X-WOPI-OldLock') ?? '';
  const ttlSeconds = 30 * 60;

  if (override === 'GET_LOCK') {
    const result = await stub.getLock({ fileId });
    return new Response(null, {
      status: 200,
      headers: { 'X-WOPI-Lock': result.lock?.lockId ?? '' },
    });
  }

  if (!context.canWrite && override !== 'UNLOCK') {
    return wopiError(403, 'WOPI_READ_ONLY', 'Session is read-only', lockId);
  }

  if (override === 'LOCK' || override === 'REFRESH_LOCK') {
    if (!lockId) {
      return wopiError(400, 'WOPI_LOCK_REQUIRED', 'X-WOPI-Lock is required');
    }
    const result =
      override === 'LOCK'
        ? await stub.lockFile({
            fileId,
            tenantId: context.payload.tenantId,
            mode: 'wopi_collab',
            lockId,
            ownerId: context.user.id,
            ownerName: context.user.display_name,
            ownerEmail: context.user.email,
            sessionId: context.session.id,
            ttlSeconds,
          })
        : await stub.refreshLock({ fileId, lockId, ttlSeconds });
    if (!result.ok) {
      return wopiError(
        409,
        'WOPI_LOCK_CONFLICT',
        'File is locked by another session',
        result.lock?.lockId ?? ''
      );
    }
    return new Response(null, {
      status: 200,
      headers: { 'X-WOPI-Lock': result.lock.lockId },
    });
  }

  if (override === 'UNLOCK') {
    const result = await stub.unlockFile({ fileId, lockId });
    if (!result.ok) {
      return wopiError(
        409,
        'WOPI_LOCK_CONFLICT',
        'Lock token does not match',
        result.lock?.lockId ?? ''
      );
    }
    if (result.released) {
      const finalized = await finalizeWopiDraft({
        env: c.env,
        session: context.session,
        actor: {
          id: context.user.id,
          email: context.user.email,
          ipAddress: 'wopi-client',
        },
      });
      if (finalized) {
        await emitTenantSyncSignal(c, {
          tenantId: context.payload.tenantId,
          seq: finalized.syncSeq,
          eventKind: 'file.version_finalized',
          scopeFolderIds: [finalized.file.folder_id],
        });
      }
    }
    return new Response(null, {
      status: 200,
      headers: { 'X-WOPI-Lock': '' },
    });
  }

  if (override === 'UNLOCK_AND_RELOCK') {
    if (!lockId || !oldLockId) {
      return wopiError(
        400,
        'WOPI_LOCK_REQUIRED',
        'X-WOPI-Lock and X-WOPI-OldLock are required'
      );
    }
    const result = await stub.unlockAndRelock({
      fileId,
      lockId: oldLockId,
      newLockId: lockId,
      ttlSeconds,
    });
    if (!result.ok) {
      return wopiError(
        409,
        'WOPI_LOCK_CONFLICT',
        'Lock token does not match',
        result.lock?.lockId ?? ''
      );
    }
    return new Response(null, {
      status: 200,
      headers: { 'X-WOPI-Lock': result.lock.lockId },
    });
  }

  return wopiError(501, 'WOPI_OVERRIDE_UNSUPPORTED', 'Unsupported WOPI override');
});

/** POST /wopi/files/:fileId/contents — PutFile */
wopiHostRoutes.post('/files/:fileId/contents', async (c) => {
  const fileId = c.req.param('fileId');
  const context = await authenticateWopi(c, fileId);
  if (context instanceof Response) return context;

  if (!context.canWrite) {
    return wopiError(403, 'WOPI_READ_ONLY', 'Session is read-only');
  }
  const activeLock = await getFileLockState(c.env, fileId);
  if (activeLock?.mode === 'desktop_exclusive') {
    return wopiError(
      403,
      'WOPI_DESKTOP_LOCK_ACTIVE',
      'A Files Drive desktop lock is active'
    );
  }
  if (!c.env.FILE_LOCK_HUB) {
    return wopiError(503, 'WOPI_LOCK_UNAVAILABLE', 'Lock service unavailable');
  }
  const stub = c.env.FILE_LOCK_HUB.get(
    c.env.FILE_LOCK_HUB.idFromName(fileId)
  );
  const lockId = c.req.header('X-WOPI-Lock') ?? '';
  const current = await stub.getLock({ fileId });
  if (!lockId || !current.lock || current.lock.lockId !== lockId) {
    return wopiError(
      409,
      'WOPI_LOCK_CONFLICT',
      'A matching WOPI lock is required',
      current.lock?.lockId ?? ''
    );
  }

  const content = await c.req.arrayBuffer();
  const maxExpected = Number.parseInt(
    c.req.header('X-WOPI-MaxExpectedSize') ?? '',
    10
  );
  if (Number.isFinite(maxExpected) && content.byteLength > maxExpected) {
    return wopiError(
      413,
      'WOPI_MAX_EXPECTED_SIZE_EXCEEDED',
      'Payload exceeds X-WOPI-MaxExpectedSize'
    );
  }

  const nowIso = new Date().toISOString();
  const saved = await saveWopiDraft({
    env: c.env,
    session: context.session,
    content,
    mimeType: context.file.mime_type,
  });

  if (saved.previousObjectKey) {
    const previousKey = saved.previousObjectKey;
    const executionCtx = tryGetExecutionContext(c);
    const deletion = c.env.BUCKET.delete(previousKey).catch(() => undefined);
    if (executionCtx) executionCtx.waitUntil(deletion);
    else await deletion;
  }

  await auditWopi(
    c,
    context,
    'wopi.write',
    {
      draftId: saved.draft.id,
      sizeBytes: saved.draft.size_bytes,
    },
    nowIso
  );

  return new Response(null, {
    status: 200,
    headers: { 'X-WOPI-ItemVersion': saved.draft.id },
  });
});
