import type { AuthUser, ClassificationLabel } from '../types/api';
import type { CopySubtreeQueueMessage } from '../types/classification';
import { chunkArray, executeBatchChunks } from '../utils/batch';
import { pickStricterClassification } from '../utils/classification';
import { buildAuditLogStmt } from './audit';
import { hasAtLeastRole, resolveTargetAccess } from './authorization';
import {
  buildClassificationPolicyStatements,
  resolveFolderClassificationFloor,
} from './classification-updater';
import {
  type FileRow,
  FileUploadError,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from './file-upload-common';
import {
  type FolderRow,
  FolderServiceError,
  MAX_FOLDER_DEPTH,
  moveFolderSubtree,
  validateFolderName,
} from './folder-closure-service';
import { buildSyncChangeStmt, getSyncWatermarks } from './sync-changes';
import { notifyTenantSyncHub } from './sync-notifier';
import type { OidcEnv } from '../types/oidc';

export const MAX_WORKSPACE_BATCH_ITEMS = 50;
export const SYNC_COPY_NODE_LIMIT = 100;
const ASYNC_COPY_CHUNK_NODES = 15;
const MAX_COPY_RENAME_ATTEMPTS = 100;

export class WorkspaceOpError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 413,
    public readonly code: string,
    message: string,
    public readonly latest?: unknown
  ) {
    super(message);
    this.name = 'WorkspaceOpError';
  }
}

export interface WorkspaceBatchItemInput {
  type: 'file' | 'folder';
  id: string;
  expectedVersion?: number;
}

export type WorkspaceConflictPolicy = 'fail' | 'rename';

interface DestinationContext {
  parentId: string | null;
  folder: FolderRow | null;
  depth: number;
  floorClassification: ClassificationLabel;
}

interface CopyableFileRow extends FileRow {
  r2_object_key: string;
}

interface CopyFrontierEntry {
  kind: 'folder' | 'file';
  srcId: string;
  destParentId: string | null;
  targetName: string;
  depth?: number;
}

interface CopyJobState {
  frontier: CopyFrontierEntry[];
  destFloor: ClassificationLabel;
  createdFolderIds: string[];
  scopeFolderIds: Array<string | null>;
}

export interface BatchMoveResult {
  ok: true;
  movedFolders: FolderRow[];
  movedFiles: FileRow[];
  skippedIds: string[];
  classificationJobQueued: boolean;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

export interface CopyWorkspaceResult {
  ok: true;
  queued: boolean;
  jobId?: string;
  totalItems: number;
  copiedFolders: FolderRow[];
  copiedFiles: FileRow[];
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

function dedupeBatchItems(rawItems: unknown): WorkspaceBatchItemInput[] {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new WorkspaceOpError(400, 'EMPTY_ITEMS', 'items array must be non-empty');
  }
  const seen = new Set<string>();
  const normalized: WorkspaceBatchItemInput[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') {
      throw new WorkspaceOpError(400, 'INVALID_ITEM', 'Each item must be an object');
    }
    const item = raw as { type?: unknown; id?: unknown; expectedVersion?: unknown };
    if (item.type !== 'file' && item.type !== 'folder') {
      throw new WorkspaceOpError(400, 'INVALID_ITEM_TYPE', 'item.type must be file or folder');
    }
    if (typeof item.id !== 'string' || item.id.trim().length === 0) {
      throw new WorkspaceOpError(400, 'INVALID_ITEM_ID', 'item.id must be a non-empty string');
    }
    const id = item.id.trim();
    const key = `${item.type}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let expectedVersion: number | undefined;
    if (item.expectedVersion !== undefined) {
      if (
        typeof item.expectedVersion !== 'number' ||
        !Number.isInteger(item.expectedVersion) ||
        item.expectedVersion < 1
      ) {
        throw new WorkspaceOpError(400, 'INVALID_VERSION', 'expectedVersion must be a positive integer');
      }
      expectedVersion = item.expectedVersion;
    }

    normalized.push({ type: item.type, id, expectedVersion });
  }

  if (normalized.length > MAX_WORKSPACE_BATCH_ITEMS) {
    throw new WorkspaceOpError(
      400,
      'TOO_MANY_ITEMS',
      `Maximum ${MAX_WORKSPACE_BATCH_ITEMS} items per workspace request`
    );
  }
  return normalized;
}

/**
 * Generate a unique name inside `takenNames` preserving file extension and <=255 char bound.
 */
export function allocateCopyName(
  desiredName: string,
  kind: 'file' | 'folder',
  takenNames: Set<string>
): string {
  if (!takenNames.has(desiredName)) {
    takenNames.add(desiredName);
    return desiredName;
  }

  let stem = desiredName;
  let extSuffix = '';
  if (kind === 'file') {
    const dotIdx = desiredName.lastIndexOf('.');
    if (dotIdx > 0 && dotIdx < desiredName.length - 1) {
      stem = desiredName.slice(0, dotIdx);
      extSuffix = desiredName.slice(dotIdx);
    }
  }

  for (let idx = 1; idx <= MAX_COPY_RENAME_ATTEMPTS; idx++) {
    const copyTag = idx === 1 ? ' (コピー)' : ` (コピー ${idx})`;
    const maxStemLen = Math.max(1, 255 - copyTag.length - extSuffix.length);
    const candidate = `${stem.slice(0, maxStemLen)}${copyTag}${extSuffix}`;
    if (!takenNames.has(candidate)) {
      takenNames.add(candidate);
      return candidate;
    }
  }

  const fallbackTag = ` (${crypto.randomUUID().slice(0, 8)})`;
  const maxStemLen = Math.max(1, 255 - fallbackTag.length - extSuffix.length);
  const fallback = `${stem.slice(0, maxStemLen)}${fallbackTag}${extSuffix}`;
  takenNames.add(fallback);
  return fallback;
}

async function resolveDestinationContext(
  db: D1Database,
  user: AuthUser,
  targetParentId: string | null
): Promise<DestinationContext> {
  if (targetParentId === null) {
    return {
      parentId: null,
      folder: null,
      depth: -1,
      floorClassification: 'unset',
    };
  }

  const [destAccess, destFolder] = await Promise.all([
    resolveTargetAccess(db, user, 'folder', targetParentId),
    db
      .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(user.tenantId, targetParentId)
      .first<FolderRow>(),
  ]);

  if (!destAccess || destAccess.deletedAt !== null || !destFolder) {
    throw new WorkspaceOpError(404, 'TARGET_NOT_FOUND', 'Destination folder not found');
  }
  if (!hasAtLeastRole(destAccess.effectiveRole, 'editor')) {
    throw new WorkspaceOpError(403, 'FORBIDDEN', 'Editor permission required on destination folder');
  }

  const floorClassification = await resolveFolderClassificationFloor(
    db,
    user.tenantId,
    targetParentId
  );

  return {
    parentId: targetParentId,
    folder: destFolder,
    depth: destFolder.depth,
    floorClassification,
  };
}

async function loadExistingNamesInDestination(
  db: D1Database,
  tenantId: string,
  targetParentId: string | null
): Promise<{ folderNames: Set<string>; fileNames: Set<string> }> {
  const folderQuery =
    targetParentId === null
      ? db
          .prepare(
            `SELECT name FROM folders
              WHERE tenant_id = ? AND parent_id IS NULL AND deleted_at IS NULL`
          )
          .bind(tenantId)
      : db
          .prepare(
            `SELECT name FROM folders
              WHERE tenant_id = ? AND parent_id = ? AND deleted_at IS NULL`
          )
          .bind(tenantId, targetParentId);

  const fileQuery =
    targetParentId === null
      ? db
          .prepare(
            `SELECT name FROM files
              WHERE tenant_id = ? AND folder_id IS NULL AND deleted_at IS NULL AND upload_state != 'failed'`
          )
          .bind(tenantId)
      : db
          .prepare(
            `SELECT name FROM files
              WHERE tenant_id = ? AND folder_id = ? AND deleted_at IS NULL AND upload_state != 'failed'`
          )
          .bind(tenantId, targetParentId);

  const [folderRows, fileRows] = await Promise.all([
    folderQuery.all<{ name: string }>(),
    fileQuery.all<{ name: string }>(),
  ]);

  return {
    folderNames: new Set(folderRows.results.map((r) => r.name)),
    fileNames: new Set(fileRows.results.map((r) => r.name)),
  };
}

async function findSelectedDescendantFolderSet(
  db: D1Database,
  tenantId: string,
  selectedFolderIds: readonly string[]
): Promise<Set<string>> {
  const strictDescendantFolders = new Set<string>();
  if (selectedFolderIds.length === 0) return strictDescendantFolders;

  for (const chunk of chunkArray(selectedFolderIds, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT DISTINCT descendant_id
           FROM folder_closures
          WHERE tenant_id = ?
            AND ancestor_id IN (${placeholders})
            AND depth > 0`
      )
      .bind(tenantId, ...chunk)
      .all<{ descendant_id: string }>();

