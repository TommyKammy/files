import type { AuthUser, ClassificationLabel } from '../../types/api';
import {
  CLASSIFICATION_STRICTNESS,
  isClassificationStricter,
  pickStricterClassification,
} from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import {
  hasAtLeastRole,
  resolveTargetAccess,
} from '../authorization';
import { buildClassificationPolicyStatements } from '../classification-updater';
import { buildSyncChangeStmt } from '../sync-changes';
import { extractLastSyncSeq } from '../sync-notifier';
import {
  buildRestoreDestinationContext,
  classificationStrictnessBelow,
  folderSubtreeMaxDepth,
  isFolderWithinSubtree,
  loadDeletedAncestorChain,
  resolveAncestorRestoreName,
  type RestoreDestinationContext,
} from '../trash-restore-context';
import {
  FolderRow,
  FolderServiceError,
  MAX_FOLDER_DEPTH,
  hasDuplicateFolderName,
  resolveUniqueRestoredName,
} from './shared';

export interface FolderRestoreOptions {
  conflictPolicy?: 'fail' | 'rename';
  /**
   * `undefined` keeps the folder's original parent. `null` explicitly restores
   * into the workspace root. A different id performs a subtree move.
   */
  targetParentId?: string | null;
  /** Restore deleted ancestors (row-only) before restoring this folder. */
  restoreParentChain?: boolean;
}

export interface RestoreFolderWithOptionsResult {
  folder: FolderRow;
  restoredAt: string;
  syncSeq: number | null;
  destination: RestoreDestinationContext;
  restoredAncestorIds: string[];
  affectedFolderIds: Array<string | null>;
  scopeFolderIds: Array<string | null>;
}

interface AncestorRestorePlan {
  folder: FolderRow;
  name: string;
  renamed: boolean;
  newVersion: number;
}

function restoreError(
  status: 400 | 403 | 404 | 409,
  code: string,
  message: string,
  details?: Record<string, unknown>
): never {
  throw new FolderServiceError(status, code, message, undefined, details);
}

/**
 * Restore a soft-deleted folder into its original parent or a chosen active
 * destination, atomically with an optional deleted-ancestor chain.
 *
 * The whole operation is planned (permissions, cycle check, depth, names,
 * classification floor) before a single D1 `batch()` runs. D1 batches are
 * transactional, so a unique-index race or unexpected statement failure rolls
 * every ancestor back as well.
 */
