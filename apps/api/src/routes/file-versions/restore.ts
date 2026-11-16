import { Hono } from 'hono';
import { assertFileNotLocked, FileLockedError } from '../../services/file-lock';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
} from '../../services/authorization';
import {
  type FileRow,
  type FileVersionRow,
} from '../../services/file-upload-common';
import { buildFileVersionRestoreStatements } from '../../services/file-version-restore';
import { parseExpectedVersionInput } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { OidcHonoEnv } from '../../types/oidc';
import {
  type FileVersionListRow,
  loadActiveFile,
  toPublicVersion,
} from './shared';

function handleRestoreError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response },
  err: unknown
): Response {
  if (err instanceof FileLockedError) {
    return c.json(
      { error: 'File is locked', code: err.code, lock: err.lock },
      409
    );
  }
  throw err;
}

export function registerFileVersionRestoreRoute(routes: Hono<OidcHonoEnv>) {
  /**
   * POST /api/files/:id/versions/:versionId/restore
   * Promote a completed historical version by appending a new CoW version row
   * that shares the original immutable R2 object.
   */
  routes.post('/:id/versions/:versionId/restore', async (c) => {
    const user = getAuthenticatedUser(c);
    const fileId = c.req.param('id');
    const versionId = c.req.param('versionId');
    const body = (await c.req.json().catch(() => null)) as {
      expectedVersion?: unknown;
    } | null;
    const expectedVersion = parseExpectedVersionInput(
      c.req.query('expectedVersion'),
      body
    );

    const loaded = await loadActiveFile(c.env.DB, user, fileId);
    if (!loaded) {
      return c.json({ error: 'File not found' }, 404);
    }
    if (!hasAtLeastRole(loaded.access.effectiveRole, 'editor')) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    try {
      await assertFileNotLocked(c.env, fileId);
    } catch (err) {
      return handleRestoreError(c, err);
    }

    if (expectedVersion !== undefined && loaded.file.meta_version !== expectedVersion) {
      return c.json(
        {
          error: 'Version conflict',
          code: 'VERSION_CONFLICT',
          latest: loaded.file,
        },
        409
      );
    }

    const sourceVersion = await c.env.DB.prepare(
      'SELECT * FROM file_versions WHERE tenant_id = ? AND file_id = ? AND id = ?'
    )
      .bind(user.tenantId, fileId, versionId)
      .first<FileVersionRow>();

    if (!sourceVersion) {
      return c.json({ error: 'File version not found' }, 404);
    }
    if (sourceVersion.id === loaded.file.current_version_id) {
      return c.json(
        { error: 'Version is already current', code: 'VERSION_ALREADY_CURRENT' },
        409
      );
    }
    if (sourceVersion.upload_status !== 'completed') {
      return c.json(
        { error: 'Version upload is not completed', code: 'VERSION_NOT_COMPLETED' },
        409
      );
    }

    const object = await c.env.BUCKET.head(sourceVersion.r2_object_key);
    if (!object) {
      return c.json(
        {
          error: 'Version content is missing from storage',
          code: 'VERSION_CONTENT_NOT_FOUND',
        },
        409
      );
    }

    const maxVersionRow = await c.env.DB.prepare(
      'SELECT MAX(version_num) AS max_num FROM file_versions WHERE tenant_id = ? AND file_id = ?'
    )
      .bind(user.tenantId, fileId)
      .first<{ max_num: number | null }>();
    const newVersionNum =
      Math.max(loaded.file.current_version_num, maxVersionRow?.max_num ?? 0) + 1;
    const newVersionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const batchResults = await c.env.DB.batch(
      buildFileVersionRestoreStatements({
        db: c.env.DB,
        user,
        file: loaded.file,
        sourceVersion,
        newVersionId,
        newVersionNum,
        nowIso,
      })
    );

    const [fileUpdateResult, versionInsertResult] = batchResults;
    if (
      (fileUpdateResult?.meta.changes ?? 0) === 0 ||
      (versionInsertResult?.meta.changes ?? 0) === 0
    ) {
      const latest = await c.env.DB.prepare(
        'SELECT * FROM files WHERE tenant_id = ? AND id = ?'
      )
        .bind(user.tenantId, fileId)
        .first<FileRow>();
      return c.json(
        { error: 'Version conflict', code: 'VERSION_CONFLICT', latest },
        409
      );
    }

    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'file.version_restored',
      scopeFolderIds: [loaded.file.folder_id],
    });

    const [updatedFile, versionRow] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
        .bind(user.tenantId, fileId)
        .first<FileRow>(),
      c.env.DB.prepare(
        `SELECT fv.id, fv.version_num, fv.size_bytes, fv.mime_type, fv.uploaded_by,
                u.display_name AS uploaded_by_name, fv.created_at, fv.upload_status,
                CASE WHEN fv.id = fl.current_version_id THEN 1 ELSE 0 END AS is_current
           FROM file_versions fv
           JOIN files fl ON fl.tenant_id = fv.tenant_id AND fl.id = fv.file_id
           LEFT JOIN users u ON u.tenant_id = fv.tenant_id AND u.id = fv.uploaded_by
          WHERE fv.tenant_id = ? AND fv.id = ?`
      )
        .bind(user.tenantId, newVersionId)
        .first<FileVersionListRow>(),
    ]);

    return c.json({
      ok: true,
      file: updatedFile,
      version: versionRow
        ? {
            ...toPublicVersion(versionRow),
            comment: `Restored from v${sourceVersion.version_num}`,
            restoredFromVersionId: sourceVersion.id,
            restoredFromVersionNum: sourceVersion.version_num,
          }
        : null,
      restoredFromVersionId: sourceVersion.id,
      restoredFromVersionNum: sourceVersion.version_num,
    });
  });
}
