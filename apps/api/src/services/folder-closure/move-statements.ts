import type { AuthUser, ClassificationLabel } from '../../types/api';
import {
  CLASSIFICATION_STRICTNESS,
  isClassificationStricter,
} from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import { buildSyncChangeStmt } from '../sync-changes';
import {
  ClassificationStatsBucket,
  INLINE_CLASSIFICATION_PROPAGATION_LIMIT,
  type FolderRow,
} from './shared';
import type { MovePlan } from './move-plan';

export async function buildMoveStatements(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  plan: Exclude<MovePlan, { noOp: true }>
) {
  const {
    source,
    targetParent,
    targetParentId,
    resolvedName,
    newRootDepth,
    depthDelta,
  } = plan;
  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  // 1. Delete closure links between ancestors strictly outside subtree and nodes inside subtree
  if (source.parent_id !== null) {
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

  // 2. Connect destination parent's ancestors to every node in moved subtree
  if (targetParent) {
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
        .bind(user.tenantId, user.tenantId, targetParent.id, user.tenantId, folderId)
    );
  }

  // 3. Determine whether destination has stricter classification needing subtree elevation
  const destClassification = targetParent?.classification ?? 'unset';
  let nextSourceClassification = source.classification;
  let classificationJobQueued = false;

  if (isClassificationStricter(destClassification, source.classification)) {
    nextSourceClassification = destClassification;
  }

  // Update moved root parent_id, name, classification, depth, version (optimistic lock check)
  statements.push(
    db
      .prepare(
        `UPDATE folders
            SET parent_id = ?,
                name = ?,
                depth = depth + ?,
                classification = ?,
                version = version + 1,
                updated_at = ?
          WHERE tenant_id = ? AND id = ? AND version = ?`
      )
      .bind(
        targetParentId,
        resolvedName,
        depthDelta,
        nextSourceClassification,
        nowIso,
        user.tenantId,
        folderId,
        source.version
      )
  );

  // Update depths of strict descendants inside subtree cleanly in 1 SQL statement
  if (depthDelta !== 0) {
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

  // Elevate sensitivity across subtree folders/files when destination is stricter
  if (destClassification !== 'unset') {
    const targetStrictness = CLASSIFICATION_STRICTNESS[destClassification];
    const strictLabels = (['unset', 'public', 'internal', 'confidential'] as ClassificationLabel[]).filter(
      (label) => CLASSIFICATION_STRICTNESS[label] < targetStrictness
    );

    if (strictLabels.length > 0) {
      const placeholders = strictLabels.map(() => '?').join(', ');
      const countRow = await db
        .prepare(
          `SELECT (
             (SELECT COUNT(*) FROM folders
               WHERE tenant_id = ? AND id != ?
                 AND id IN (SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?)
                 AND classification IN (${placeholders}))
             +
             (SELECT COUNT(*) FROM files
               WHERE tenant_id = ? AND upload_state = 'active' AND deleted_at IS NULL
                 AND folder_id IN (SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?)
                 AND classification IN (${placeholders}))
           ) AS total_upgrades`
        )
        .bind(
          user.tenantId,
          folderId,
          user.tenantId,
          folderId,
          ...strictLabels,
          user.tenantId,
          user.tenantId,
          folderId,
          ...strictLabels
        )
        .first<{ total_upgrades: number }>();

      const totalUpgrades = countRow?.total_upgrades ?? 0;

      if (totalUpgrades > INLINE_CLASSIFICATION_PROPAGATION_LIMIT) {
        classificationJobQueued = true;
      } else if (totalUpgrades > 0) {
        const fileStatsRes = await db
          .prepare(
            `SELECT classification, COUNT(*) AS cnt, COALESCE(SUM(size_bytes), 0) AS bytes
               FROM files
              WHERE tenant_id = ?
                AND upload_state = 'active'
                AND deleted_at IS NULL
                AND folder_id IN (
                  SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                )
                AND classification IN (${placeholders})
              GROUP BY classification`
          )
          .bind(user.tenantId, user.tenantId, folderId, ...strictLabels)
          .all<ClassificationStatsBucket>();

        statements.push(
          db
            .prepare(
              `UPDATE folders
                  SET classification = ?, updated_at = ?
                WHERE tenant_id = ? AND id != ?
                  AND id IN (
                    SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                  )
                  AND classification IN (${placeholders})`
            )
            .bind(
              destClassification,
              nowIso,
              user.tenantId,
              folderId,
              user.tenantId,
              folderId,
              ...strictLabels
            ),
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
                  AND folder_id IN (
                    SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                  )
                  AND classification IN (${placeholders})`
            )
            .bind(
              destClassification,
              user.id,
              nowIso,
              nowIso,
              user.tenantId,
              user.tenantId,
              folderId,
              ...strictLabels
            ),
          // Keep files_fts synchronized for elevated active files
          db
            .prepare(
              `DELETE FROM files_fts
                WHERE file_id IN (
                  SELECT id FROM files
                   WHERE tenant_id = ? AND upload_state = 'active' AND deleted_at IS NULL
                     AND folder_id IN (
                       SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                     )
                )`
            )
            .bind(user.tenantId, user.tenantId, folderId),
          db
            .prepare(
              `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
               SELECT id, tenant_id, classification, name, COALESCE(extension, ''), COALESCE(ai_reason, '')
                 FROM files
                WHERE tenant_id = ? AND upload_state = 'active' AND deleted_at IS NULL
                  AND folder_id IN (
                    SELECT descendant_id FROM folder_closures WHERE tenant_id = ? AND ancestor_id = ?
                  )`
            )
            .bind(user.tenantId, user.tenantId, folderId)
        );

        let addedCount = 0;
        let addedBytes = 0;
        for (const bucket of fileStatsRes.results) {
          addedCount += bucket.cnt;
          addedBytes += bucket.bytes;
          statements.push(
            db
              .prepare(
                `UPDATE tenant_storage_stats
                    SET file_count = MAX(0, file_count - ?),
                        total_bytes = MAX(0, total_bytes - ?),
                        updated_at = ?
                  WHERE tenant_id = ? AND classification = ?`
              )
              .bind(bucket.cnt, bucket.bytes, nowIso, user.tenantId, bucket.classification)
          );
        }
        if (addedCount > 0) {
          statements.push(
            db
              .prepare(
                `INSERT INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (tenant_id, classification)
                 DO UPDATE SET file_count = file_count + excluded.file_count,
                               total_bytes = total_bytes + excluded.total_bytes,
                               updated_at = excluded.updated_at`
              )
              .bind(user.tenantId, destClassification, addedCount, addedBytes, nowIso)
          );
        }
      }
    }
  }

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'folder.move',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: nextSourceClassification,
      metadata: {
        fromParentId: source.parent_id,
        toParentId: targetParentId,
        depthDelta,
        classificationJobQueued,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: targetParentId,
      action: 'folder.move',
      payload: {
        fromParentId: source.parent_id,
        toParentId: targetParentId,
        name: resolvedName,
        depth: newRootDepth,
        classification: nextSourceClassification,
        version: source.version + 1,
        updatedAt: nowIso,
      },
      nowIso,
    })
  );

  if (source.parent_id !== null && source.parent_id !== targetParentId) {
    statements.push(
      buildSyncChangeStmt(db, {
        tenantId: user.tenantId,
        entityType: 'folder',
        entityId: folderId,
        folderId: source.parent_id,
        action: 'folder.moved_out',
        payload: {
          fromParentId: source.parent_id,
          updatedAt: nowIso,
        },
        nowIso,
      })
    );
  }

  return {
    statements,
    classificationJobQueued,
    destClassification,
    nextSourceClassification,
  };
}