export async function restoreFolderWithOptions(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  options: FolderRestoreOptions = {}
): Promise<RestoreFolderWithOptionsResult> {
  const conflictPolicy = options.conflictPolicy ?? 'fail';
  const sourceAccess = await resolveTargetAccess(db, user, 'folder', folderId);
  if (!sourceAccess) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (sourceAccess.deletedAt === null) {
    throw new FolderServiceError(400, 'NOT_IN_TRASH', 'Folder is not in Trash');
  }
  if (!hasAtLeastRole(sourceAccess.effectiveRole, 'editor')) {
    throw new FolderServiceError(
      403,
      'FORBIDDEN',
      'Editor permission required to restore folder'
    );
  }

  const folder = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!folder || !folder.deleted_at) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }

  const requestedTarget =
    options.targetParentId !== undefined ? options.targetParentId : folder.parent_id;
  const isMoving = requestedTarget !== folder.parent_id;
  const restoreParentChain = options.restoreParentChain === true;

  const originalDestination = await buildRestoreDestinationContext(
    db,
    user,
    folder.parent_id
  );
  const destination = isMoving
    ? await buildRestoreDestinationContext(db, user, requestedTarget)
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
  if (isMoving && targetParentId === null && folder.parent_id !== null) {
    if (!hasAtLeastRole(sourceAccess.effectiveRole, 'owner')) {
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
      if (!hasAtLeastRole(destAccess.effectiveRole, 'editor')) {
        restoreError(
          403,
          'FORBIDDEN',
          'Editor permission required on destination folder',
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
        sourceAccess.effectiveRole,
        conflictPolicy
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

  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  // 1. Restore deleted ancestor rows only (never their unrelated siblings).
  for (const plan of restoredChain) {
    statements.push(
      db
        .prepare(
          `UPDATE folders
              SET deleted_at = NULL,
                  deleted_by = NULL,
                  name = ?,
                  version = version + 1,
                  updated_at = ?
            WHERE tenant_id = ? AND id = ? AND deleted_at IS NOT NULL`
        )
        .bind(plan.name, nowIso, user.tenantId, plan.folder.id),
      buildAuditLogStmt(db, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'folder.restore',
        targetType: 'folder',
        targetId: plan.folder.id,
        classificationSnapshot: plan.folder.classification,
        metadata: {
          restoredBatchDeletedAt: plan.folder.deleted_at,
          restoredFor: 'folder',
          restoredTargetId: folderId,
          reason: 'parent_chain',
          renamedTo: plan.renamed ? plan.name : null,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId: user.tenantId,
        entityType: 'folder',
        entityId: plan.folder.id,
        folderId: plan.folder.parent_id,
        action: 'folder.restore',
        payload: {
          folder: {
            ...plan.folder,
            name: plan.name,
            deleted_at: null,
            deleted_by: null,
            version: plan.newVersion,
            updated_at: nowIso,
          },
          reason: 'parent_chain',
          restoredTargetId: folderId,
        },
        nowIso,
      })
    );
  }

  // 2. Re-root the subtree when restoring into another parent.
  if (isMoving && folder.parent_id !== null) {
    statements.push(
      db
        .prepare(
          `DELETE FROM folder_closures
            WHERE tenant_id = ?
              AND descendant_id IN (
                SELECT descendant_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND ancestor_id = ?
              )
              AND ancestor_id IN (
                SELECT ancestor_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND descendant_id = ? AND ancestor_id != ?
              )`
        )
        .bind(user.tenantId, user.tenantId, folderId, user.tenantId, folderId, folderId)
    );
  }
  if (isMoving && targetParent) {
    statements.push(
      db
        .prepare(
          `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
           SELECT ?, anc.ancestor_id, sub.descendant_id, anc.depth + 1 + sub.depth
             FROM folder_closures anc
             CROSS JOIN folder_closures sub
            WHERE anc.tenant_id = ? AND anc.descendant_id = ?
              AND sub.tenant_id = ? AND sub.ancestor_id = ?`
        )
        .bind(
          user.tenantId,
          user.tenantId,
          targetParent.id,
          user.tenantId,
          folderId
        )
    );
  }

  // 3. Restore the folder subtree root.
  statements.push(
    db
      .prepare(
        `UPDATE folders
            SET parent_id = ?,
                name = ?,
                depth = ?,
                classification = ?,
                deleted_at = NULL,
                deleted_by = NULL,
                version = version + 1,
                updated_at = ?
          WHERE tenant_id = ? AND id = ? AND deleted_at IS NOT NULL`
      )
      .bind(
        targetParentId,
        nextName,
        newRootDepth,
        nextRootClassification,
        nowIso,
        user.tenantId,
        folderId
      )
  );

  // 4. Shift depths for every descendant (active or still deleted) of a moved subtree.
  if (isMoving && depthDelta !== 0) {
    statements.push(
      db
        .prepare(
          `UPDATE folders
              SET depth = depth + ?,
                  version = version + 1,
                  updated_at = ?
            WHERE tenant_id = ?
              AND id != ?
              AND id IN (
                SELECT descendant_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND ancestor_id = ?
              )`
        )
        .bind(depthDelta, nowIso, user.tenantId, folderId, user.tenantId, folderId)
    );
  }

  // 5. Restore only descendants from the same deletion batch. The version bump
  //    is skipped when the depth statement above already bumped it.
  statements.push(
    db
      .prepare(
        `UPDATE folders
            SET deleted_at = NULL,
                deleted_by = NULL,
                version = version + ?,
                updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at = ?
            AND id != ?
            AND id IN (
              SELECT descendant_id
                FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(
        isMoving && depthDelta !== 0 ? 0 : 1,
        nowIso,
        user.tenantId,
        batchDeletedAt,
        folderId,
        user.tenantId,
        folderId
      )
  );

  // 6. Elevate all now-active descendants to the destination floor.
  if (placeholders) {
    statements.push(
      db
        .prepare(
          `UPDATE folders
              SET classification = ?,
                  updated_at = ?
            WHERE tenant_id = ?
              AND id != ?
              AND deleted_at IS NULL
              AND id IN (
                SELECT descendant_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND ancestor_id = ?
              )
              AND classification IN (${placeholders})`
        )
        .bind(
          floor,
          nowIso,
          user.tenantId,
          folderId,
          user.tenantId,
          folderId,
          ...strictLabels
        )
    );
  }

  // 7. Rebuild FTS for every file that is active after the restore.
  const activeFileSubtreeSql = `folder_id IN (
    SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
  )`;
  statements.push(
    db
      .prepare(
        `DELETE FROM files_fts
          WHERE file_id IN (
            SELECT id FROM files
             WHERE tenant_id = ?
               AND upload_state = 'active'
               AND (deleted_at IS NULL OR deleted_at = ?)
               AND ${activeFileSubtreeSql}
          )`
      )
      .bind(user.tenantId, batchDeletedAt, user.tenantId, folderId)
  );

  // 8. Restore same-batch files and promote them in the same UPDATE.
  if (placeholders) {
    statements.push(
      db
        .prepare(
          `UPDATE files
              SET deleted_at = NULL,
                  deleted_by = NULL,
                  classification = CASE WHEN classification IN (${placeholders}) THEN ? ELSE classification END,
                  classification_updated_by = CASE WHEN classification IN (${placeholders}) THEN ? ELSE classification_updated_by END,
                  classification_updated_at = CASE WHEN classification IN (${placeholders}) THEN ? ELSE classification_updated_at END,
                  meta_version = meta_version + 1,
                  updated_at = ?
            WHERE tenant_id = ?
              AND upload_state = 'active'
              AND deleted_at = ?
              AND ${activeFileSubtreeSql}`
        )
        .bind(
          ...strictLabels,
          floor,
          ...strictLabels,
          user.id,
          ...strictLabels,
          nowIso,
          nowIso,
          user.tenantId,
          batchDeletedAt,
          user.tenantId,
          folderId
        )
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE files
              SET deleted_at = NULL,
                  deleted_by = NULL,
                  meta_version = meta_version + 1,
                  updated_at = ?
            WHERE tenant_id = ?
              AND upload_state = 'active'
              AND deleted_at = ?
              AND ${activeFileSubtreeSql}`
        )
        .bind(nowIso, user.tenantId, batchDeletedAt, user.tenantId, folderId)
    );
  }

  // 9. Elevate already-active files that were not part of the deleted batch.
  if (placeholders) {
    statements.push(
      db
        .prepare(
          `UPDATE files
              SET classification = ?,
                  meta_version = meta_version + 1,
                  classification_updated_by = ?,
                  classification_updated_at = ?,
                  updated_at = ?
            WHERE tenant_id = ?
              AND upload_state = 'active'
              AND deleted_at IS NULL
              AND ${activeFileSubtreeSql}
              AND classification IN (${placeholders})`
        )
        .bind(
          floor,
          user.id,
          nowIso,
          nowIso,
          user.tenantId,
          user.tenantId,
          folderId,
          ...strictLabels
        )
    );
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         SELECT id, tenant_id, classification, name, COALESCE(extension, ''), COALESCE(ai_reason, '')
           FROM files
          WHERE tenant_id = ?
            AND upload_state = 'active'
            AND deleted_at IS NULL
            AND ${activeFileSubtreeSql}`
      )
      .bind(user.tenantId, user.tenantId, folderId)
  );

  // 10. Storage buckets and shared-link tightening for promoted files.
  for (const file of promotedFileRows?.results ?? []) {
    statements.push(
      ...buildClassificationPolicyStatements(db, {
        tenantId: user.tenantId,
        fileId: file.id,
        fromClassification: file.classification,
        toClassification: floor,
        sizeBytes: file.size_bytes,
        actorId: user.id,
        nowIso,
      })
    );
  }

  const ancestorIds = restoredChain.map((plan) => plan.folder.id);
  const restoredFolderCount = subtreeFolderRows.results.length;
  const restoredFileCount = restoredFileCountRow?.cnt ?? 0;
  const promotedFolderCount = subtreeFolderRows.results.filter(
    (row) =>
      row.id !== folderId &&
      strictLabels.includes(row.classification)
  ).length;
  const promotedFileCount = promotedFileRows?.results.length ?? 0;

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.restore',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: nextRootClassification,
      metadata: {
        restoredBatchDeletedAt: batchDeletedAt,
        renamedTo: nextName !== folder.name ? nextName : null,
        fromParentId: folder.parent_id,
        toParentId: targetParentId,
        depthDelta,
        restoredAncestorIds: ancestorIds,
        restoredFolderCount,
        restoredFileCount,
        classificationFloor: floor,
        promotedFolderCount,
        promotedFileCount,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: targetParentId,
      action: 'folder.restore',
      payload: {
        folder: {
          ...folder,
          parent_id: targetParentId,
          name: nextName,
          depth: newRootDepth,
          classification: nextRootClassification,
          deleted_at: null,
          deleted_by: null,
          version: folder.version + 1,
          updated_at: nowIso,
        },
        restoredAncestorIds: ancestorIds,
      },
      nowIso,
    })
  );

  if (isMoving && folder.parent_id !== null) {
    statements.push(
      buildSyncChangeStmt(db, {
        tenantId: user.tenantId,
        entityType: 'folder',
        entityId: folderId,
        folderId: folder.parent_id,
        action: 'folder.moved_out',
        payload: {
          fromParentId: folder.parent_id,
          toParentId: targetParentId,
          updatedAt: nowIso,
        },
        nowIso,
      })
    );
  }

  const batchResults = await db.batch(statements);

  const restored = await db
    .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, folderId)
    .first<FolderRow>();
  if (!restored) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }

  const finalDestination =
    (await buildRestoreDestinationContext(db, user, targetParentId)) ??
    destination;

  const scopeFolderIds = new Set<string | null>([folder.parent_id, targetParentId, folderId]);
  for (const plan of restoredChain) {
    scopeFolderIds.add(plan.folder.parent_id);
    scopeFolderIds.add(plan.folder.id);
  }
  const affectedFolderIds = new Set<string | null>([
    targetParentId,
    folderId,
    folder.parent_id,
  ]);
  for (const plan of restoredChain) {
    affectedFolderIds.add(plan.folder.parent_id);
    affectedFolderIds.add(plan.folder.id);
  }

  return {
    folder: restored,
    restoredAt: nowIso,
    syncSeq: extractLastSyncSeq(batchResults),
    destination: finalDestination,
    restoredAncestorIds: ancestorIds,
    affectedFolderIds: [...affectedFolderIds],
    scopeFolderIds: [...scopeFolderIds],
  };
}

async function planAncestorChain(
  db: D1Database,
  user: AuthUser,
  parentId: string,
  destination: RestoreDestinationContext,
  sourceRole: Parameters<typeof hasAtLeastRole>[0],
  conflictPolicy: 'fail' | 'rename'
): Promise<AncestorRestorePlan[]> {
  const chain = await loadDeletedAncestorChain(db, user.tenantId, parentId);
  const plans: AncestorRestorePlan[] = [];

  for (const ancestor of chain) {
    const access = await resolveTargetAccess(db, user, 'folder', ancestor.id);
    if (
      !access ||
      access.deletedAt === null ||
      !hasAtLeastRole(access.effectiveRole, 'editor')
    ) {
      throw new FolderServiceError(
        403,
        'FORBIDDEN',
        'Editor permission required on every deleted ancestor folder',
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
