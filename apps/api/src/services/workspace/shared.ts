import type { AuthUser, ClassificationLabel } from '../../types/api';
import type { CopySubtreeQueueMessage } from '../../types/classification';
import { chunkArray, executeBatchChunks } from '../../utils/batch';
import { pickStricterClassification } from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import {
  buildClassificationPolicyStatements,
  resolveFolderClassificationFloor,
} from '../classification-updater';
import {
  type FileRow,
  FileUploadError,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from '../file-upload-common';
import {
  type FolderRow,
  FolderServiceError,
  MAX_FOLDER_DEPTH,
  moveFolderSubtree,
  validateFolderName,
} from '../folder-closure-service';
import { buildSyncChangeStmt, getSyncWatermarks } from '../sync-changes';
import { notifyTenantSyncHub } from '../sync-notifier';
import type { OidcEnv } from '../../types/oidc';

export const MAX_WORKSPACE_BATCH_ITEMS = 50;
export const SYNC_COPY_NODE_LIMIT = 100;
export const ASYNC_COPY_CHUNK_NODES = 15;
export const MAX_COPY_RENAME_ATTEMPTS = 100;

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

export interface DestinationContext {
  parentId: string | null;
  folder: FolderRow | null;
  depth: number;
  floorClassification: ClassificationLabel;
}

export interface CopyableFileRow extends FileRow {
  r2_object_key: string;
}

export interface CopyFrontierEntry {
  kind: 'folder' | 'file';
  srcId: string;
  destParentId: string | null;
  targetName: string;
  depth?: number;
}

export interface CopyJobState {
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

export function dedupeBatchItems(rawItems: unknown): WorkspaceBatchItemInput[] {
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

export async function resolveDestinationContext(
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

export async function loadExistingNamesInDestination(
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

export async function findSelectedDescendantFolderSet(
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

export function wrapServiceError(err: unknown): never {
  if (err instanceof FolderServiceError || err instanceof FileUploadError) {
    const latest = err instanceof FolderServiceError ? err.latest : undefined;
    throw new WorkspaceOpError(err.status, err.code, err.message, latest);
  }
  throw err;
}

export async function resolveLatestSyncSeq(db: D1Database, tenantId: string): Promise<number | null> {
  const watermarks = await getSyncWatermarks(db, tenantId);
  return watermarks.currentSeq > 0 ? watermarks.currentSeq : null;
}

/**
 * Batch move multiple folders and files to `targetParentId` with upfront RBAC,
 * closure cycle/depth verification, confidential upward inheritance, and chunked D1 updates.
 */

export function buildCoWFileCopyStatements(
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

export function appendStatsAndFolderCopyStatements(
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

export function appendStatsDeltasStatements(
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
