import type { AuthUser, ClassificationLabel } from '../types/api';
import type { OidcEnv } from '../types/oidc';
import {
  buildInClauseDeleteStmts,
  deleteR2ObjectsAndAbortMultipart,
  fetchVersionObjectsForFiles,
  type FileVersionObjectRow,
} from './r2-gc';
import { chunkArray, executeBatchChunks } from '../utils/batch';
import { buildAuditLogStmt } from './audit';
import { GRANTEE_MATCH_SQL, resolveTargetAccess } from './authorization';
import {
  can,
  parseRoleList,
  synthesizeEffectiveAccess,
} from './capabilities';
import { FileLockedError, assertFileNotLocked } from './file-lock';
import { PurgeProtectionError, checkPurgeProtection } from './legal-hold';
import type { FileRow } from './file-upload-common';
import type { FolderRow } from './folder-closure-service';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';
import { buildRootFolderDeltaByFolderStmts } from './root-folder-stats';
import { buildUserStorageDeltaStmt } from './user-storage-stats';
import {
  TrashRequestError,
  type TrashItemRefInput,
} from './trash-items';

const PURGE_STATEMENT_CHUNK = 30;

export interface PurgeFileRow {
  id: string;
  folder_id?: string | null;
  deleted_at?: string | null;
  classification: ClassificationLabel;
  size_bytes: number;
  upload_state: 'pending' | 'active' | 'failed';
  created_by: string;
}

interface PurgeDraftObjectRow extends FileVersionObjectRow {
  r2_upload_id: null;
}

export interface PurgeActor {
  user: AuthUser;
  nowIso: string;
  /** Extra, non-secret audit fields (admin delegation, target name, version). */
  metadata?: Record<string, unknown>;
}

/**
 * Tenant administrator permanently deleting another user's Trash item. The
 * caller must have already verified `sys_admin`; this context only widens the
 * item ACL lookup and records delegation metadata.
 */
export interface TrashPurgeAdminContext {
  adminBypass: true;
  owner: { id: string; name: string; email: string | null };
}

export interface TrashPurgeItemResult {
  type: 'file' | 'folder';
  id: string;
  ok: boolean;
  status: 'succeeded' | 'failed' | 'skipped';
  name?: string;
  code?: string;
  error?: string;
  purgedFileCount?: number;
  purgedFolderCount?: number;
}

