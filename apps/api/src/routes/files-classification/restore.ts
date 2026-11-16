import { Hono } from 'hono';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import {
  type FileRow,
  FileUploadError,
  validateFileNameAndExt,
} from '../../services/file-upload-common';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  findActiveFileNameConflict,
} from './shared';

export function registerFileRestoreRoute(routes: Hono<OidcHonoEnv>) {
  /** POST /api/files/:id/restore — restore soft-deleted single file & reindex FTS5 */
  routes.post('/:id/restore', async (c) => {
    const user = getAuthenticatedUser(c);
    const fileId = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as { newName?: unknown } | null;

    const [access, file] = await Promise.all([
      resolveTargetAccess(c.env.DB, user, 'file', fileId),
      c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
        .bind(user.tenantId, fileId)
        .first<FileRow>(),
    ]);

    if (!access || !file) {
      return c.json({ error: 'File not found' }, 404);
    }
    if (file.deleted_at === null) {
      return c.json({ error: 'File is not in trash' }, 409);
    }

    const isPrivilegedAdmin = user.role === 'sec_admin' || user.role === 'sys_admin';
    if (!isPrivilegedAdmin && !hasAtLeastRole(access.effectiveRole, 'editor')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    if (file.folder_id) {
      const parent = await c.env.DB.prepare(
        'SELECT deleted_at FROM folders WHERE tenant_id = ? AND id = ?'
      )
        .bind(user.tenantId, file.folder_id)
        .first<{ deleted_at: string | null }>();
      if (!parent || parent.deleted_at !== null) {
        return c.json(
          { error: 'Parent folder is deleted; restore parent folder first', code: 'PARENT_FOLDER_DELETED' },
          409
        );
      }
    }

    let restoredName = file.name;
    let restoredExt = file.extension;
    if (body?.newName !== undefined) {
      try {
        const parsed = validateFileNameAndExt(body.newName);
        restoredName = parsed.name;
        restoredExt = parsed.extension;
      } catch (err) {
        if (err instanceof FileUploadError) {
          return c.json({ error: err.message, code: err.code }, err.status);
        }
        throw err;
      }
    }

    const conflict = await findActiveFileNameConflict(
      c.env.DB,
      user.tenantId,
      file.folder_id,
      restoredName
    );

    if (conflict) {
      return c.json(
        { error: `An active file named "${restoredName}" already exists in destination folder`, code: 'NAME_CONFLICT' },
        409
      );
    }

    const nowIso = new Date().toISOString();
    const batchResults = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE files
         SET deleted_at = NULL, deleted_by = NULL, name = ?, extension = ?, meta_version = meta_version + 1, updated_by = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ? AND deleted_at IS NOT NULL`
      ).bind(restoredName, restoredExt, user.id, nowIso, user.tenantId, file.id),
      c.env.DB.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(file.id),
      c.env.DB.prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(file.id, user.tenantId, file.classification, restoredName, restoredExt ?? '', file.ai_reason ?? ''),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'file.restore',
        targetType: 'file',
        targetId: file.id,
        classificationSnapshot: file.classification,
        metadata: { restoredName },
        nowIso,
      }),
      buildSyncChangeStmt(c.env.DB, {
        tenantId: user.tenantId,
        entityType: 'file',
        entityId: file.id,
        folderId: file.folder_id,
        action: 'file.restore',
        payload: {
          name: restoredName,
          extension: restoredExt,
          folderId: file.folder_id,
          deletedBy: null,
          metaVersion: file.meta_version + 1,
          updatedAt: nowIso,
        },
        nowIso,
      }),
    ]);

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'file.restore',
      scopeFolderIds: [file.folder_id],
    });

    const restored = await c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, file.id)
      .first<FileRow>();

    return c.json({ ok: true, file: restored });
  });

}
