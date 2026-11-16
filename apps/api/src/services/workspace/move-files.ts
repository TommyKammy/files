import type { AuthUser, ResourceRole } from '../../types/api';
import { chunkArray, executeBatchChunks } from '../../utils/batch';
import { pickStricterClassification } from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import {
  buildClassificationPolicyStatements,
} from '../classification-updater';
import type { FileRow } from '../file-upload-common';
import { buildSyncChangeStmt } from '../sync-changes';
import type { DestinationContext } from './shared';

export async function moveFilesToDestination({
  db,
  user,
  dest,
  filesToMove,
  nowIso,
  scopeFolders,
}: {
  db: D1Database;
  user: AuthUser;
  dest: DestinationContext;
  filesToMove: Array<{
    effectiveRole: ResourceRole;
    row: FileRow;
    targetName: string;
    targetExt: string | null;
  }>;
  nowIso: string;
  scopeFolders: Set<string | null>;
}): Promise<FileRow[]> {
  const movedFiles: FileRow[] = [];
  if (filesToMove.length === 0) return movedFiles;

  const fileStmts: D1PreparedStatement[] = [];
  for (const item of filesToMove) {
    const file = item.row;
    scopeFolders.add(file.folder_id);
    const nextClassification =
      dest.parentId !== null
        ? pickStricterClassification(
            file.classification,
            dest.floorClassification
          )
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
      .prepare(
        `SELECT * FROM files WHERE tenant_id = ? AND id IN (${placeholders})`
      )
      .bind(user.tenantId, ...chunk)
      .all<FileRow>();
    movedFiles.push(...updatedRows.results);
  }

  return movedFiles;
}