export interface TrashPurgeBulkResult {
  results: TrashPurgeItemResult[];
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

export interface TrashEmptyResult {
  results: TrashPurgeItemResult[];
  deletedCount: number;
  failedCount: number;
  skippedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

interface PurgeableTopLevelItem {
  type: 'file' | 'folder';
  id: string;
  name: string;
  role_list: string | null;
}

async function fetchDraftObjectsForFiles(
  db: D1Database,
  fileIds: readonly string[]
): Promise<PurgeDraftObjectRow[]> {
  const rows: PurgeDraftObjectRow[] = [];
  for (const chunk of chunkArray(fileIds, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT id, file_id, r2_object_key, NULL AS r2_upload_id
           FROM wopi_drafts
          WHERE file_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<PurgeDraftObjectRow>();
    rows.push(...res.results);
  }
  return rows;
}

async function buildOptionalAiJobDeleteStmts(
  db: D1Database,
  fileIds: readonly string[]
): Promise<D1PreparedStatement[]> {
  if (fileIds.length === 0) return [];
  // `ai_classification_jobs` is provisioned by the AI queue migration in some
  // deployments. Detect the table and its link column so older schemas keep
  // working while present installations are cleaned up.
  const columns = await db
    .prepare('PRAGMA table_info(ai_classification_jobs)')
    .all<{ name: string }>();
  if (columns.results.length === 0) return [];

  const names = new Set(columns.results.map((column) => column.name));
  const column = names.has('file_id')
    ? 'file_id'
    : names.has('target_id')
      ? 'target_id'
      : names.has('entity_id')
        ? 'entity_id'
        : null;
  if (!column) return [];
  return buildInClauseDeleteStmts(
    db,
    'ai_classification_jobs',
    column,
    fileIds
  );
}

function buildStatsDecrementStmts(
  db: D1Database,
  tenantId: string,
  files: readonly PurgeFileRow[],
  nowIso: string
): D1PreparedStatement[] {
  const statsDelta = new Map<
    ClassificationLabel,
    { count: number; bytes: number }
  >();
  for (const file of files) {
    if (file.upload_state !== 'active') continue;
    const prev = statsDelta.get(file.classification) ?? {
      count: 0,
      bytes: 0,
    };
    statsDelta.set(file.classification, {
      count: prev.count + 1,
      bytes: prev.bytes + file.size_bytes,
    });
  }

  const stmts: D1PreparedStatement[] = [];
  for (const [classification, delta] of statsDelta.entries()) {
    stmts.push(
      db
        .prepare(
          `UPDATE tenant_storage_stats
              SET file_count = MAX(0, file_count - ?),
                  total_bytes = MAX(0, total_bytes - ?),
                  updated_at = ?
            WHERE tenant_id = ? AND classification = ?`
        )
        .bind(delta.count, delta.bytes, nowIso, tenantId, classification)
    );
  }

  const userDelta = new Map<string, { count: number; bytes: number }>();
  for (const file of files) {
    if (file.upload_state !== 'active') continue;
    const prev = userDelta.get(file.created_by) ?? { count: 0, bytes: 0 };
    userDelta.set(file.created_by, {
      count: prev.count + 1,
      bytes: prev.bytes + file.size_bytes,
    });
  }
  for (const [userId, delta] of userDelta.entries()) {
    stmts.push(
      buildUserStorageDeltaStmt(db, {
        tenantId,
        userId,
        countDelta: -delta.count,
        bytesDelta: -delta.bytes,
        nowIso,
      })
    );
  }

  // Soft-deleted files already left root_folder_stats on soft-delete; only
  // adjust if a live non-deleted active file inside a purged folder is removed.
  const folderDelta = new Map<string, { count: number; bytes: number }>();
  for (const file of files) {
    if (
      file.upload_state !== 'active' ||
      file.deleted_at !== null ||
      !file.folder_id
    ) {
      continue;
    }
    const prev = folderDelta.get(file.folder_id) ?? { count: 0, bytes: 0 };
    folderDelta.set(file.folder_id, {
      count: prev.count + 1,
      bytes: prev.bytes + file.size_bytes,
    });
  }
  for (const [folderId, delta] of folderDelta.entries()) {
    stmts.push(
      ...buildRootFolderDeltaByFolderStmts(db, {
        tenantId,
        folderId,
        countDelta: -delta.count,
        bytesDelta: -delta.bytes,
        nowIso,
      })
    );
  }
  return stmts;
}

/**
 * Single D1 + R2 primitive for physical file purge. Shared by Cron retention,
 * manual `DELETE /api/trash/items` and `POST /api/trash/empty`.
 *
 * Ordering guarantees:
 * 1. CoW candidates from both `file_versions` and `wopi_drafts` are filtered by
 *    `selectUnreferencedR2Keys` before any R2 deletion.
 * 2. Child D1 rows are deleted before `files`; storage stats are decremented in
 *    the same batched sequence.
 * 3. Audit/sync rows are only emitted when an actor is supplied (manual purge),
 *    keeping the Cron path free of synthetic user activity.
 */
export async function purgeFileRows(input: {
  db: D1Database;
  bucket: R2Bucket;
  tenantId: string;
  files: readonly PurgeFileRow[];
  nowIso: string;
  actor?: PurgeActor;
}): Promise<{ filesPurged: number; syncSeq: number | null }> {
  const { db, bucket, tenantId, files, nowIso, actor } = input;
  if (files.length === 0) {
    return { filesPurged: 0, syncSeq: null };
  }

  const fileIds = files.map((file) => file.id);
  const versions = await fetchVersionObjectsForFiles(db, fileIds);
  const drafts = await fetchDraftObjectsForFiles(db, fileIds);
  await deleteR2ObjectsAndAbortMultipart(db, bucket, [...versions, ...drafts]);

  const aiJobStmts = await buildOptionalAiJobDeleteStmts(db, fileIds);
  const statements: D1PreparedStatement[] = [
    ...fileIds.map((fileId) =>
      db.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(fileId)
    ),
    ...buildInClauseDeleteStmts(
      db,
      'permissions',
      'target_id',
      fileIds,
      "target_type = 'file'"
    ),
    ...buildInClauseDeleteStmts(
      db,
      'shared_links',
      'target_id',
      fileIds,
      "target_type = 'file'"
    ),
    ...buildInClauseDeleteStmts(db, 'file_versions', 'file_id', fileIds),
    ...buildInClauseDeleteStmts(db, 'wopi_drafts', 'file_id', fileIds),
    ...buildInClauseDeleteStmts(db, 'wopi_sessions', 'file_id', fileIds),
    ...aiJobStmts,
    ...buildInClauseDeleteStmts(db, 'files', 'id', fileIds),
    ...buildStatsDecrementStmts(db, tenantId, files, nowIso),
  ];

  if (actor) {
    for (const file of files) {
      statements.push(
        buildAuditLogStmt(db, {
          tenantId,
          actorId: actor.user.id,
          actorEmail: actor.user.email,
          actorIp: actor.user.ipAddress,
          action: 'file.purge',
          targetType: 'file',
          targetId: file.id,
          classificationSnapshot: file.classification,
          metadata: {
            sizeBytes: file.size_bytes,
            uploadState: file.upload_state,
            ...(actor.metadata ?? {}),
          },
          nowIso,
        }),
        buildSyncChangeStmt(db, {
          tenantId,
          entityType: 'file',
          entityId: file.id,
          folderId: file.folder_id ?? null,
          action: 'file.purged',
          payload: {
            folderId: file.folder_id ?? null,
            purgedAt: nowIso,
          },
          nowIso,
        })
      );
    }
  }

  const results = await executeBatchChunks(
    db,
    statements,
    PURGE_STATEMENT_CHUNK
  );
  return {
    filesPurged: fileIds.length,
    syncSeq: actor ? extractLastSyncSeq(results) : null,
  };
}

/** Delete folder rows and their closure/permission/shared-link rows. */
export async function purgeFolderRows(
  db: D1Database,
  folderIds: readonly string[]
): Promise<number> {
  if (folderIds.length === 0) return 0;

  const statements: D1PreparedStatement[] = [
    ...buildInClauseDeleteStmts(
      db,
      'permissions',
      'target_id',
      folderIds,
      "target_type = 'folder'"
    ),
    ...buildInClauseDeleteStmts(
      db,
      'shared_links',
      'target_id',
      folderIds,
      "target_type = 'folder'"
    ),
    ...buildInClauseDeleteStmts(db, 'file_requests', 'folder_id', folderIds),
  ];

  for (const chunk of chunkArray(folderIds, PURGE_STATEMENT_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    statements.push(
      db
        .prepare(
          `DELETE FROM folder_closures
            WHERE ancestor_id IN (${placeholders})
               OR descendant_id IN (${placeholders})`
        )
        .bind(...chunk, ...chunk)
    );
  }

  statements.push(...buildInClauseDeleteStmts(db, 'folders', 'id', folderIds));
  await executeBatchChunks(db, statements, PURGE_STATEMENT_CHUNK);
  return folderIds.length;
}

async function loadFolderDescendantIds(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT descendant_id
         FROM folder_closures
        WHERE tenant_id = ? AND ancestor_id = ?
        ORDER BY depth DESC, descendant_id ASC`
    )
    .bind(tenantId, folderId)
    .all<{ descendant_id: string }>();
  return rows.results.length > 0
    ? rows.results.map((row) => row.descendant_id)
    : [folderId];
}

async function loadFilesInFolders(
  db: D1Database,
  tenantId: string,
  folderIds: readonly string[]
): Promise<PurgeFileRow[]> {
  const files: PurgeFileRow[] = [];
  for (const chunk of chunkArray(folderIds, PURGE_STATEMENT_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const res = await db
      .prepare(
        `SELECT id, folder_id, deleted_at, classification, size_bytes, upload_state, created_by
           FROM files
          WHERE tenant_id = ? AND folder_id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<PurgeFileRow>();
    files.push(...res.results);
  }
  return files;
}

async function assertFilesNotLocked(
  env: Pick<OidcEnv, 'FILE_LOCK_HUB'>,
  files: readonly PurgeFileRow[]
): Promise<void> {
  for (const file of files) {
    await assertFileNotLocked(env, file.id);
  }
}

/** Purge exactly one trashed file (manual API semantics + lock protection). */
export async function purgeTrashFileItem(
  env: Pick<OidcEnv, 'DB' | 'BUCKET' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  fileId: string,
  nowIso = new Date().toISOString(),
  adminContext?: TrashPurgeAdminContext
): Promise<{
  result: TrashPurgeItemResult;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}> {
  if (adminContext && user.role !== 'sys_admin') {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }

  const [access, file] = await Promise.all([
    resolveTargetAccess(env.DB, user, 'file', fileId),
    env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);

  if (!file || (!access && !adminContext)) {
    throw new TrashRequestError(404, 'NOT_FOUND', 'File not found');
  }
  if (file.deleted_at === null) {
    throw new TrashRequestError(
      409,
      'NOT_IN_TRASH',
      'File is not in Trash'
    );
  }
  if (file.upload_state !== 'active') {
    throw new TrashRequestError(
      409,
      'UPLOAD_NOT_ACTIVE',
      'File upload is not active and cannot be purged'
    );
  }
  if (
    !adminContext &&
    user.role !== 'sys_admin' &&
    !can(access?.capabilities, 'trash.purge')
  ) {
    throw new TrashRequestError(
      403,
      'FORBIDDEN',
      'Co-owner or owner permission required to permanently delete'
    );
  }

  await assertFileNotLocked(env, fileId);
  const protection = await checkPurgeProtection(
    env.DB,
    user.tenantId,
    'file',
    fileId,
    {
      createdBy: file.created_by,
      classification: file.classification,
      createdAt: file.created_at,
      nowIso,
    }
  );
  if (protection.blocked) {
    throw new PurgeProtectionError(protection);
  }

  const { syncSeq } = await purgeFileRows({
    db: env.DB,
    bucket: env.BUCKET,
    tenantId: user.tenantId,
    files: [file],
    nowIso,
    actor: {
      user,
      nowIso,
      ...(adminContext
        ? {
            metadata: {
              targetName: file.name,
              sourceVersion: file.current_version_num,
              adminBypass: true,
              onBehalfOfUserId: adminContext.owner.id,
              ownerId: adminContext.owner.id,
              ownerName: adminContext.owner.name,
              ownerEmail: adminContext.owner.email,
            },
          }
        : {}),
    },
  });

  return {
    result: {
      type: 'file',
      id: file.id,
      ok: true,
      status: 'succeeded',
      name: file.name,
      purgedFileCount: 1,
      purgedFolderCount: 0,
    },
    syncSeq,
    scopeFolderIds: [file.folder_id],
  };
}

/** Purge a trashed folder and every descendant (manual API semantics). */
export async function purgeTrashFolderItem(
  env: Pick<OidcEnv, 'DB' | 'BUCKET' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  folderId: string,
  nowIso = new Date().toISOString(),
  adminContext?: TrashPurgeAdminContext
): Promise<{
  result: TrashPurgeItemResult;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}> {
  if (adminContext && user.role !== 'sys_admin') {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }

  const [access, folder] = await Promise.all([
    resolveTargetAccess(env.DB, user, 'folder', folderId),
    env.DB.prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, folderId)
      .first<FolderRow>(),
  ]);

  if (!folder || (!access && !adminContext)) {
    throw new TrashRequestError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (folder.deleted_at === null) {
    throw new TrashRequestError(
      409,
      'NOT_IN_TRASH',
      'Folder is not in Trash'
    );
  }
  if (
    !adminContext &&
    user.role !== 'sys_admin' &&
    !can(access?.capabilities, 'trash.purge')
  ) {
    throw new TrashRequestError(
      403,
      'FORBIDDEN',
      'Co-owner or owner permission required to permanently delete'
    );
  }

  const folderIds = await loadFolderDescendantIds(
    env.DB,
    user.tenantId,
    folderId
  );
  const files = await loadFilesInFolders(
    env.DB,
    user.tenantId,
    folderIds
  );

  await assertFilesNotLocked(env, files);
  const folderProtection = await checkPurgeProtection(
    env.DB,
    user.tenantId,
    'folder',
    folderId,
    {
      createdBy: folder.created_by,
      classification: folder.classification,
      createdAt: folder.created_at,
      nowIso,
    }
  );
  if (folderProtection.blocked) {
    throw new PurgeProtectionError(folderProtection);
  }

  const { syncSeq } = await purgeFileRows({
    db: env.DB,
    bucket: env.BUCKET,
    tenantId: user.tenantId,
    files,
    nowIso,
  });
  const foldersPurged = await purgeFolderRows(env.DB, folderIds);

  const syncResults = await env.DB.batch([
    buildAuditLogStmt(env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.purge',
      targetType: 'folder',
      targetId: folder.id,
      classificationSnapshot: folder.classification,
      metadata: {
        purgedFileCount: files.length,
        purgedFolderCount: foldersPurged,
        ...(adminContext
          ? {
              targetName: folder.name,
              sourceVersion: folder.version,
              adminBypass: true,
              onBehalfOfUserId: adminContext.owner.id,
              ownerId: adminContext.owner.id,
              ownerName: adminContext.owner.name,
              ownerEmail: adminContext.owner.email,
            }
          : {}),
      },
      nowIso,
    }),
    buildSyncChangeStmt(env.DB, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folder.id,
      folderId: folder.parent_id,
      action: 'folder.purged',
      payload: {
        parentId: folder.parent_id,
        purgedAt: nowIso,
        purgedFileCount: files.length,
        purgedFolderCount: foldersPurged,
      },
      nowIso,
    }),
  ]);

  return {
    result: {
      type: 'folder',
      id: folder.id,
      ok: true,
      status: 'succeeded',
      name: folder.name,
      purgedFileCount: files.length,
      purgedFolderCount: foldersPurged,
    },
    syncSeq: extractLastSyncSeq(syncResults) ?? syncSeq,
    scopeFolderIds: [folder.parent_id],
  };
}

function toPurgeFailure(
  item: TrashItemRefInput,
  err: unknown
): TrashPurgeItemResult {
  if (err instanceof FileLockedError || err instanceof PurgeProtectionError) {
    return {
      type: item.type,
      id: item.id,
      ok: false,
      status: 'skipped',
      code: err.code,
      error: err.message,
    };
  }
  if (err instanceof TrashRequestError) {
    return {
      type: item.type,
      id: item.id,
      ok: false,
      status: 'failed',
      code: err.code,
      error: err.message,
    };
  }
  console.error('[trash-purge] unexpected item failure:', err);
  return {
    type: item.type,
    id: item.id,
    ok: false,
    status: 'failed',
    code: 'INTERNAL_ERROR',
    error: 'Failed to purge item',
  };
}

/** Purge up to 100 explicitly selected Trash items independently. */
export async function purgeTrashItems(
  env: Pick<OidcEnv, 'DB' | 'BUCKET' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  items: readonly TrashItemRefInput[],
  nowIso = new Date().toISOString()
): Promise<TrashPurgeBulkResult> {
  const results: TrashPurgeItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;

  for (const item of items) {
    try {
      const outcome =
        item.type === 'file'
          ? await purgeTrashFileItem(env, user, item.id, nowIso)
          : await purgeTrashFolderItem(env, user, item.id, nowIso);
      results.push(outcome.result);
      outcome.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
      if (outcome.syncSeq !== null) {
        lastSeq = Math.max(lastSeq ?? 0, outcome.syncSeq);
      }
    } catch (err) {
      results.push(toPurgeFailure(item, err));
    }
  }

  const succeededCount = results.filter((result) => result.ok).length;
  const skippedCount = results.filter(
    (result) => result.status === 'skipped'
  ).length;
  return {
    results,
    succeededCount,
    // Explicit API contract: failedCount covers every non-success item,
    // including lock-skipped entries, so callers cannot mistake them as done.
    failedCount: results.length - succeededCount,
    skippedCount,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}

/**
 * List every accessible top-level Trash item the caller may permanently delete.
 * Intentionally no LIMIT: `empty` must drain >100-item Trash pages safely.
 */
async function listPurgeableTopLevelTrashItems(
  db: D1Database,
  user: AuthUser
): Promise<PurgeableTopLevelItem[]> {
  const folderRows = await db
    .prepare(
      `SELECT 'folder' AS type,
              f.id AS id,
              f.name AS name,
              (
                SELECT GROUP_CONCAT(DISTINCT p.role)
                  FROM folder_closures fc
                  JOIN permissions p
                    ON p.tenant_id = f.tenant_id
                   AND p.target_type = 'folder'
                   AND p.target_id = fc.ancestor_id
                 WHERE fc.tenant_id = f.tenant_id
                   AND fc.descendant_id = f.id
                   AND ${GRANTEE_MATCH_SQL}
              ) AS role_list
         FROM folders f
         LEFT JOIN folders pf ON pf.id = f.parent_id
        WHERE f.tenant_id = ?
          AND f.deleted_at IS NOT NULL
          AND (f.parent_id IS NULL OR pf.deleted_at IS NULL)`
    )
    .bind(user.id, user.id, user.tenantId)
    .all<PurgeableTopLevelItem>();

  const fileRows = await db
    .prepare(
      `SELECT 'file' AS type,
              fl.id AS id,
              fl.name AS name,
              (
                SELECT GROUP_CONCAT(DISTINCT p.role)
                  FROM permissions p
                 WHERE p.tenant_id = fl.tenant_id
                   AND ${GRANTEE_MATCH_SQL}
                   AND (
                     (p.target_type = 'file' AND p.target_id = fl.id)
                     OR (
                       p.target_type = 'folder'
                       AND fl.folder_id IS NOT NULL
                       AND p.target_id IN (
                         SELECT fc.ancestor_id
                           FROM folder_closures fc
                          WHERE fc.tenant_id = fl.tenant_id
                            AND fc.descendant_id = fl.folder_id
                       )
                     )
                   )
              ) AS role_list
         FROM files fl
         LEFT JOIN folders pf ON pf.id = fl.folder_id
        WHERE fl.tenant_id = ?
          AND fl.upload_state = 'active'
          AND fl.deleted_at IS NOT NULL
          AND (fl.folder_id IS NULL OR pf.deleted_at IS NULL)`
    )
    .bind(user.id, user.id, user.tenantId)
    .all<PurgeableTopLevelItem>();

  const isSysAdmin = user.role === 'sys_admin';
  return [...folderRows.results, ...fileRows.results].filter((item) => {
    // No grant at all means the item is outside the caller's Trash range, even
    // for sys_admin (tenant-wide admin bypass lives in the admin endpoints).
    if (!item.role_list) return false;
    if (isSysAdmin) return true;
    // Purge requires the `trash.purge` capability (co_owner/owner) after
    // non-linear composition; an `editor + uploader` grant stays editor.
    return can(synthesizeEffectiveAccess(parseRoleList(item.role_list)).capabilities, 'trash.purge');
  });
}

/**
 * Empty the caller's purgeable Trash view. Editor/viewer/previewer-only shared
 * items are intentionally skipped; tenant-wide admin bypass belongs to P8-6.
 */
export async function emptyTrash(
  env: Pick<OidcEnv, 'DB' | 'BUCKET' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  nowIso = new Date().toISOString()
): Promise<TrashEmptyResult> {
  const candidates = await listPurgeableTopLevelTrashItems(env.DB, user);
  const results: TrashPurgeItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;

  for (const candidate of candidates) {
    const item: TrashItemRefInput = {
      type: candidate.type,
      id: candidate.id,
    };
    try {
      const outcome =
        candidate.type === 'file'
          ? await purgeTrashFileItem(env, user, candidate.id, nowIso)
          : await purgeTrashFolderItem(env, user, candidate.id, nowIso);
      results.push({ ...outcome.result, name: outcome.result.name ?? candidate.name });
      outcome.scopeFolderIds.forEach((id) => scopeFolderIds.add(id));
      if (outcome.syncSeq !== null) {
        lastSeq = Math.max(lastSeq ?? 0, outcome.syncSeq);
      }
    } catch (err) {
      const failure = toPurgeFailure(item, err);
      results.push({ ...failure, name: failure.name ?? candidate.name });
    }
  }

  const deletedCount = results.filter((result) => result.ok).length;
  const skippedCount = results.filter(
    (result) => result.status === 'skipped'
  ).length;
  return {
    results,
    deletedCount,
    failedCount: results.length - deletedCount - skippedCount,
    skippedCount,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}
