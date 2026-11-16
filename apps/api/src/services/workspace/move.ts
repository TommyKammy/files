import type { AuthUser } from '../../types/api';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import { type FileRow, validateFileNameAndExt } from '../file-upload-common';
import { type FolderRow, MAX_FOLDER_DEPTH, moveFolderSubtree } from '../folder-closure-service';
import { moveFilesToDestination } from './move-files';
import {
  BatchMoveResult,
  WorkspaceConflictPolicy,
  WorkspaceOpError,
  allocateCopyName,
  dedupeBatchItems,
  findSelectedDescendantFolderSet,
  loadExistingNamesInDestination,
  resolveDestinationContext,
  resolveLatestSyncSeq,
  wrapServiceError,
} from './shared';

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
  const movedFiles = await moveFilesToDestination({
    db,
    user,
    dest,
    filesToMove,
    nowIso,
    scopeFolders,
  });

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
