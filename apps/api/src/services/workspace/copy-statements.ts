import type { ClassificationLabel } from '../../types/api';
import { pickStricterClassification } from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import { type FileRow, validateFileNameAndExt } from '../file-upload-common';
import type { FolderRow } from '../folder-closure-service';
import { buildSyncChangeStmt } from '../sync-changes';
import { buildRootFolderDeltaByFolderStmts } from '../root-folder-stats';
import { buildUserStorageDeltaStmt } from '../user-storage-stats';
import type { CopyableFileRow } from './shared';

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
    buildUserStorageDeltaStmt(db, {
      tenantId: params.tenantId,
      userId: params.actor.id,
      countDelta: 1,
      bytesDelta: params.orig.size_bytes,
      nowIso: params.nowIso,
    }),
    ...buildRootFolderDeltaByFolderStmts(db, {
      tenantId: params.tenantId,
      folderId: params.destFolderId,
      countDelta: 1,
      bytesDelta: params.orig.size_bytes,
      nowIso: params.nowIso,
    })
  );

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
    deleted_by: null,
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
    deleted_by: null,
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
