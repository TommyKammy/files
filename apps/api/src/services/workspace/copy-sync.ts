import type { AuthUser, ClassificationLabel } from '../../types/api';
import { chunkArray, executeBatchChunks } from '../../utils/batch';
import type { FileRow } from '../file-upload-common';
import type { FolderRow } from '../folder-closure-service';
import {
  appendStatsAndFolderCopyStatements,
  appendStatsDeltasStatements,
  buildCoWFileCopyStatements,
  resolveLatestSyncSeq,
  type CopyableFileRow,
  type CopyWorkspaceResult,
  type DestinationContext,
} from './shared';

export async function executeSyncCopySubtree({
  db,
  user,
  dest,
  rootFolders,
  rootFiles,
  rootFolderTargetNames,
  rootFileTargetNames,
  dedupedRootFolderIds,
  nowIso,
}: {
  db: D1Database;
  user: AuthUser;
  dest: DestinationContext;
  rootFolders: Array<{ row: FolderRow }>;
  rootFiles: Array<{ row: CopyableFileRow }>;
  rootFolderTargetNames: Map<string, string>;
  rootFileTargetNames: Map<string, string>;
  dedupedRootFolderIds: string[];
  nowIso: string;
}): Promise<CopyWorkspaceResult> {
  // Synchronous CoW copy path (<= 100 nodes): snapshot before write so self-copy never loops
  const subtreeFoldersById = new Map<string, FolderRow>();
  const subtreeFilesList: CopyableFileRow[] = [];

  for (const chunk of chunkArray(dedupedRootFolderIds, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const [descFolderRes, descFileRes] = await Promise.all([
      db
        .prepare(
          `SELECT DISTINCT f.*
             FROM folder_closures fc
             JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
            WHERE fc.tenant_id = ?
              AND fc.ancestor_id IN (${placeholders})
              AND f.deleted_at IS NULL
            ORDER BY f.depth ASC, f.name ASC`
        )
        .bind(user.tenantId, ...chunk)
        .all<FolderRow>(),
      db
        .prepare(
          `SELECT DISTINCT fl.*, fv.r2_object_key
             FROM files fl
             JOIN file_versions fv ON fv.id = fl.current_version_id
            WHERE fl.tenant_id = ?
              AND fl.upload_state = 'active'
              AND fl.deleted_at IS NULL
              AND fl.folder_id IN (
                SELECT DISTINCT fc.descendant_id
                  FROM folder_closures fc
                  JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
                 WHERE fc.tenant_id = ?
                   AND fc.ancestor_id IN (${placeholders})
                   AND f.deleted_at IS NULL
              )
            ORDER BY fl.name ASC`
        )
        .bind(user.tenantId, user.tenantId, ...chunk)
        .all<CopyableFileRow>(),
    ]);

    for (const f of descFolderRes.results) {
      subtreeFoldersById.set(f.id, f);
    }
    subtreeFilesList.push(...descFileRes.results);
  }

  // Enforce ascending depth order across all copied folders so parents precede children
  const orderedSubtreeFolders = [...subtreeFoldersById.values()].sort(
    (a, b) => a.depth - b.depth || a.name.localeCompare(b.name)
  );
  const rootFolderOrigSet = new Set(dedupedRootFolderIds);
  const folderIdMap = new Map<string, string>();
  const depthMap = new Map<string, number>();

  for (const orig of orderedSubtreeFolders) {
    folderIdMap.set(orig.id, crypto.randomUUID());
  }

  const stmts: D1PreparedStatement[] = [];
  const createdFolders: FolderRow[] = [];
  const createdFiles: FileRow[] = [];
  const statsDeltas = new Map<
    ClassificationLabel,
    { count: number; bytes: number }
  >();
  const scopeFolders = new Set<string | null>([dest.parentId]);

  for (const orig of orderedSubtreeFolders) {
    const newId = folderIdMap.get(orig.id)!;
    const isRootSelected = rootFolderOrigSet.has(orig.id);
    const destParentId = isRootSelected
      ? dest.parentId
      : folderIdMap.get(orig.parent_id ?? '')!;
    const depth = isRootSelected
      ? dest.parentId === null
        ? 0
        : dest.depth + 1
      : (depthMap.get(orig.parent_id!) ?? 0) + 1;
    depthMap.set(orig.id, depth);

    const targetName = isRootSelected
      ? rootFolderTargetNames.get(orig.id)!
      : orig.name;
    scopeFolders.add(destParentId);
    scopeFolders.add(newId);

    appendStatsAndFolderCopyStatements(db, {
      tenantId: user.tenantId,
      actor: user,
      orig,
      newFolderId: newId,
      destParentId,
      targetName,
      depth,
      destFloor: dest.floorClassification,
      nowIso,
      stmts,
      createdFolders,
    });
  }

  // Copy files inside copied folders (deduped) + root selected files
  const seenSubtreeFiles = new Set<string>();
  for (const orig of subtreeFilesList) {
    if (seenSubtreeFiles.has(orig.id)) continue;
    seenSubtreeFiles.add(orig.id);
    const destFolderId = folderIdMap.get(orig.folder_id!)!;
    buildCoWFileCopyStatements(db, {
      tenantId: user.tenantId,
      actor: user,
      orig,
      destFolderId,
      targetName: orig.name,
      destFloor: dest.floorClassification,
      nowIso,
      stmts,
      statsDeltas,
      createdFiles,
    });
  }

  for (const entry of rootFiles) {
    buildCoWFileCopyStatements(db, {
      tenantId: user.tenantId,
      actor: user,
      orig: entry.row,
      destFolderId: dest.parentId,
      targetName: rootFileTargetNames.get(entry.row.id)!,
      destFloor: dest.floorClassification,
      nowIso,
      stmts,
      statsDeltas,
      createdFiles,
    });
  }

  appendStatsDeltasStatements(db, user.tenantId, nowIso, statsDeltas, stmts);

  if (stmts.length > 0) {
    await executeBatchChunks(db, stmts, 30);
  }

  const syncSeq = await resolveLatestSyncSeq(db, user.tenantId);
  return {
    ok: true,
    queued: false,
    totalItems: createdFolders.length + createdFiles.length,
    copiedFolders: createdFolders,
    copiedFiles: createdFiles,
    syncSeq,
    scopeFolderIds: [...scopeFolders],
  };
}
