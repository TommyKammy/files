import type { AuthUser } from '../types/api';
import { buildAuditLogStmt } from './audit';
import { hasAtLeastRole, resolveTargetAccess } from './authorization';
import {
  type FileRow,
  FileUploadError,
  validateFileNameAndExt,
} from './file-upload-common';
import {
  findActiveFileNameConflict,
  resolveUniqueRestoredFileName,
} from './filename-conflict';
import {
  type FolderRow,
  FolderServiceError,
  restoreFolderSubtree,
} from './folder-closure-service';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';
import {
  TrashRequestError,
  type TrashItemRefInput,
} from './trash-items';

export type TrashConflictPolicy = 'fail' | 'rename';

export interface RestoreTrashFileResult {
  file: FileRow;
  syncSeq: number | null;
  scopeFolderId: string | null;
}

export interface RestoreTrashFolderResult {
  folder: FolderRow;
  syncSeq: number | null;
  scopeFolderId: string | null;
}

export interface TrashBulkItemResult {
  type: 'file' | 'folder';
  id: string;
  ok: boolean;
  status: 'succeeded' | 'failed';
  name?: string;
  code?: string;
  error?: string;
  file?: FileRow;
  folder?: FolderRow;
}

export interface TrashRestoreBulkResult {
  results: TrashBulkItemResult[];
  succeededCount: number;
  failedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

function wrapFileUploadError(err: FileUploadError): never {
  throw new TrashRequestError(err.status, err.code, err.message);
}

/**
 * Restore one soft-deleted file with the exact authorization, parent-folder,
 * conflict, audit and sync rules used by `POST /api/files/:id/restore`.
 *
 * `newName` remains the single-file API's explicit override; bulk restore uses
 * `conflictPolicy: 'rename'` instead so both callers share this core.
 */
export async function restoreTrashFile(
  db: D1Database,
  user: AuthUser,
  fileId: string,
  options: {
    newName?: unknown;
    conflictPolicy?: TrashConflictPolicy;
  } = {}
): Promise<RestoreTrashFileResult> {
  const [access, file] = await Promise.all([
    resolveTargetAccess(db, user, 'file', fileId),
    db
      .prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);

  if (!access || !file) {
    throw new TrashRequestError(404, 'NOT_FOUND', 'File not found');
  }
  if (file.deleted_at === null) {
    throw new TrashRequestError(409, 'NOT_IN_TRASH', 'File is not in trash');
  }

  const isPrivilegedAdmin =
    user.role === 'sec_admin' || user.role === 'sys_admin';
  if (!isPrivilegedAdmin && !hasAtLeastRole(access.effectiveRole, 'editor')) {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }

  if (file.folder_id) {
    const parent = await db
      .prepare(
        'SELECT deleted_at FROM folders WHERE tenant_id = ? AND id = ?'
      )
      .bind(user.tenantId, file.folder_id)
      .first<{ deleted_at: string | null }>();
    if (!parent || parent.deleted_at !== null) {
      throw new TrashRequestError(
        409,
        'PARENT_FOLDER_DELETED',
        'Parent folder is deleted; restore parent folder first'
      );
    }
  }

  let restoredName = file.name;
  let restoredExt = file.extension;
  if (options.newName !== undefined) {
    try {
      const parsed = validateFileNameAndExt(options.newName);
      restoredName = parsed.name;
      restoredExt = parsed.extension;
    } catch (err) {
      if (err instanceof FileUploadError) wrapFileUploadError(err);
      throw err;
    }
  }

  const conflict = await findActiveFileNameConflict(
    db,
    user.tenantId,
    file.folder_id,
    restoredName
  );
  if (conflict) {
    if (options.conflictPolicy !== 'rename') {
      throw new TrashRequestError(
        409,
        'NAME_CONFLICT',
        `An active file named "${restoredName}" already exists in destination folder`
      );
    }
    restoredName = await resolveUniqueRestoredFileName(
      db,
      user.tenantId,
      file.folder_id,
      restoredName
    );
    restoredExt = validateFileNameAndExt(restoredName).extension;
  }

  const nowIso = new Date().toISOString();
  const batchResults = await db.batch([
    db
      .prepare(
        `UPDATE files
            SET deleted_at = NULL, deleted_by = NULL, name = ?, extension = ?,
                meta_version = meta_version + 1, updated_by = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND deleted_at IS NOT NULL`
      )
      .bind(
        restoredName,
        restoredExt,
        user.id,
        nowIso,
        user.tenantId,
        file.id
      ),
    db.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(file.id),
    db
      .prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        file.id,
        user.tenantId,
        file.classification,
        restoredName,
        restoredExt ?? '',
        file.ai_reason ?? ''
      ),
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'file.restore',
      targetType: 'file',
      targetId: file.id,
      classificationSnapshot: file.classification,
      metadata: {
        restoredName,
        originalName: restoredName === file.name ? undefined : file.name,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
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

  const restored = await db
    .prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, file.id)
    .first<FileRow>();

  return {
    file: restored!,
    syncSeq: extractLastSyncSeq(batchResults),
    scopeFolderId: file.folder_id,
  };
}

/**
 * Restore one soft-deleted folder subtree through the existing closure-table
 * service. Exposed here so single and bulk routes converge on one contract.
 */
export async function restoreTrashFolder(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  conflictPolicy: TrashConflictPolicy = 'fail'
): Promise<RestoreTrashFolderResult> {
  const restored = await restoreFolderSubtree(
    db,
    user,
    folderId,
    conflictPolicy
  );
  return {
    folder: restored.folder,
    syncSeq: null,
    scopeFolderId: restored.folder.parent_id,
  };
}

function toFailedResult(
  item: TrashItemRefInput,
  err: unknown
): TrashBulkItemResult {
  if (
    err instanceof TrashRequestError ||
    err instanceof FolderServiceError ||
    err instanceof FileUploadError
  ) {
    return {
      type: item.type,
      id: item.id,
      ok: false,
      status: 'failed',
      code: err.code,
      error: err.message,
    };
  }
  console.error('[trash-restore] unexpected item failure:', err);
  return {
    type: item.type,
    id: item.id,
    ok: false,
    status: 'failed',
    code: 'INTERNAL_ERROR',
    error: 'Failed to restore item',
  };
}

/**
 * Restore up to 100 Trash items independently. One failure never rolls back
 * another item; every successful item records its own audit + sync change and
 * the whole batch is announced to the TenantSyncHub by the route.
 */
export async function restoreTrashItems(
  db: D1Database,
  user: AuthUser,
  items: readonly TrashItemRefInput[],
  conflictPolicy: TrashConflictPolicy = 'fail'
): Promise<TrashRestoreBulkResult> {
  const results: TrashBulkItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;

  for (const item of items) {
    try {
      if (item.type === 'file') {
        const result = await restoreTrashFile(db, user, item.id, {
          conflictPolicy,
        });
        scopeFolderIds.add(result.scopeFolderId);
        if (result.syncSeq !== null) {
          lastSeq = Math.max(lastSeq ?? 0, result.syncSeq);
        }
        results.push({
          type: 'file',
          id: item.id,
          ok: true,
          status: 'succeeded',
          name: result.file.name,
          file: result.file,
        });
      } else {
        const result = await restoreTrashFolder(
          db,
          user,
          item.id,
          conflictPolicy
        );
        scopeFolderIds.add(result.scopeFolderId);
        if (result.syncSeq !== null) {
          lastSeq = Math.max(lastSeq ?? 0, result.syncSeq);
        }
        results.push({
          type: 'folder',
          id: item.id,
          ok: true,
          status: 'succeeded',
          name: result.folder.name,
          folder: result.folder,
        });
      }
    } catch (err) {
      results.push(toFailedResult(item, err));
    }
  }

  const succeededCount = results.filter((result) => result.ok).length;
  return {
    results,
    succeededCount,
    failedCount: results.length - succeededCount,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}
