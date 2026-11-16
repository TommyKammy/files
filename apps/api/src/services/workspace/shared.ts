import type { AuthUser, ClassificationLabel } from '../../types/api';
import { chunkArray } from '../../utils/batch';
import { resolveTargetAccess } from '../authorization';
import { can } from '../capabilities';
import { resolveFolderClassificationFloor } from '../classification-updater';
import { type FileRow, FileUploadError } from '../file-upload-common';
import { type FolderRow, FolderServiceError } from '../folder-closure-service';
import { getSyncWatermarks } from '../sync-changes';

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
  if (
    !can(destAccess.capabilities, 'folder.create') ||
    !can(destAccess.capabilities, 'item.upload_new')
  ) {
    throw new WorkspaceOpError(
      403,
      'FORBIDDEN',
      'Write permission required on destination folder'
    );
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

/**
 * Copy files and folder subtrees to `targetParentId` using Zero-Copy R2 (CoW).
 * Enforces `viewer`+ DLP check on all sources and offloads >100-node subtrees to `JOBS_QUEUE`.
 */