    for (const row of rows.results) {
      strictDescendantFolders.add(row.descendant_id);
    }
  }
  return strictDescendantFolders;
}

function wrapServiceError(err: unknown): never {
  if (err instanceof FolderServiceError || err instanceof FileUploadError) {
    const latest = err instanceof FolderServiceError ? err.latest : undefined;
    throw new WorkspaceOpError(err.status, err.code, err.message, latest);
  }
  throw err;
}

async function resolveLatestSyncSeq(db: D1Database, tenantId: string): Promise<number | null> {
  const watermarks = await getSyncWatermarks(db, tenantId);
  return watermarks.currentSeq > 0 ? watermarks.currentSeq : null;
}

/**
 * Batch move multiple folders and files to `targetParentId` with upfront RBAC,
 * closure cycle/depth verification, confidential upward inheritance, and chunked D1 updates.
 */
export async function batchMoveWorkspaceItems(
  db: D1Database,
  queue: Queue,
  user: AuthUser,
  input: {
    items: unknown;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
  }
): Promise<BatchMoveResult> {
  const items = dedupeBatchItems(input.items);
  const conflictPolicy: WorkspaceConflictPolicy =
    input.conflictPolicy === 'rename' ? 'rename' : 'fail';
  const dest = await resolveDestinationContext(db, user, input.targetParentId);

  const selectedFolderRefs = items.filter((item) => item.type === 'folder');
  const selectedFileRefs = items.filter((item) => item.type === 'file');

  // Verify access, existence, and expectedVersion for every explicitly requested item upfront
  const validatedFolders = await Promise.all(
    selectedFolderRefs.map(async (ref) => {
      const [access, row] = await Promise.all([
        resolveTargetAccess(db, user, 'folder', ref.id),
        db
          .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
          .bind(user.tenantId, ref.id)
          .first<FolderRow>(),
      ]);
      if (!access || access.deletedAt !== null || !row) {
        throw new WorkspaceOpError(404, 'NOT_FOUND', `Folder not found: ${ref.id}`);
      }
      if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
        throw new WorkspaceOpError(403, 'FORBIDDEN', 'Editor permission required to move folder');
      }
      if (ref.expectedVersion !== undefined && row.version !== ref.expectedVersion) {
        throw new WorkspaceOpError(
          409,
          'VERSION_CONFLICT',
          `Folder version mismatch for ${row.name}`,
          row
        );
      }
      return { ref, access, row };
    })
  );

  const validatedFiles = await Promise.all(
    selectedFileRefs.map(async (ref) => {
      const [access, row] = await Promise.all([
        resolveTargetAccess(db, user, 'file', ref.id),
        db
          .prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
          .bind(user.tenantId, ref.id)
          .first<FileRow>(),
      ]);
      if (!access || !row || row.upload_state !== 'active') {
        throw new WorkspaceOpError(404, 'NOT_FOUND', `File not found: ${ref.id}`);
      }
      if (!hasAtLeastRole(access.effectiveRole, 'editor')) {
        throw new WorkspaceOpError(403, 'FORBIDDEN', 'Editor permission required to move file');
      }
      if (ref.expectedVersion !== undefined && row.meta_version !== ref.expectedVersion) {
        throw new WorkspaceOpError(
          409,
          'VERSION_CONFLICT',
          `File version mismatch for ${row.name}`,
          row
        );
      }
      return { ref, access, row };
    })
  );

  // Prune redundant selected descendants whose ancestor folder is also being moved
  const selectedFolderIdSet = new Set(validatedFolders.map((entry) => entry.row.id));
  const strictDescendantFolderSet = await findSelectedDescendantFolderSet(
    db,
    user.tenantId,
    [...selectedFolderIdSet]
  );

  const rootFoldersToProcess = validatedFolders.filter(
    (entry) => !strictDescendantFolderSet.has(entry.row.id)
  );
  const rootFilesToProcess = validatedFiles.filter(
    (entry) =>
      entry.row.folder_id === null ||
      (!selectedFolderIdSet.has(entry.row.folder_id) &&
        !strictDescendantFolderSet.has(entry.row.folder_id))
  );

  const skippedIds: string[] = [];
  const foldersToMove: Array<{
    accessRole: AuthUser['role'] | NonNullable<typeof validatedFolders[number]['access']['effectiveRole']>;
    row: FolderRow;
    targetName: string;
  }> = [];
  const filesToMove: Array<{
    effectiveRole: NonNullable<typeof validatedFiles[number]['access']['effectiveRole']>;
    row: FileRow;
    targetName: string;
    targetExt: string | null;
  }> = [];

  const existingNames = await loadExistingNamesInDestination(db, user.tenantId, dest.parentId);

  for (const entry of rootFoldersToProcess) {
    const folder = entry.row;
    if (folder.parent_id === dest.parentId) {
      skippedIds.push(folder.id);
      continue;
    }
    if (dest.parentId === folder.id) {
      throw new WorkspaceOpError(400, 'CYCLE_DETECTED', 'Cannot move a folder into itself');
    }
    if (dest.parentId === null && folder.parent_id !== null) {
      if (!hasAtLeastRole(entry.access.effectiveRole, 'owner')) {
        throw new WorkspaceOpError(
          403,
          'FORBIDDEN',
          'Owner permission required to promote a folder to workspace root'
        );
      }
    }

    if (dest.parentId !== null) {
      const cycleRow = await db
        .prepare(
          `SELECT 1 AS hit FROM folder_closures
            WHERE tenant_id = ? AND ancestor_id = ? AND descendant_id = ?
            LIMIT 1`
        )
        .bind(user.tenantId, folder.id, dest.parentId)
        .first<{ hit: number }>();
      if (cycleRow) {
        throw new WorkspaceOpError(
          400,
          'CYCLE_DETECTED',
          'Cannot move a folder into one of its descendants'
        );
      }
    }

    const subDepthRow = await db
      .prepare(
        `SELECT COALESCE(MAX(depth), 0) AS max_sub_depth
           FROM folder_closures
          WHERE tenant_id = ? AND ancestor_id = ?`
      )
      .bind(user.tenantId, folder.id)
      .first<{ max_sub_depth: number }>();
    const maxSubDepth = subDepthRow?.max_sub_depth ?? 0;
    const newRootDepth = dest.parentId === null ? 0 : dest.depth + 1;
    if (newRootDepth + maxSubDepth > MAX_FOLDER_DEPTH) {
      throw new WorkspaceOpError(
        400,
        'MAX_DEPTH_EXCEEDED',
        `Move exceeds maximum folder depth (${MAX_FOLDER_DEPTH})`
      );
    }

    let targetName = folder.name;
    if (existingNames.folderNames.has(targetName)) {
      if (conflictPolicy === 'fail') {
        throw new WorkspaceOpError(
          409,
          'NAME_CONFLICT',
          `A folder named "${targetName}" already exists in destination`
        );
      }
      targetName = allocateCopyName(targetName, 'folder', existingNames.folderNames);
    } else {
      existingNames.folderNames.add(targetName);
    }

    foldersToMove.push({
      accessRole: entry.access.effectiveRole!,
      row: folder,
      targetName,
    });
  }

  for (const entry of rootFilesToProcess) {
    const file = entry.row;
    if (file.folder_id === dest.parentId) {
      skippedIds.push(file.id);
      continue;
    }

    let targetName = file.name;
    let targetExt = file.extension;
    if (existingNames.fileNames.has(targetName)) {
      if (conflictPolicy === 'fail') {
        throw new WorkspaceOpError(
          409,
          'NAME_CONFLICT',
          `An active file named "${targetName}" already exists in destination folder`
        );
      }
      targetName = allocateCopyName(targetName, 'file', existingNames.fileNames);
      targetExt = validateFileNameAndExt(targetName).extension;
    } else {
      existingNames.fileNames.add(targetName);
    }

    filesToMove.push({
      effectiveRole: entry.access.effectiveRole!,
      row: file,
      targetName,
      targetExt,
    });
  }

  // Execute validated file moves using chunked D1 statements
  const nowIso = new Date().toISOString();
  const scopeFolders = new Set<string | null>([dest.parentId]);
  const movedFiles: FileRow[] = [];

  if (filesToMove.length > 0) {
    const fileStmts: D1PreparedStatement[] = [];
    for (const item of filesToMove) {
      const file = item.row;
      scopeFolders.add(file.folder_id);
      const nextClassification =
        dest.parentId !== null
          ? pickStricterClassification(file.classification, dest.floorClassification)
          : file.classification;
      const nextMetaVersion = file.meta_version + 1;

      fileStmts.push(
        db
          .prepare(
            `UPDATE files
                SET folder_id = ?, name = ?, extension = ?, classification = ?,
                    meta_version = meta_version + 1, updated_by = ?, updated_at = ?
              WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
          )
          .bind(
            dest.parentId,
            item.targetName,
            item.targetExt,
            nextClassification,
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
            nextClassification,
            item.targetName,
            item.targetExt ?? '',
            file.ai_reason ?? ''
          ),
        ...buildClassificationPolicyStatements(db, {
          tenantId: user.tenantId,
          fileId: file.id,
          fromClassification: file.classification,
          toClassification: nextClassification,
          sizeBytes: file.size_bytes,
          actorId: user.id,
          nowIso,
        })
      );

      if (dest.parentId === null) {
        fileStmts.push(
          db
            .prepare(
              `INSERT INTO permissions (
                 id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
               ) VALUES (?, ?, 'file', ?, 'user', ?, ?, ?, ?)
               ON CONFLICT (target_type, target_id, grantee_type, grantee_id) DO NOTHING`
            )
            .bind(
              crypto.randomUUID(),
              user.tenantId,
              file.id,
              user.id,
              item.effectiveRole,
              user.id,
              nowIso
            )
        );
      }

      fileStmts.push(
        buildAuditLogStmt(db, {
          tenantId: user.tenantId,
          actorId: user.id,
          actorEmail: user.email,
          actorIp: user.ipAddress,
          action: 'file.move',
          targetType: 'file',
          targetId: file.id,
          classificationSnapshot: nextClassification,
          metadata: {
            batch: true,
            fromName: file.name,
            toName: item.targetName,
            fromFolderId: file.folder_id,
            toFolderId: dest.parentId,
            fromClassification: file.classification,
            toClassification: nextClassification,
          },
          nowIso,
        }),
        buildSyncChangeStmt(db, {
          tenantId: user.tenantId,
          entityType: 'file',
          entityId: file.id,
          folderId: dest.parentId,
          action: 'file.update',
          payload: {
            name: item.targetName,
            extension: item.targetExt,
            folderId: dest.parentId,
            previousFolderId: file.folder_id,
            classification: nextClassification,
            metaVersion: nextMetaVersion,
            updatedAt: nowIso,
          },
          nowIso,
        })
      );

      if (file.folder_id !== null) {
        fileStmts.push(
          buildSyncChangeStmt(db, {
            tenantId: user.tenantId,
            entityType: 'file',
            entityId: file.id,
            folderId: file.folder_id,
            action: 'file.moved_out',
            payload: {
              toFolderId: dest.parentId,
              metaVersion: nextMetaVersion,
              updatedAt: nowIso,
            },
            nowIso,
          })
        );
      }
    }

    await executeBatchChunks(db, fileStmts, 30);

    for (const chunk of chunkArray(
      filesToMove.map((entry) => entry.row.id),
      30
    )) {
      const placeholders = chunk.map(() => '?').join(', ');
      const updatedRows = await db
        .prepare(`SELECT * FROM files WHERE tenant_id = ? AND id IN (${placeholders})`)
        .bind(user.tenantId, ...chunk)
        .all<FileRow>();
      movedFiles.push(...updatedRows.results);
    }
  }

  // Execute validated folder subtree moves reusing closure-table service
  const movedFolders: FolderRow[] = [];
  let classificationJobQueued = false;

  for (const item of foldersToMove) {
    scopeFolders.add(item.row.parent_id);
    scopeFolders.add(item.row.id);

    try {
      const res = await moveFolderSubtree(db, queue, user, item.row.id, {
        targetParentId: dest.parentId,
        expectedVersion: item.row.version,
        ...(item.targetName !== item.row.name ? { targetName: item.targetName } : {}),
      });
      movedFolders.push(res.folder);
      if (res.classificationJobQueued) {
        classificationJobQueued = true;
      }
    } catch (err) {
      wrapServiceError(err);
    }
  }

  const syncSeq = await resolveLatestSyncSeq(db, user.tenantId);
  return {
    ok: true,
    movedFolders,
    movedFiles,
    skippedIds,
    classificationJobQueued,
    syncSeq,
    scopeFolderIds: [...scopeFolders],
  };
}

/**
 * Append D1 statements to logically CoW-copy one file (sharing existing immutable `r2_object_key`).
 */
function buildCoWFileCopyStatements(
  db: D1Database,
  params: {
    tenantId: string;
    actor: { id: string; email: string; ipAddress: string };
    orig: CopyableFileRow;
    destFolderId: string | null;
    targetName: string;
    destFloor: ClassificationLabel;
    nowIso: string;
    stmts: D1PreparedStatement[];
    statsDeltas: Map<ClassificationLabel, { count: number; bytes: number }>;
    createdFiles: FileRow[];
  }
): void {
  const newFileId = crypto.randomUUID();
  const newVersionId = crypto.randomUUID();
  const parsed = validateFileNameAndExt(params.targetName);
  const nextClassification = pickStricterClassification(
    params.orig.classification,
    params.destFloor
  );

  params.stmts.push(
    db
      .prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, meta_version,
           classification, ai_suggested_label, ai_confidence, ai_reason, ai_evaluated_at,
           classification_updated_by, classification_updated_at,
           created_by, updated_by, deleted_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, 1, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .bind(
        newFileId,
        params.tenantId,
        params.destFolderId,
        parsed.name,
        parsed.extension,
        params.orig.mime_type,
        params.orig.size_bytes,
        newVersionId,
        nextClassification,
        nextClassification !== 'unset' ? params.actor.id : null,
        nextClassification !== 'unset' ? params.nowIso : null,
        params.actor.id,
        params.actor.id,
        params.nowIso,
        params.nowIso
      ),
    db
      .prepare(
        `INSERT INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key, r2_upload_id,
           size_bytes, mime_type, upload_status, uploaded_by, comment, created_at
         ) VALUES (?, ?, ?, 1, ?, NULL, ?, ?, 'completed', ?, 'Copied via CoW', ?)`
      )
      .bind(
        newVersionId,
        params.tenantId,
        newFileId,
        params.orig.r2_object_key,
        params.orig.size_bytes,
        params.orig.mime_type,
        params.actor.id,
        params.nowIso
      ),
    db
      .prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES (?, ?, ?, ?, ?, '')`
      )
      .bind(newFileId, params.tenantId, nextClassification, parsed.name, parsed.extension ?? '')
  );

  if (params.destFolderId === null) {
    params.stmts.push(
      db
        .prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
           ) VALUES (?, ?, 'file', ?, 'user', ?, 'owner', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          params.tenantId,
          newFileId,
          params.actor.id,
          params.actor.id,
          params.nowIso
        )
    );
  }

  const prev = params.statsDeltas.get(nextClassification) ?? { count: 0, bytes: 0 };
  params.statsDeltas.set(nextClassification, {
    count: prev.count + 1,
    bytes: prev.bytes + params.orig.size_bytes,
  });

  params.stmts.push(
    buildAuditLogStmt(db, {
      tenantId: params.tenantId,
      actorId: params.actor.id,
      actorEmail: params.actor.email,
      actorIp: params.actor.ipAddress,
      action: 'file.copy',
      targetType: 'file',
      targetId: newFileId,
      classificationSnapshot: nextClassification,
      metadata: {
        sourceFileId: params.orig.id,
        r2ObjectKey: params.orig.r2_object_key,
        cow: true,
        targetFolderId: params.destFolderId,
      },
      nowIso: params.nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: params.tenantId,
      entityType: 'file',
      entityId: newFileId,
      folderId: params.destFolderId,
      action: 'file.upload_complete',
      payload: {
        name: parsed.name,
        extension: parsed.extension,
        mimeType: params.orig.mime_type,
        sizeBytes: params.orig.size_bytes,
        currentVersionNum: 1,
        metaVersion: 1,
        classification: nextClassification,
        folderId: params.destFolderId,
        updatedAt: params.nowIso,
        isCopy: true,
      },
      nowIso: params.nowIso,
    })
  );

  params.createdFiles.push({
    id: newFileId,
    tenant_id: params.tenantId,
    folder_id: params.destFolderId,
    name: parsed.name,
    extension: parsed.extension,
    mime_type: params.orig.mime_type,
    size_bytes: params.orig.size_bytes,
    upload_state: 'active',
    current_version_id: newVersionId,
    current_version_num: 1,
    meta_version: 1,
    classification: nextClassification,
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    deleted_at: null,
    created_by: params.actor.id,
    updated_by: params.actor.id,
    created_at: params.nowIso,
    updated_at: params.nowIso,
  });
}

