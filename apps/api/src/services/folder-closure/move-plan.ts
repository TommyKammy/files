import type { AuthUser } from '../../types/api';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import {
  type FolderRow,
  FolderServiceError,
  MAX_FOLDER_DEPTH,
  hasDuplicateFolderName,
  validateFolderName,
} from './shared';

export type MovePlan =
  | { noOp: true; source: FolderRow }
  | {
      noOp: false;
      source: FolderRow;
      targetParent: FolderRow | null;
      targetParentId: string | null;
      resolvedName: string;
      newRootDepth: number;
      depthDelta: number;
    };

export async function resolveMovePlan(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  input: {
    targetParentId: string | null;
    expectedVersion?: number;
    targetName?: string;
  }
): Promise<MovePlan> {
  const sourceAccess = await resolveTargetAccess(db, user, 'folder', folderId);
  if (!sourceAccess || sourceAccess.deletedAt !== null) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (!hasAtLeastRole(sourceAccess.effectiveRole, 'editor')) {
    throw new FolderServiceError(403, 'FORBIDDEN', 'Editor permission required to move folder');
  }

  const source = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!source) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }

  if (input.expectedVersion !== undefined && source.version !== input.expectedVersion) {
    throw new FolderServiceError(
      409,
      'VERSION_CONFLICT',
      `Folder version mismatch (expected ${input.expectedVersion}, actual ${source.version})`,
      source
    );
  }

  const targetParentId = input.targetParentId;
  if (targetParentId === folderId) {
    throw new FolderServiceError(400, 'CYCLE_DETECTED', 'Cannot move a folder into itself');
  }

  let targetParent: FolderRow | null = null;
  if (targetParentId !== null) {
    const destAccess = await resolveTargetAccess(db, user, 'folder', targetParentId);
    if (!destAccess || destAccess.deletedAt !== null) {
      throw new FolderServiceError(404, 'TARGET_NOT_FOUND', 'Destination folder not found');
    }
    if (!hasAtLeastRole(destAccess.effectiveRole, 'editor')) {
      throw new FolderServiceError(
        403,
        'FORBIDDEN',
        'Editor permission required on destination folder'
      );
    }

    targetParent = await db
      .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
      .bind(user.tenantId, targetParentId)
      .first<FolderRow>();
    if (!targetParent) {
      throw new FolderServiceError(404, 'TARGET_NOT_FOUND', 'Destination folder not found');
    }

    // O(1) Cycle check via Closure Table primary key
    const cycleRow = await db
      .prepare(
        `SELECT 1 AS hit
           FROM folder_closures
          WHERE tenant_id = ? AND ancestor_id = ? AND descendant_id = ?
          LIMIT 1`
      )
      .bind(user.tenantId, folderId, targetParentId)
      .first<{ hit: number }>();
    if (cycleRow) {
      throw new FolderServiceError(
        400,
        'CYCLE_DETECTED',
        'Cannot move a folder into one of its descendants'
      );
    }
  } else if (source.parent_id !== null && !hasAtLeastRole(sourceAccess.effectiveRole, 'owner')) {
    throw new FolderServiceError(
      403,
      'FORBIDDEN',
      'Owner permission required to promote a folder to workspace root'
    );
  }

  // Max depth <= 20 check
  const maxSubDepthRow = await db
    .prepare(
      `SELECT COALESCE(MAX(depth), 0) AS max_sub_depth
         FROM folder_closures
        WHERE tenant_id = ? AND ancestor_id = ?`
    )
    .bind(user.tenantId, folderId)
    .first<{ max_sub_depth: number }>();
  const maxSubDepth = maxSubDepthRow?.max_sub_depth ?? 0;
  const newRootDepth = targetParent ? targetParent.depth + 1 : 0;

  if (newRootDepth + maxSubDepth > MAX_FOLDER_DEPTH) {
    throw new FolderServiceError(
      400,
      'MAX_DEPTH_EXCEEDED',
      `Move would exceed maximum depth of ${MAX_FOLDER_DEPTH}`
    );
  }

  const resolvedName =
    input.targetName !== undefined ? validateFolderName(input.targetName) : source.name;

  if (await hasDuplicateFolderName(db, user.tenantId, targetParentId, resolvedName, source.id)) {
    throw new FolderServiceError(
      409,
      'NAME_CONFLICT',
      `A folder named "${resolvedName}" already exists at the destination`
    );
  }

  // No-op move check when parent unchanged
  if (source.parent_id === targetParentId) {
    return { noOp: true, source };
  }

  return {
    noOp: false,
    source,
    targetParent,
    targetParentId,
    resolvedName,
    newRootDepth,
    depthDelta: newRootDepth - source.depth,
  };
}
