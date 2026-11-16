import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import {
  getAuthenticatedUser,
  resolveTargetAccess,
} from '../services/authorization';
import { can, type Capability } from '../services/capabilities';
import type { FileRow } from '../services/file-upload-common';
import { getFileLockState } from '../services/file-lock';
import type { OidcHonoEnv } from '../types/oidc';

export const fileLockRoutes = new Hono<OidcHonoEnv>();

fileLockRoutes.use('*', sessionAuthMiddleware({ required: true }));

async function loadFile(
  c: {
    env: OidcHonoEnv['Bindings'];
    json: (body: unknown, status: 400 | 403 | 404 | 409 | 503) => Response;
  },
  user: { id: string; tenantId: string },
  fileId: string
): Promise<
  | { ok: true; file: FileRow; capabilities: readonly Capability[] }
  | { ok: false; response: Response }
> {
  const [access, file] = await Promise.all([
    resolveTargetAccess(c.env.DB, user, 'file', fileId),
    c.env.DB.prepare(
      'SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
    )
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);
  if (!access || !file || access.deletedAt !== null || file.upload_state !== 'active') {
    return { ok: false, response: c.json({ error: 'File not found' }, 404) };
  }
  if (!can(access.capabilities, 'item.preview')) {
    return { ok: false, response: c.json({ error: 'Forbidden' }, 403) };
  }
  return { ok: true, file, capabilities: access.capabilities };
}

function getDriveLockId(body: unknown, c: { req: { header: (name: string) => string | undefined } }): string {
  const parsed =
    body && typeof body === 'object'
      ? (body as { lockId?: unknown }).lockId
      : undefined;
  if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  return c.req.header('X-Drive-Lock')?.trim() ?? '';
}

/** GET /api/files/:id/lock-status — cross-client lock visibility. */
fileLockRoutes.get('/:id/lock-status', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');
  const loaded = await loadFile(c, user, fileId);
  if (!loaded.ok) return loaded.response;

  const lock = await getFileLockState(c.env, fileId);
  return c.json({
    fileId,
    lock,
    canWrite:
      can(loaded.capabilities, 'item.edit_content') &&
      (!lock || lock.mode !== 'desktop_exclusive'),
    readOnly: Boolean(lock && lock.mode === 'desktop_exclusive'),
    syncPolicy:
      loaded.file.classification === 'confidential'
        ? 'cloud_preview_only'
        : 'full',
  });
});

/** POST /api/files/:id/lock — acquire desktop_exclusive for Files Drive. */
fileLockRoutes.post('/:id/lock', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');
  const loaded = await loadFile(c, user, fileId);
  if (!loaded.ok) return loaded.response;
  if (!can(loaded.capabilities, 'item.edit_content')) {
    return c.json({ error: 'Content edit permission required to lock' }, 403);
  }
  if (!c.env.FILE_LOCK_HUB) {
    return c.json({ error: 'Lock service unavailable' }, 503);
  }

  const body = (await c.req.json().catch(() => null)) as {
    lockId?: unknown;
    ttlSeconds?: unknown;
  } | null;
  const lockId =
    getDriveLockId(body, c) || `drive:${crypto.randomUUID()}`;
  const ttlSeconds =
    typeof body?.ttlSeconds === 'number' ? body.ttlSeconds : 30 * 60;

  const stub = c.env.FILE_LOCK_HUB.get(
    c.env.FILE_LOCK_HUB.idFromName(fileId)
  );
  const result = await stub.lockFile({
    fileId,
    tenantId: user.tenantId,
    mode: 'desktop_exclusive',
    lockId,
    ownerId: user.id,
    ownerName: user.displayName,
    ownerEmail: user.email,
    ttlSeconds,
  });
  if (!result.ok) {
    const wopiActive = result.lock?.mode === 'wopi_collab';
    return c.json(
      {
        error: wopiActive
          ? 'A web WOPI editing session is active'
          : 'File is locked by another client',
        code: wopiActive ? 'WOPI_LOCK_ACTIVE' : 'FILE_LOCKED',
        lock: result.lock,
        readOnlyRecommended: wopiActive,
        ...(wopiActive
          ? {
              wopiSessionPath: `/api/files/${encodeURIComponent(fileId)}/wopi-session`,
              webEditUrl: loaded.file.folder_id
                ? `/workspace?folderId=${encodeURIComponent(loaded.file.folder_id)}&preview=${encodeURIComponent(fileId)}`
                : `/workspace?preview=${encodeURIComponent(fileId)}`,
            }
          : {}),
      },
      409
    );
  }

  return c.json(
    {
      ok: true,
      fileId,
      lock: result.lock,
      lockId: result.lock.lockId,
      expiresAt: result.lock.expiresAt,
      syncPolicy:
        loaded.file.classification === 'confidential'
          ? 'cloud_preview_only'
          : 'full',
    },
    201
  );
});

/** DELETE /api/files/:id/lock — release a Files Drive lock. */
fileLockRoutes.delete('/:id/lock', async (c) => {
  const user = getAuthenticatedUser(c);
  const fileId = c.req.param('id');
  const loaded = await loadFile(c, user, fileId);
  if (!loaded.ok) return loaded.response;

  const body = (await c.req.json().catch(() => null)) as {
    lockId?: unknown;
  } | null;
  const lockId = getDriveLockId(body, c);
  if (!lockId) {
    return c.json({ error: 'lockId is required' }, 400);
  }
  if (!c.env.FILE_LOCK_HUB) {
    return c.json({ error: 'Lock service unavailable' }, 503);
  }

  const stub = c.env.FILE_LOCK_HUB.get(
    c.env.FILE_LOCK_HUB.idFromName(fileId)
  );
  const result = await stub.unlockFile({ fileId, lockId });
  if (!result.ok) {
    return c.json(
      {
        error: 'Lock token does not match',
        code: 'FILE_LOCKED',
        lock: result.lock,
      },
      409
    );
  }
  return c.json({ ok: true, released: result.released });
});