function appendStatsAndFolderCopyStatements(
  db: D1Database,
  params: {
    tenantId: string;
    actor: { id: string; email: string; ipAddress: string };
    orig: FolderRow;
    newFolderId: string;
    destParentId: string | null;
    targetName: string;
    depth: number;
    destFloor: ClassificationLabel;
    nowIso: string;
    stmts: D1PreparedStatement[];
    createdFolders: FolderRow[];
  }
): void {
  const nextClassification = pickStricterClassification(
    params.orig.classification,
    params.destFloor
  );
  const createdFolder: FolderRow = {
    id: params.newFolderId,
    tenant_id: params.tenantId,
    parent_id: params.destParentId,
    name: params.targetName,
    depth: params.depth,
    version: 1,
    classification: nextClassification,
    is_pinned: 0,
    created_by: params.actor.id,
    deleted_at: null,
    created_at: params.nowIso,
    updated_at: params.nowIso,
  };

  params.stmts.push(
    db
      .prepare(
        `INSERT INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification,
           is_pinned, created_by, deleted_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, NULL, ?, ?)`
      )
      .bind(
        params.newFolderId,
        params.tenantId,
        params.destParentId,
        params.targetName,
        params.depth,
        nextClassification,
        params.actor.id,
        params.nowIso,
        params.nowIso
      ),
    db
      .prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, ?, ?, 0)`
      )
      .bind(params.tenantId, params.newFolderId, params.newFolderId)
  );

  if (params.destParentId !== null) {
    params.stmts.push(
      db
        .prepare(
          `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
           SELECT ?, ancestor_id, ?, depth + 1
             FROM folder_closures
            WHERE tenant_id = ? AND descendant_id = ?`
        )
        .bind(params.tenantId, params.newFolderId, params.tenantId, params.destParentId)
    );
  } else {
    params.stmts.push(
      db
        .prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
           ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)`
        )
        .bind(
          crypto.randomUUID(),
          params.tenantId,
          params.newFolderId,
          params.actor.id,
          params.actor.id,
          params.nowIso
        )
    );
  }

  params.stmts.push(
    buildAuditLogStmt(db, {
      tenantId: params.tenantId,
      actorId: params.actor.id,
      actorEmail: params.actor.email,
      actorIp: params.actor.ipAddress,
      action: 'folder.copy',
      targetType: 'folder',
      targetId: params.newFolderId,
      classificationSnapshot: nextClassification,
      metadata: {
        sourceFolderId: params.orig.id,
        targetParentId: params.destParentId,
      },
      nowIso: params.nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: params.tenantId,
      entityType: 'folder',
      entityId: params.newFolderId,
      folderId: params.destParentId,
      action: 'folder.create',
      payload: { folder: createdFolder },
      nowIso: params.nowIso,
    })
  );

  params.createdFolders.push(createdFolder);
}

