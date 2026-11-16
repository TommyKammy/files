import { buildClassificationChangeStatements } from '../../services/classification-updater';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { extractLastSyncSeq, notifyTenantSyncHub } from '../../services/sync-notifier';
import type { ClassificationLabel } from '../../types/api';
import type { PropagateFolderClassificationQueueMessage } from '../../types/classification';
import type { OidcEnv } from '../../types/oidc';
import { executeBatchChunks } from '../../utils/batch';
import { isClassificationStricter } from '../../utils/classification';

export async function handlePropagateFolderClassification(
  msg: PropagateFolderClassificationQueueMessage,
  env: OidcEnv
): Promise<void> {
  const nowIso = new Date().toISOString();

  // 1. Tighten descendant folders that are strictly less strict than targetClassification
  const descendantFolders = await env.DB.prepare(
    `SELECT f.id, f.parent_id, f.classification
     FROM folder_closures fc
     JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
     WHERE fc.tenant_id = ? AND fc.ancestor_id = ? AND f.deleted_at IS NULL`
  )
    .bind(msg.tenantId, msg.folderId)
    .all<{ id: string; parent_id: string | null; classification: ClassificationLabel }>();

  const folderStmts: D1PreparedStatement[] = [];
  for (const folder of descendantFolders.results) {
    if (isClassificationStricter(msg.targetClassification, folder.classification)) {
      folderStmts.push(
        env.DB.prepare(
          'UPDATE folders SET classification = ?, version = version + 1, updated_at = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL'
        ).bind(msg.targetClassification, nowIso, msg.tenantId, folder.id),
        buildSyncChangeStmt(env.DB, {
          tenantId: msg.tenantId,
          entityType: 'folder',
          entityId: folder.id,
          folderId: folder.parent_id,
          action: 'folder.classification_propagated',
          payload: {
            classification: msg.targetClassification,
            rootFolderId: msg.folderId,
            updatedAt: nowIso,
          },
          nowIso,
        })
      );
    }
  }
  const folderResults = folderStmts.length > 0 ? await executeBatchChunks(env.DB, folderStmts, 30) : [];

  // 2. Tighten active & trashed files under the moved subtree + keep stats/FTS/links in sync
  const descendantFiles = await env.DB.prepare(
    `SELECT f.id, f.folder_id, f.size_bytes, f.classification, f.upload_state
     FROM files f
     JOIN folder_closures fc ON fc.tenant_id = f.tenant_id AND fc.descendant_id = f.folder_id
     WHERE f.tenant_id = ? AND fc.ancestor_id = ? AND f.upload_state = 'active'`
  )
    .bind(msg.tenantId, msg.folderId)
    .all<{
      id: string;
      folder_id: string | null;
      size_bytes: number;
      classification: ClassificationLabel;
      upload_state: string;
    }>();

  const fileStmts: D1PreparedStatement[] = [];
  for (const file of descendantFiles.results) {
    if (isClassificationStricter(msg.targetClassification, file.classification)) {
      fileStmts.push(
        ...buildClassificationChangeStatements(env.DB, {
          tenantId: msg.tenantId,
          fileId: file.id,
          folderId: file.folder_id,
          fromClassification: file.classification,
          toClassification: msg.targetClassification,
          sizeBytes: file.size_bytes,
          clearSuggestion: true,
          actorId: msg.actorId,
          actorEmail: msg.actorEmail,
          actorIp: msg.actorIp,
          auditAction: 'folder.classification_propagated',
          auditMetadata: { rootFolderId: msg.folderId },
          nowIso,
        })
      );
    }
  }

  const fileResults = fileStmts.length > 0 ? await executeBatchChunks(env.DB, fileStmts, 30) : [];

  const allResults = [...folderResults, ...fileResults];
  if (allResults.length > 0) {
    await notifyTenantSyncHub(env, {
      tenantId: msg.tenantId,
      seq: extractLastSyncSeq(allResults),
      eventKind: 'folder.classification_propagated',
      scopeFolderIds: [msg.folderId],
    });
  }
}

