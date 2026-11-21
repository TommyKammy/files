import type { AuthUser } from '../../../types/api';
import { buildAuditLogStmt } from '../../audit';
import { buildClassificationPolicyStatements } from '../../classification-updater';
import {
  buildRootFolderDeleteStmt,
  buildRootFolderSubtreeDeltaStmt,
} from '../../root-folder-stats';
import { buildSyncChangeStmt } from '../../sync-changes';
import type { FolderRestorePlan } from './plan';

export function buildRestoreStatements(
  db: D1Database,
  user: AuthUser,
  planData: FolderRestorePlan,
  nowIso: string
): D1PreparedStatement[] {
  const {
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
    subtreeFolderRows,
    promotedFileRows,
    restoredFileCount,
  } = planData;

  const folderId = folder.id;
  const placeholders =
    strictLabels.length > 0 ? strictLabels.map(() => '?').join(', ') : null;
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
        action: adminBypass ? 'admin.folder.restore' : 'folder.restore',
        targetType: 'folder',
        targetId: plan.folder.id,
        classificationSnapshot: plan.folder.classification,
        metadata: {
          ...(adminBypass && adminDelegation
            ? {
                targetName: plan.name,
                onBehalfOfUserId: adminDelegation.onBehalfOfUserId,
                ownerId:
                  adminDelegation.ownerId ?? adminDelegation.onBehalfOfUserId,
                ownerName: adminDelegation.ownerName ?? null,
                ownerEmail: adminDelegation.ownerEmail ?? null,
                sourceVersion: plan.folder.version,
                targetParentId: plan.folder.parent_id,
                restoredName: plan.name,
                adminRestore: true,
              }
            : {}),
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
        targetUserId: adminBypass
          ? adminDelegation?.onBehalfOfUserId ?? null
          : null,
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
  if (isMoving) {
    statements.push(
      buildRootFolderSubtreeDeltaStmt(db, {
        tenantId: user.tenantId,
        subtreeRootId: folderId,
        sign: -1,
        deletedAtMatch: null,
        nowIso,
      })
    );
    if (folder.parent_id === null && targetParentId !== null) {
      statements.push(buildRootFolderDeleteStmt(db, user.tenantId, folderId));
    }
  }
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

  // 2b. Delegated restores that change location grant the owner a direct ACL so
  //     the move cannot strip inherited access from the on-behalf user.
  if (adminBypass && adminDelegation && isMoving) {
    statements.push(
      db
        .prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
           ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)
           ON CONFLICT (target_type, target_id, grantee_type, grantee_id) DO NOTHING`
        )
        .bind(
          crypto.randomUUID(),
          user.tenantId,
          folderId,
          adminDelegation.onBehalfOfUserId,
          user.id,
          nowIso
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
  if (!isMoving) {
    statements.push(
      buildRootFolderSubtreeDeltaStmt(db, {
        tenantId: user.tenantId,
        subtreeRootId: folderId,
        sign: 1,
        deletedAtMatch: batchDeletedAt,
        nowIso,
      })
    );
  }
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
  if (isMoving) {
    statements.push(
      buildRootFolderSubtreeDeltaStmt(db, {
        tenantId: user.tenantId,
        subtreeRootId: folderId,
        sign: 1,
        deletedAtMatch: null,
        nowIso,
      })
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
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason, content_excerpt)
         SELECT id, tenant_id, classification, name, COALESCE(extension, ''), COALESCE(ai_reason, ''), COALESCE(content_excerpt, '')
           FROM files
          WHERE tenant_id = ?
            AND upload_state = 'active'
            AND deleted_at IS NULL
            AND ${activeFileSubtreeSql}`
      )
      .bind(user.tenantId, user.tenantId, folderId)
  );

  // 10. Storage buckets and shared-link tightening for promoted files.
  for (const file of promotedFileRows) {
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
  const restoredFolderCount = subtreeFolderRows.length;
  const promotedFolderCount = subtreeFolderRows.filter(
    (row) => row.id !== folderId && strictLabels.includes(row.classification)
  ).length;
  const promotedFileCount = promotedFileRows.length;

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: adminBypass ? 'admin.folder.restore' : 'folder.restore',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: nextRootClassification,
      metadata: {
        ...(adminBypass && adminDelegation
          ? {
              targetName: folder.name,
              onBehalfOfUserId: adminDelegation.onBehalfOfUserId,
              ownerId:
                adminDelegation.ownerId ?? adminDelegation.onBehalfOfUserId,
              ownerName: adminDelegation.ownerName ?? null,
              ownerEmail: adminDelegation.ownerEmail ?? null,
              sourceVersion: folder.version,
              targetParentId,
              restoredTo: {
                id: destination.id,
                name: destination.name,
                path: destination.path,
              },
              restoredName: nextName,
              adminRestore: true,
            }
          : {}),
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
        conflictPolicy,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: targetParentId,
      targetUserId: adminBypass
        ? adminDelegation?.onBehalfOfUserId ?? null
        : null,
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

  return statements;
}