function appendStatsDeltasStatements(
  db: D1Database,
  tenantId: string,
  nowIso: string,
  statsDeltas: Map<ClassificationLabel, { count: number; bytes: number }>,
  stmts: D1PreparedStatement[]
): void {
  for (const [classification, delta] of statsDeltas.entries()) {
    if (delta.count === 0) continue;
    stmts.push(
      db
        .prepare(
          `INSERT INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, classification)
           DO UPDATE SET file_count = file_count + excluded.file_count,
                         total_bytes = total_bytes + excluded.total_bytes,
                         updated_at = excluded.updated_at`
        )
        .bind(tenantId, classification, delta.count, delta.bytes, nowIso)
    );
  }
}

/**
 * Copy files and folder subtrees to `targetParentId` using Zero-Copy R2 (CoW).
 * Enforces `viewer`+ DLP check on all sources and offloads >100-node subtrees to `JOBS_QUEUE`.
 */
export async function copyWorkspaceItems(
  db: D1Database,
  queue: Queue,
  user: AuthUser,
  input: {
    items: unknown;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
  }
): Promise<CopyWorkspaceResult> {
  const items = dedupeBatchItems(input.items);
  const conflictPolicy: WorkspaceConflictPolicy =
    input.conflictPolicy === 'fail' ? 'fail' : 'rename';
  const dest = await resolveDestinationContext(db, user, input.targetParentId);

  const folderRefs = items.filter((i) => i.type === 'folder');
  const fileRefs = items.filter((i) => i.type === 'file');

  // Verify every explicitly requested item exists, is active, and has at least `viewer` (downloadable) access
  const validatedFolders = await Promise.all(
    folderRefs.map(async (ref) => {
      const [access, row] = await Promise.all([
        resolveTargetAccess(db, user, 'folder', ref.id),
        db
          .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
          .bind(user.tenantId, ref.id)
          .first<FolderRow>(),
      ]);
      if (!access || access.deletedAt !== null || !row) {
        throw new WorkspaceOpError(404, 'NOT_FOUND', `Folder not found: ${ref.id}`);
      }
      if (!hasAtLeastRole(access.effectiveRole, 'viewer')) {
        await db
          .prepare(
            `INSERT INTO audit_logs (
               id, tenant_id, actor_id, actor_email, actor_ip, action,
               target_type, target_id, classification_snapshot, status, metadata_json, created_at
             ) VALUES (?, ?, ?, ?, ?, 'workspace.copy_denied', 'folder', ?, ?, 'blocked', ?, ?)`
          )
          .bind(
            crypto.randomUUID(),
            user.tenantId,
            user.id,
            user.email,
            user.ipAddress,
            ref.id,
            row.classification,
            JSON.stringify({
              effectiveRole: access.effectiveRole,
              targetParentId: dest.parentId,
            }),
            new Date().toISOString()
          )
          .run();
        throw new WorkspaceOpError(
          403,
          'DLP_COPY_FORBIDDEN',
          'Viewer permission required to copy folder (previewer cannot export or copy)'
        );
      }
      return { row, effectiveRole: access.effectiveRole! };
    })
  );

  const validatedFiles = await Promise.all(
    fileRefs.map(async (ref) => {
      const [access, row] = await Promise.all([
        resolveTargetAccess(db, user, 'file', ref.id),
        db
          .prepare(
            `SELECT fl.*, fv.r2_object_key
               FROM files fl
               JOIN file_versions fv ON fv.id = fl.current_version_id
              WHERE fl.tenant_id = ? AND fl.id = ? AND fl.deleted_at IS NULL`
          )
          .bind(user.tenantId, ref.id)
          .first<CopyableFileRow>(),
      ]);
      if (!access || !row || row.upload_state !== 'active') {
        throw new WorkspaceOpError(404, 'NOT_FOUND', `File not found: ${ref.id}`);
      }
      if (!hasAtLeastRole(access.effectiveRole, 'viewer')) {
        await db
          .prepare(
            `INSERT INTO audit_logs (
               id, tenant_id, actor_id, actor_email, actor_ip, action,
               target_type, target_id, classification_snapshot, status, metadata_json, created_at
             ) VALUES (?, ?, ?, ?, ?, 'workspace.copy_denied', 'file', ?, ?, 'blocked', ?, ?)`
          )
          .bind(
            crypto.randomUUID(),
            user.tenantId,
            user.id,
            user.email,
            user.ipAddress,
            ref.id,
            row.classification,
            JSON.stringify({
              effectiveRole: access.effectiveRole,
              targetParentId: dest.parentId,
            }),
            new Date().toISOString()
          )
          .run();
        throw new WorkspaceOpError(
          403,
          'DLP_COPY_FORBIDDEN',
          'Viewer permission required to copy file (previewer cannot export or copy)'
        );
      }
      return { row, effectiveRole: access.effectiveRole! };
    })
  );

  // Prune redundant descendants if user selected both ancestor folder and child items
  const rootFolderIds = validatedFolders.map((v) => v.row.id);
  const selectedFolderIdSet = new Set(rootFolderIds);
  const strictDescendantSet = await findSelectedDescendantFolderSet(
    db,
    user.tenantId,
    rootFolderIds
  );

  const rootFolders = validatedFolders.filter((v) => !strictDescendantSet.has(v.row.id));
  const rootFiles = validatedFiles.filter(
    (v) =>
      v.row.folder_id === null ||
      (!selectedFolderIdSet.has(v.row.folder_id) && !strictDescendantSet.has(v.row.folder_id))
  );

  // Count total subtree folders, files, max relative depth, and logical bytes
  let totalSubtreeFolders = 0;
  let maxRelDepth = 0;
  let totalCopyBytes = rootFiles.reduce((acc, f) => acc + f.row.size_bytes, 0);
  let totalSubtreeFiles = 0;

  const dedupedRootFolderIds = rootFolders.map((r) => r.row.id);
  for (const chunk of chunkArray(dedupedRootFolderIds, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const [folderMetrics, fileMetrics] = await Promise.all([
      db
        .prepare(
          `SELECT COUNT(DISTINCT fc.descendant_id) AS cnt,
                  COALESCE(MAX(fc.depth), 0) AS max_rel_depth
             FROM folder_closures fc
             JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
            WHERE fc.tenant_id = ?
              AND fc.ancestor_id IN (${placeholders})
              AND f.deleted_at IS NULL`
        )
        .bind(user.tenantId, ...chunk)
        .first<{ cnt: number; max_rel_depth: number }>(),
      db
        .prepare(
          `SELECT COUNT(DISTINCT fl.id) AS cnt,
                  COALESCE(SUM(fl.size_bytes), 0) AS total_bytes
             FROM files fl
            WHERE fl.tenant_id = ?
              AND fl.upload_state = 'active'
              AND fl.deleted_at IS NULL
              AND fl.folder_id IN (
                SELECT DISTINCT fc.descendant_id
                  FROM folder_closures fc
                  JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
                 WHERE fc.tenant_id = ?
                   AND fc.ancestor_id IN (${placeholders})
                   AND f.deleted_at IS NULL
              )`
        )
        .bind(user.tenantId, user.tenantId, ...chunk)
        .first<{ cnt: number; total_bytes: number }>(),
    ]);

    totalSubtreeFolders += Number(folderMetrics?.cnt ?? 0);
    maxRelDepth = Math.max(maxRelDepth, Number(folderMetrics?.max_rel_depth ?? 0));
    totalSubtreeFiles += Number(fileMetrics?.cnt ?? 0);
    totalCopyBytes += Number(fileMetrics?.total_bytes ?? 0);
  }

  if (dedupedRootFolderIds.length > 0) {
    const targetRootDepth = dest.parentId === null ? 0 : dest.depth + 1;
    if (targetRootDepth + maxRelDepth > MAX_FOLDER_DEPTH) {
      throw new WorkspaceOpError(
        400,
        'MAX_DEPTH_EXCEEDED',
        `Copy exceeds maximum folder depth (${MAX_FOLDER_DEPTH})`
      );
    }
  }

  const quota = await getTenantQuotaStatus(db, user.tenantId);
  if (quota.usedBytes + totalCopyBytes > quota.quotaBytes) {
    throw new WorkspaceOpError(
      413,
      'QUOTA_EXCEEDED',
      `Tenant storage quota exceeded (remaining ${quota.remainingBytes} bytes)`
    );
  }

  // Allocate destination root names respecting conflictPolicy
  const existingNames = await loadExistingNamesInDestination(db, user.tenantId, dest.parentId);
  const rootFolderTargetNames = new Map<string, string>();
  for (const entry of rootFolders) {
    if (existingNames.folderNames.has(entry.row.name) && conflictPolicy === 'fail') {
      throw new WorkspaceOpError(
        409,
        'NAME_CONFLICT',
        `A folder named "${entry.row.name}" already exists in destination`
      );
    }
    const targetName = allocateCopyName(entry.row.name, 'folder', existingNames.folderNames);
    rootFolderTargetNames.set(entry.row.id, validateFolderName(targetName));
  }

  const rootFileTargetNames = new Map<string, string>();
  for (const entry of rootFiles) {
    if (existingNames.fileNames.has(entry.row.name) && conflictPolicy === 'fail') {
      throw new WorkspaceOpError(
        409,
        'NAME_CONFLICT',
        `An active file named "${entry.row.name}" already exists in destination folder`
      );
    }
    const targetName = allocateCopyName(entry.row.name, 'file', existingNames.fileNames);
    rootFileTargetNames.set(entry.row.id, validateFileNameAndExt(targetName).name);
  }

  const totalNodes = totalSubtreeFolders + rootFiles.length + totalSubtreeFiles;
  const nowIso = new Date().toISOString();

  // Asynchronous Queue fallback for large subtrees (>100 nodes) so Workers 10ms CPU stays bounded
  if (totalNodes > SYNC_COPY_NODE_LIMIT) {
    const jobId = crypto.randomUUID();
    const initialFrontier: CopyFrontierEntry[] = [
      ...rootFolders.map((entry) => ({
        kind: 'folder' as const,
        srcId: entry.row.id,
        destParentId: dest.parentId,
        targetName: rootFolderTargetNames.get(entry.row.id)!,
        depth: dest.parentId === null ? 0 : dest.depth + 1,
      })),
      ...rootFiles.map((entry) => ({
        kind: 'file' as const,
        srcId: entry.row.id,
        destParentId: dest.parentId,
        targetName: rootFileTargetNames.get(entry.row.id)!,
      })),
    ];

    const state: CopyJobState = {
      frontier: initialFrontier,
      destFloor: dest.floorClassification,
      createdFolderIds: [],
      scopeFolderIds: [dest.parentId],
    };

    await db
      .prepare(
        `INSERT INTO workspace_jobs (
           id, tenant_id, job_type, status, total_items, processed_items,
           target_folder_id, created_by, pending_json, created_at, updated_at
         ) VALUES (?, ?, 'copy_subtree', 'queued', ?, 0, ?, ?, ?, ?, ?)`
      )
      .bind(
        jobId,
        user.tenantId,
        totalNodes,
        dest.parentId,
        user.id,
        JSON.stringify(state),
        nowIso,
        nowIso
      )
      .run();

    await queue.send({
      type: 'copy_subtree',
      jobId,
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
    } satisfies CopySubtreeQueueMessage);

    return {
      ok: true,
      queued: true,
      jobId,
      totalItems: totalNodes,
      copiedFolders: [],
      copiedFiles: [],
      syncSeq: null,
      scopeFolderIds: [dest.parentId],
    };
  }

  // Synchronous CoW copy path (<= 100 nodes): snapshot before write so self-copy never loops
  const subtreeFoldersById = new Map<string, FolderRow>();
  const subtreeFilesList: CopyableFileRow[] = [];

  for (const chunk of chunkArray(dedupedRootFolderIds, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const [descFolderRes, descFileRes] = await Promise.all([
      db
        .prepare(
          `SELECT DISTINCT f.*
             FROM folder_closures fc
             JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
            WHERE fc.tenant_id = ?
              AND fc.ancestor_id IN (${placeholders})
              AND f.deleted_at IS NULL
            ORDER BY f.depth ASC, f.name ASC`
        )
        .bind(user.tenantId, ...chunk)
        .all<FolderRow>(),
      db
        .prepare(
          `SELECT DISTINCT fl.*, fv.r2_object_key
             FROM files fl
             JOIN file_versions fv ON fv.id = fl.current_version_id
            WHERE fl.tenant_id = ?
              AND fl.upload_state = 'active'
              AND fl.deleted_at IS NULL
              AND fl.folder_id IN (
                SELECT DISTINCT fc.descendant_id
                  FROM folder_closures fc
                  JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
                 WHERE fc.tenant_id = ?
                   AND fc.ancestor_id IN (${placeholders})
                   AND f.deleted_at IS NULL
              )
            ORDER BY fl.name ASC`
        )
        .bind(user.tenantId, user.tenantId, ...chunk)
        .all<CopyableFileRow>(),
    ]);

    for (const f of descFolderRes.results) {
      subtreeFoldersById.set(f.id, f);
    }
    subtreeFilesList.push(...descFileRes.results);
  }

  // Enforce ascending depth order across all copied folders so parents precede children
  const orderedSubtreeFolders = [...subtreeFoldersById.values()].sort(
    (a, b) => a.depth - b.depth || a.name.localeCompare(b.name)
  );
  const rootFolderOrigSet = new Set(dedupedRootFolderIds);
  const folderIdMap = new Map<string, string>();
  const depthMap = new Map<string, number>();

  for (const orig of orderedSubtreeFolders) {
    folderIdMap.set(orig.id, crypto.randomUUID());
  }

  const stmts: D1PreparedStatement[] = [];
  const createdFolders: FolderRow[] = [];
  const createdFiles: FileRow[] = [];
  const statsDeltas = new Map<ClassificationLabel, { count: number; bytes: number }>();
  const scopeFolders = new Set<string | null>([dest.parentId]);

  for (const orig of orderedSubtreeFolders) {
    const newId = folderIdMap.get(orig.id)!;
    const isRootSelected = rootFolderOrigSet.has(orig.id);
    const destParentId = isRootSelected
      ? dest.parentId
      : folderIdMap.get(orig.parent_id ?? '')!;
    const depth = isRootSelected
      ? dest.parentId === null
        ? 0
        : dest.depth + 1
      : (depthMap.get(orig.parent_id!) ?? 0) + 1;
    depthMap.set(orig.id, depth);

    const targetName = isRootSelected ? rootFolderTargetNames.get(orig.id)! : orig.name;
    scopeFolders.add(destParentId);
    scopeFolders.add(newId);

    appendStatsAndFolderCopyStatements(db, {
      tenantId: user.tenantId,
      actor: user,
      orig,
      newFolderId: newId,
      destParentId,
      targetName,
      depth,
      destFloor: dest.floorClassification,
      nowIso,
      stmts,
      createdFolders,
    });
  }

  // Copy files inside copied folders (deduped) + root selected files
  const seenSubtreeFiles = new Set<string>();
  for (const orig of subtreeFilesList) {
    if (seenSubtreeFiles.has(orig.id)) continue;
    seenSubtreeFiles.add(orig.id);
    const destFolderId = folderIdMap.get(orig.folder_id!)!;
    buildCoWFileCopyStatements(db, {
      tenantId: user.tenantId,
      actor: user,
      orig,
      destFolderId,
      targetName: orig.name,
      destFloor: dest.floorClassification,
      nowIso,
      stmts,
      statsDeltas,
      createdFiles,
    });
  }

  for (const entry of rootFiles) {
    buildCoWFileCopyStatements(db, {
      tenantId: user.tenantId,
      actor: user,
      orig: entry.row,
      destFolderId: dest.parentId,
      targetName: rootFileTargetNames.get(entry.row.id)!,
      destFloor: dest.floorClassification,
      nowIso,
      stmts,
      statsDeltas,
      createdFiles,
    });
  }

  appendStatsDeltasStatements(db, user.tenantId, nowIso, statsDeltas, stmts);

  if (stmts.length > 0) {
    await executeBatchChunks(db, stmts, 30);
  }

  const syncSeq = await resolveLatestSyncSeq(db, user.tenantId);
  return {
    ok: true,
    queued: false,
    totalItems: createdFolders.length + createdFiles.length,
    copiedFolders: createdFolders,
    copiedFiles: createdFiles,
    syncSeq,
    scopeFolderIds: [...scopeFolders],
  };
}

/**
 * Duplicate selected items in-place inside each item's current parent folder (`rename` policy).
 */
export async function duplicateWorkspaceItems(
  db: D1Database,
  queue: Queue,
  user: AuthUser,
  rawItems: unknown
): Promise<CopyWorkspaceResult & { jobIds: string[] }> {
  const items = dedupeBatchItems(rawItems);

  // Resolve current parent ID of every selected item so items can duplicate alongside themselves
  const groups = new Map<string | null, WorkspaceBatchItemInput[]>();
  const resolvedPairs = await Promise.all(
    items.map(async (ref) => {
      if (ref.type === 'folder') {
        const folder = await db
          .prepare('SELECT id, parent_id FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
          .bind(user.tenantId, ref.id)
          .first<{ id: string; parent_id: string | null }>();
        if (!folder) {
          throw new WorkspaceOpError(404, 'NOT_FOUND', `Folder not found: ${ref.id}`);
        }
        return { ref, parentId: folder.parent_id };
      }
      const file = await db
        .prepare(
          `SELECT id, folder_id FROM files
            WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND upload_state = 'active'`
        )
        .bind(user.tenantId, ref.id)
        .first<{ id: string; folder_id: string | null }>();
      if (!file) {
        throw new WorkspaceOpError(404, 'NOT_FOUND', `File not found: ${ref.id}`);
      }
      return { ref, parentId: file.folder_id };
    })
  );

  for (const pair of resolvedPairs) {
    const list = groups.get(pair.parentId) ?? [];
    list.push(pair.ref);
    groups.set(pair.parentId, list);
  }

  const copiedFolders: FolderRow[] = [];
  const copiedFiles: FileRow[] = [];
  const scopeFolderIds = new Set<string | null>();
  const jobIds: string[] = [];
  let queued = false;
  let totalItems = 0;
  let syncSeq: number | null = null;

  for (const [parentId, groupItems] of groups.entries()) {
    const res = await copyWorkspaceItems(db, queue, user, {
      items: groupItems,
      targetParentId: parentId,
      conflictPolicy: 'rename',
    });
    copiedFolders.push(...res.copiedFolders);
    copiedFiles.push(...res.copiedFiles);
    for (const s of res.scopeFolderIds) scopeFolderIds.add(s);
    if (res.queued && res.jobId) {
      queued = true;
      jobIds.push(res.jobId);
    }
    totalItems += res.totalItems;
    if (res.syncSeq !== null) syncSeq = res.syncSeq;
  }

  return {
    ok: true,
    queued,
    ...(jobIds.length > 0 ? { jobId: jobIds[0] } : {}),
    jobIds,
    totalItems,
    copiedFolders,
    copiedFiles,
    syncSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}

/**
 * Process a bounded chunk (`ASYNC_COPY_CHUNK_NODES = 15`) of a queued large subtree copy
 * so each Cloudflare Queue invocation finishes comfortably within Workers 10ms CPU limits.
 */
export async function processCopySubtreeJobChunk(
  msg: CopySubtreeQueueMessage,
  env: OidcEnv
): Promise<void> {
  const job = await env.DB.prepare(
    `SELECT id, tenant_id, status, total_items, processed_items, target_folder_id, pending_json
       FROM workspace_jobs
      WHERE tenant_id = ? AND id = ?`
  )
    .bind(msg.tenantId, msg.jobId)
    .first<{
      id: string;
      tenant_id: string;
      status: string;
      total_items: number;
      processed_items: number;
      target_folder_id: string | null;
      pending_json: string | null;
    }>();

  if (!job || job.status === 'completed' || job.status === 'failed' || !job.pending_json) {
    return;
  }

  const state = JSON.parse(job.pending_json) as CopyJobState;
  const createdSet = new Set(state.createdFolderIds);
  const scopeSet = new Set<string | null>(state.scopeFolderIds);
  const nowIso = new Date().toISOString();
  const actor = { id: msg.actorId, email: msg.actorEmail, ipAddress: msg.actorIp };

  const stmts: D1PreparedStatement[] = [];
  const createdFolders: FolderRow[] = [];
  const createdFiles: FileRow[] = [];
  const statsDeltas = new Map<ClassificationLabel, { count: number; bytes: number }>();

  let processedInTurn = 0;
  const frontier = [...state.frontier];

  try {
    while (frontier.length > 0 && processedInTurn < ASYNC_COPY_CHUNK_NODES) {
      const next = frontier.shift()!;
      processedInTurn += 1;

      if (next.kind === 'folder') {
        const orig = await env.DB.prepare(
          'SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
        )
          .bind(msg.tenantId, next.srcId)
          .first<FolderRow>();
        if (!orig) continue;

        const newFolderId = crypto.randomUUID();
        createdSet.add(newFolderId);
        scopeSet.add(next.destParentId);
        scopeSet.add(newFolderId);

        appendStatsAndFolderCopyStatements(env.DB, {
          tenantId: msg.tenantId,
          actor,
          orig,
          newFolderId,
          destParentId: next.destParentId,
          targetName: next.targetName,
          depth: next.depth ?? 0,
          destFloor: state.destFloor,
          nowIso,
          stmts,
          createdFolders,
        });

        const [childFolders, childFiles] = await Promise.all([
          env.DB.prepare(
            `SELECT id, name FROM folders
              WHERE tenant_id = ? AND parent_id = ? AND deleted_at IS NULL
              ORDER BY name ASC`
          )
            .bind(msg.tenantId, orig.id)
            .all<{ id: string; name: string }>(),
          env.DB.prepare(
            `SELECT id, name FROM files
              WHERE tenant_id = ? AND folder_id = ? AND deleted_at IS NULL AND upload_state = 'active'
              ORDER BY name ASC`
          )
            .bind(msg.tenantId, orig.id)
            .all<{ id: string; name: string }>(),
        ]);

        for (const cf of childFolders.results) {
          if (createdSet.has(cf.id)) continue; // Avoid re-traversing newly created self-copy branch
          frontier.push({
            kind: 'folder',
            srcId: cf.id,
            destParentId: newFolderId,
            targetName: cf.name,
            depth: (next.depth ?? 0) + 1,
          });
        }
        for (const fl of childFiles.results) {
          frontier.push({
            kind: 'file',
            srcId: fl.id,
            destParentId: newFolderId,
            targetName: fl.name,
          });
        }
      } else {
        const orig = await env.DB.prepare(
          `SELECT fl.*, fv.r2_object_key
             FROM files fl
             JOIN file_versions fv ON fv.id = fl.current_version_id
            WHERE fl.tenant_id = ? AND fl.id = ? AND fl.deleted_at IS NULL AND fl.upload_state = 'active'`
        )
          .bind(msg.tenantId, next.srcId)
          .first<CopyableFileRow>();
        if (!orig) continue;

        scopeSet.add(next.destParentId);
        buildCoWFileCopyStatements(env.DB, {
          tenantId: msg.tenantId,
          actor,
          orig,
          destFolderId: next.destParentId,
          targetName: next.targetName,
          destFloor: state.destFloor,
          nowIso,
          stmts,
          statsDeltas,
          createdFiles,
        });
      }
    }

    appendStatsDeltasStatements(env.DB, msg.tenantId, nowIso, statsDeltas, stmts);

    const hasMore = frontier.length > 0;
    const nextProcessed = job.processed_items + processedInTurn;
    const nextState: CopyJobState = {
      frontier,
      destFloor: state.destFloor,
      createdFolderIds: [...createdSet],
      scopeFolderIds: [...scopeSet],
    };

    stmts.push(
      env.DB.prepare(
        `UPDATE workspace_jobs
            SET status = ?, processed_items = ?, pending_json = ?,
                result_json = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ?`
      ).bind(
        hasMore ? 'running' : 'completed',
        nextProcessed,
        hasMore ? JSON.stringify(nextState) : null,
        hasMore
          ? null
          : JSON.stringify({
              completedAt: nowIso,
              processedItems: nextProcessed,
              scopeFolderIds: [...scopeSet],
            }),
        nowIso,
        msg.tenantId,
        msg.jobId
      )
    );

    await executeBatchChunks(env.DB, stmts, 30);

    if (hasMore) {
      await env.JOBS_QUEUE.send(msg);
    } else {
      const syncSeq = await resolveLatestSyncSeq(env.DB, msg.tenantId);
      await notifyTenantSyncHub(env, {
        tenantId: msg.tenantId,
        seq: syncSeq,
        eventKind: 'workspace.copy',
        scopeFolderIds: [...scopeSet],
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Async subtree copy failed';
    await env.DB.prepare(
      `UPDATE workspace_jobs
          SET status = 'failed', error_message = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    )
      .bind(message.slice(0, 500), new Date().toISOString(), msg.tenantId, msg.jobId)
      .run();
    throw err;
  }
}

export async function getWorkspaceJobStatus(
  db: D1Database,
  tenantId: string,
  jobId: string
): Promise<{
  id: string;
  jobType: string;
  status: string;
  totalItems: number;
  processedItems: number;
  targetFolderId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
} | null> {
  const row = await db
    .prepare(
      `SELECT id, job_type, status, total_items, processed_items, target_folder_id,
              error_message, created_at, updated_at
         FROM workspace_jobs
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, jobId)
    .first<{
      id: string;
      job_type: string;
      status: string;
      total_items: number;
      processed_items: number;
      target_folder_id: string | null;
      error_message: string | null;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    jobType: row.job_type,
    status: row.status,
    totalItems: row.total_items,
    processedItems: row.processed_items,
    targetFolderId: row.target_folder_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
