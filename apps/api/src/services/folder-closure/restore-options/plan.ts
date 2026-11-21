import type { AuthUser, ClassificationLabel } from '../../../types/api';
import { pickStricterClassification } from '../../../utils/classification';
import { hasAtLeastRole, resolveTargetAccess } from '../../authorization';
import { can } from '../../capabilities';
import {
  canCreateAtRoot,
  getFolderStructureMode,
  ROOT_CREATION_ADMIN_ONLY_MESSAGE,
} from '../../folder-structure';
import {
  buildRestoreDestinationContext,
  classificationStrictnessBelow,
  folderSubtreeMaxDepth,
  isFolderWithinSubtree,
  isPrivilegedAdmin,
  loadDeletedAncestorChain,
  resolveAncestorRestoreName,
  type AdminRestoreDelegation,
  type RestoreDestinationContext,
} from '../../trash-restore-context';
import {
  FolderRow,
  FolderServiceError,
  MAX_FOLDER_DEPTH,
  hasDuplicateFolderName,
  resolveUniqueRestoredName,
} from '../shared';
import type { FolderRestoreOptions } from './types';

export interface AncestorRestorePlan {
  folder: FolderRow;
  name: string;
  renamed: boolean;
  newVersion: number;
}

export interface FolderRestorePlan {
  folder: FolderRow;
  conflictPolicy: 'fail' | 'rename';
  adminDelegation: AdminRestoreDelegation | undefined;
  adminBypass: boolean;
  isMoving: boolean;
  targetParentId: string | null;
  targetParent: FolderRow | null;
  destination: RestoreDestinationContext;
  restoredChain: AncestorRestorePlan[];
  nextName: string;
  floor: ClassificationLabel;
  nextRootClassification: ClassificationLabel;
  newRootDepth: number;
  depthDelta: number;
  batchDeletedAt: string;
  strictLabels: ClassificationLabel[];
  subtreeFolderRows: Array<{ id: string; classification: ClassificationLabel }>;
  promotedFileRows: Array<{
    id: string;
    classification: ClassificationLabel;
    size_bytes: number;
  }>;
  restoredFileCount: number;
}

function restoreError(
  status: 400 | 403 | 404 | 409,
  code: string,
  message: string,
  details?: Record<string, unknown>
): never {
  throw new FolderServiceError(status, code, message, undefined, details);
}

async function planAncestorChain(
  db: D1Database,
  user: AuthUser,
  parentId: string,
  destination: RestoreDestinationContext,
  sourceRole: Parameters<typeof hasAtLeastRole>[0],
  conflictPolicy: 'fail' | 'rename',
  adminBypass = false
): Promise<AncestorRestorePlan[]> {
  const chain = await loadDeletedAncestorChain(db, user.tenantId, parentId);
  const plans: AncestorRestorePlan[] = [];

  for (const ancestor of chain) {
    const access = await resolveTargetAccess(db, user, 'folder', ancestor.id);
    if (
      !adminBypass &&
      (!access ||
        access.deletedAt === null ||
        !can(access.capabilities, 'trash.restore'))
    ) {
      throw new FolderServiceError(
        403,
        'FORBIDDEN',
        'Trash restore permission required on every deleted ancestor folder',
        undefined,
        {
          destination,
          failedAncestorId: ancestor.id,
          failedAncestorName: ancestor.name,
          restoreParentChainRequired: true,
          sourceRole,
        }
      );
    }

    const suggestedName = await resolveAncestorRestoreName(
      db,
      user.tenantId,
      ancestor.parent_id,
      ancestor.name,
      ancestor.id
    );
    if (suggestedName !== null && conflictPolicy !== 'rename') {
      // Callers that asked for 'fail' must see a recoverable 409 before
      // anything is written; 'rename' picks the unique suggestion below.
      throw new FolderServiceError(
        409,
        'NAME_CONFLICT',
        `An active folder named "${ancestor.name}" already exists at the ancestor destination`,
        undefined,
        {
          destination,
          failedAncestorId: ancestor.id,
          failedAncestorName: ancestor.name,
          suggestedName,
          restoreParentChainRequired: true,
        }
      );
    }

    plans.push({
      folder: ancestor,
      name: suggestedName ?? ancestor.name,
      renamed: suggestedName !== null,
      newVersion: ancestor.version + 1,
    });
  }

  return plans;
}

export async function validateAndPlanFolderRestore(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  options: FolderRestoreOptions
): Promise<FolderRestorePlan> {
  const conflictPolicy = options.conflictPolicy ?? 'fail';
  const adminDelegation = options.adminDelegation;
  const adminBypass = Boolean(adminDelegation?.onBehalfOfUserId);
  if (adminDelegation && (!isPrivilegedAdmin(user) || !adminBypass)) {
    throw new FolderServiceError(403, 'FORBIDDEN', 'Forbidden');
  }

  const sourceAccess = await resolveTargetAccess(db, user, 'folder', folderId);
  const folder = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!folder || (!sourceAccess && !adminBypass)) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (folder.deleted_at === null) {
    throw new FolderServiceError(400, 'NOT_IN_TRASH', 'Folder is not in Trash');
  }
  if (!adminBypass && !can(sourceAccess?.capabilities, 'trash.restore')) {
    throw new FolderServiceError(
      403,
      'FORBIDDEN',
      'Trash restore permission required to restore folder'
    );
  }

  const requestedTarget =
    options.targetParentId !== undefined ? options.targetParentId : folder.parent_id;
  const isMoving = requestedTarget !== folder.parent_id;
  const restoreParentChain = options.restoreParentChain === true;

  if (requestedTarget === null) {
    const mode = await getFolderStructureMode(db, user.tenantId);
    if (!canCreateAtRoot(mode, user)) {
      restoreError(
        403,
        'ROOT_CREATION_ADMIN_ONLY',
        ROOT_CREATION_ADMIN_ONLY_MESSAGE
      );
    }
  }

  const originalDestination = await buildRestoreDestinationContext(
    db,
    user,
    folder.parent_id,
    { bypassAccess: adminBypass }
  );
  const destination = isMoving
    ? await buildRestoreDestinationContext(db, user, requestedTarget, {
        bypassAccess: adminBypass,
      })
    : originalDestination;
  if (!destination) {
    restoreError(404, 'TARGET_NOT_FOUND', 'Destination folder not found');
  }

  const targetParentId = requestedTarget;
  let targetParent: FolderRow | null = null;
  let restoredChain: AncestorRestorePlan[] = [];

  if (targetParentId !== null) {
    targetParent = await db
      .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, targetParentId)
      .first<FolderRow>();
    if (!targetParent) {
      restoreError(404, 'TARGET_NOT_FOUND', 'Destination folder not found', {
        destination,
      });
    }
    if (
      isMoving &&
      (await isFolderWithinSubtree(db, user.tenantId, folderId, targetParentId))
    ) {
      restoreError(
        400,
        'CIRCULAR_RESTORE',
        'Cannot restore a folder into itself or one of its descendants',
        { destination }
      );
    }
    if (targetParent.deleted_at !== null) {
      const chainCoversTarget =
        !isMoving && restoreParentChain && targetParentId === folder.parent_id;
      if (!chainCoversTarget) {
        restoreError(
          409,
          'PARENT_IN_TRASH',
          'Destination folder is deleted; restore the parent folder first',
          { destination }
        );
      }
    }
  }

  // Moving a folder to the workspace root keeps the existing move rule.
  if (
    !adminBypass &&
    isMoving &&
    targetParentId === null &&
    folder.parent_id !== null
  ) {
    if (!hasAtLeastRole(sourceAccess?.effectiveRole, 'owner')) {
      restoreError(
        403,
        'FORBIDDEN',
        'Owner permission required to promote a folder to workspace root',
        { destination }
      );
    }
  }

  if (isMoving) {
    if (targetParentId !== null) {
      const destAccess = await resolveTargetAccess(
        db,
        user,
        'folder',
        targetParentId
      );
      if (!destAccess || destAccess.deletedAt !== null) {
        restoreError(409, 'PARENT_IN_TRASH', 'Destination folder is deleted', {
          destination,
        });
      }
      if (!can(destAccess.capabilities, 'folder.create') && !adminBypass) {
        restoreError(
          403,
          'FORBIDDEN',
          'Folder creation permission required on destination folder',
          { destination }
        );
      }

      const subtreeDepth = await folderSubtreeMaxDepth(
        db,
        user.tenantId,
        folderId
      );
      const newRootDepth = targetParent!.depth + 1;
      if (newRootDepth + subtreeDepth > MAX_FOLDER_DEPTH) {
        restoreError(
          400,
          'MAX_DEPTH_EXCEEDED',
          `Restore would exceed maximum depth of ${MAX_FOLDER_DEPTH}`,
          { destination }
        );
      }
    } else {
      const subtreeDepth = await folderSubtreeMaxDepth(
        db,
        user.tenantId,
        folderId
      );
      if (subtreeDepth > MAX_FOLDER_DEPTH) {
        restoreError(
          400,
          'MAX_DEPTH_EXCEEDED',
          `Restore would exceed maximum depth of ${MAX_FOLDER_DEPTH}`,
          { destination }
        );
      }
    }
  }

  if (!isMoving && folder.parent_id !== null) {
    if (restoreParentChain) {
      restoredChain = await planAncestorChain(
        db,
        user,
        folder.parent_id,
        destination,
        sourceAccess?.effectiveRole ?? 'owner',
        conflictPolicy,
        adminBypass
      );
    } else if (destination.isDeleted) {
      restoreError(
        409,
        'PARENT_IN_TRASH',
        'Parent folder must be restored before restoring this folder',
        { destination }
      );
    }
  }

  // Target-folder name collision. Rename is never overwrite.
  let nextName = folder.name;
  let suggestedName: string | null = null;
  if (
    await hasDuplicateFolderName(
      db,
      user.tenantId,
      targetParentId,
      folder.name,
      folder.id
    )
  ) {
    suggestedName = await resolveUniqueRestoredName(
      db,
      user.tenantId,
      targetParentId,
      folder.name
    );
    if (conflictPolicy !== 'rename') {
      restoreError(
        409,
        'NAME_CONFLICT',
        `An active folder named "${folder.name}" already exists in this location`,
        { destination, suggestedName }
      );
    }
    nextName = suggestedName;
  }

  const floor = destination.classification;
  const nextRootClassification = pickStricterClassification(
    folder.classification,
    floor
  );
  const newRootDepth = targetParent ? targetParent.depth + 1 : 0;
  const depthDelta = isMoving ? newRootDepth - folder.depth : 0;
  const batchDeletedAt = folder.deleted_at;

  const subtreeFolderRows = await db
    .prepare(
      `SELECT id, classification
         FROM folders
        WHERE tenant_id = ?
          AND deleted_at = ?
          AND id IN (
            SELECT descendant_id
              FROM folder_closures
             WHERE tenant_id = ? AND ancestor_id = ?
          )`
    )
    .bind(user.tenantId, batchDeletedAt, user.tenantId, folderId)
    .all<{ id: string; classification: ClassificationLabel }>();

  const strictLabels = classificationStrictnessBelow(floor);
  const placeholders =
    strictLabels.length > 0 ? strictLabels.map(() => '?').join(', ') : null;

  const promotedFileRows = placeholders
    ? await db
        .prepare(
          `SELECT id, classification, size_bytes
             FROM files
            WHERE tenant_id = ?
              AND upload_state = 'active'
              AND (deleted_at = ? OR deleted_at IS NULL)
              AND folder_id IN (
                SELECT descendant_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND ancestor_id = ?
              )
              AND classification IN (${placeholders})`
        )
        .bind(
          user.tenantId,
          batchDeletedAt,
          user.tenantId,
          folderId,
          ...strictLabels
        )
        .all<{
          id: string;
          classification: ClassificationLabel;
          size_bytes: number;
        }>()
    : null;

  const restoredFileCountRow = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
         FROM files
        WHERE tenant_id = ?
          AND upload_state = 'active'
          AND deleted_at = ?
          AND folder_id IN (
            SELECT descendant_id
              FROM folder_closures
             WHERE tenant_id = ? AND ancestor_id = ?
          )`
    )
    .bind(user.tenantId, batchDeletedAt, user.tenantId, folderId)
    .first<{ cnt: number }>();

  return {
    folder,
    conflictPolicy,
    adminDelegation,
    adminBypass,
    isMoving,
    targetParentId,
    targetParent,
    destination,
    restoredChain,
    nextName,
    floor,
    nextRootClassification,
    newRootDepth,
    depthDelta,
    batchDeletedAt,
    strictLabels,
    subtreeFolderRows: subtreeFolderRows.results,
    promotedFileRows: promotedFileRows?.results ?? [],
    restoredFileCount: restoredFileCountRow?.cnt ?? 0,
  };
}
