import type { AuthUser, ClassificationLabel } from '../../types/api';
import type { CopySubtreeQueueMessage } from '../../types/classification';
import { chunkArray, executeBatchChunks } from '../../utils/batch';
import { pickStricterClassification } from '../../utils/classification';
import { buildAuditLogStmt } from '../audit';
import { hasAtLeastRole, resolveTargetAccess } from '../authorization';
import {
  buildClassificationPolicyStatements,
  resolveFolderClassificationFloor,
} from '../classification-updater';
import {
  type FileRow,
  FileUploadError,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from '../file-upload-common';
import {
  type FolderRow,
  FolderServiceError,
  MAX_FOLDER_DEPTH,
  moveFolderSubtree,
  validateFolderName,
} from '../folder-closure-service';
import { buildSyncChangeStmt, getSyncWatermarks } from '../sync-changes';
import { notifyTenantSyncHub } from '../sync-notifier';
import type { OidcEnv } from '../../types/oidc';

import {
  ASYNC_COPY_CHUNK_NODES,
  CopyFrontierEntry,
  CopyJobState,
  CopyWorkspaceResult,
  CopyableFileRow,
  SYNC_COPY_NODE_LIMIT,
  WorkspaceBatchItemInput,
  WorkspaceConflictPolicy,
  WorkspaceOpError,
  allocateCopyName,
  appendStatsAndFolderCopyStatements,
  appendStatsDeltasStatements,
  buildCoWFileCopyStatements,
  dedupeBatchItems,
  findSelectedDescendantFolderSet,
  loadExistingNamesInDestination,
  resolveDestinationContext,
  resolveLatestSyncSeq,
} from './shared';

export async function copyWorkspaceItems(
  db: D1Database,
  queue: Queue,
  user: AuthUser,
  input: {
    items: unknown;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
  }
): Promise<CopyWorkspaceResult> {
  const items = dedupeBatchItems(input.items);
  const conflictPolicy: WorkspaceConflictPolicy =
    input.conflictPolicy === 'fail' ? 'fail' : 'rename';
  const dest = await resolveDestinationContext(db, user, input.targetParentId);

  const folderRefs = items.filter((i) => i.type === 'folder');
  const fileRefs = items.filter((i) => i.type === 'file');

  // Verify every explicitly requested item exists, is active, and has at least `viewer` (downloadable) access
  const validatedFolders = await Promise.all(
    folderRefs.map(async (ref) => {
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
      if (!hasAtLeastRole(access.effectiveRole, 'viewer')) {
        await db
          .prepare(
            `INSERT INTO audit_logs (
               id, tenant_id, actor_id, actor_email, actor_ip, action,
               target_type, target_id, classification_snapshot, status, metadata_json, created_at
             ) VALUES (?, ?, ?, ?, ?, 'workspace.copy_denied', 'folder', ?, ?, 'blocked', ?, ?)`
          )
          .bind(
            crypto.randomUUID(),
            user.tenantId,
            user.id,
            user.email,
            user.ipAddress,
            ref.id,
            row.classification,
            JSON.stringify({
              effectiveRole: access.effectiveRole,
              targetParentId: dest.parentId,
            }),
            new Date().toISOString()
          )
          .run();
        throw new WorkspaceOpError(
          403,
          'DLP_COPY_FORBIDDEN',
          'Viewer permission required to copy folder (previewer cannot export or copy)'
        );
      }
      return { row, effectiveRole: access.effectiveRole! };
    })
  );

  const validatedFiles = await Promise.all(
    fileRefs.map(async (ref) => {
      const [access, row] = await Promise.all([
        resolveTargetAccess(db, user, 'file', ref.id),
        db
          .prepare(
            `SELECT fl.*, fv.r2_object_key
               FROM files fl
               JOIN file_versions fv ON fv.id = fl.current_version_id
              WHERE fl.tenant_id = ? AND fl.id = ? AND fl.deleted_at IS NULL`
          )
          .bind(user.tenantId, ref.id)
          .first<CopyableFileRow>(),
      ]);
      if (!access || !row || row.upload_state !== 'active') {
        throw new WorkspaceOpError(404, 'NOT_FOUND', `File not found: ${ref.id}`);
      }
      if (!hasAtLeastRole(access.effectiveRole, 'viewer')) {
        await db
          .prepare(
            `INSERT INTO audit_logs (
               id, tenant_id, actor_id, actor_email, actor_ip, action,
               target_type, target_id, classification_snapshot, status, metadata_json, created_at
             ) VALUES (?, ?, ?, ?, ?, 'workspace.copy_denied', 'file', ?, ?, 'blocked', ?, ?)`
          )
          .bind(
            crypto.randomUUID(),
            user.tenantId,
            user.id,
            user.email,
            user.ipAddress,
            ref.id,
            row.classification,
            JSON.stringify({
              effectiveRole: access.effectiveRole,
              targetParentId: dest.parentId,
            }),
            new Date().toISOString()
          )
          .run();
        throw new WorkspaceOpError(
          403,
          'DLP_COPY_FORBIDDEN',
          'Viewer permission required to copy file (previewer cannot export or copy)'
        );
      }
      return { row, effectiveRole: access.effectiveRole! };
    })
  );

  // Prune redundant descendants if user selected both ancestor folder and child items
  const rootFolderIds = validatedFolders.map((v) => v.row.id);
  const selectedFolderIdSet = new Set(rootFolderIds);
  const strictDescendantSet = await findSelectedDescendantFolderSet(
    db,
    user.tenantId,
    rootFolderIds
  );

  const rootFolders = validatedFolders.filter((v) => !strictDescendantSet.has(v.row.id));
  const rootFiles = validatedFiles.filter(
    (v) =>
      v.row.folder_id === null ||
      (!selectedFolderIdSet.has(v.row.folder_id) && !strictDescendantSet.has(v.row.folder_id))
  );

  // Count total subtree folders, files, max relative depth, and logical bytes
  let totalSubtreeFolders = 0;
  let maxRelDepth = 0;
  let totalCopyBytes = rootFiles.reduce((acc, f) => acc + f.row.size_bytes, 0);
  let totalSubtreeFiles = 0;

  const dedupedRootFolderIds = rootFolders.map((r) => r.row.id);
  for (const chunk of chunkArray(dedupedRootFolderIds, 30)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const [folderMetrics, fileMetrics] = await Promise.all([
      db
        .prepare(
          `SELECT COUNT(DISTINCT fc.descendant_id) AS cnt,
                  COALESCE(MAX(fc.depth), 0) AS max_rel_depth
             FROM folder_closures fc
             JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.descendant_id
            WHERE fc.tenant_id = ?
              AND fc.ancestor_id IN (${placeholders})
              AND f.deleted_at IS NULL`
        )
        .bind(user.tenantId, ...chunk)
        .first<{ cnt: number; max_rel_depth: number }>(),
      db
        .prepare(
          `SELECT COUNT(DISTINCT fl.id) AS cnt,
                  COALESCE(SUM(fl.size_bytes), 0) AS total_bytes
             FROM files fl
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
              )`
        )
        .bind(user.tenantId, user.tenantId, ...chunk)
        .first<{ cnt: number; total_bytes: number }>(),
    ]);

    totalSubtreeFolders += Number(folderMetrics?.cnt ?? 0);
    maxRelDepth = Math.max(maxRelDepth, Number(folderMetrics?.max_rel_depth ?? 0));
    totalSubtreeFiles += Number(fileMetrics?.cnt ?? 0);
    totalCopyBytes += Number(fileMetrics?.total_bytes ?? 0);
  }

  if (dedupedRootFolderIds.length > 0) {
    const targetRootDepth = dest.parentId === null ? 0 : dest.depth + 1;
    if (targetRootDepth + maxRelDepth > MAX_FOLDER_DEPTH) {
      throw new WorkspaceOpError(
        400,
        'MAX_DEPTH_EXCEEDED',
        `Copy exceeds maximum folder depth (${MAX_FOLDER_DEPTH})`
      );
    }
  }

  const quota = await getTenantQuotaStatus(db, user.tenantId);
  if (quota.usedBytes + totalCopyBytes > quota.quotaBytes) {
    throw new WorkspaceOpError(
      413,
      'QUOTA_EXCEEDED',
      `Tenant storage quota exceeded (remaining ${quota.remainingBytes} bytes)`
    );
  }

  // Allocate destination root names respecting conflictPolicy
  const existingNames = await loadExistingNamesInDestination(db, user.tenantId, dest.parentId);
  const rootFolderTargetNames = new Map<string, string>();
  for (const entry of rootFolders) {
    if (existingNames.folderNames.has(entry.row.name) && conflictPolicy === 'fail') {
      throw new WorkspaceOpError(
        409,
        'NAME_CONFLICT',
        `A folder named "${entry.row.name}" already exists in destination`
      );
    }
    const targetName = allocateCopyName(entry.row.name, 'folder', existingNames.folderNames);
    rootFolderTargetNames.set(entry.row.id, validateFolderName(targetName));
  }

  const rootFileTargetNames = new Map<string, string>();
  for (const entry of rootFiles) {
    if (existingNames.fileNames.has(entry.row.name) && conflictPolicy === 'fail') {
      throw new WorkspaceOpError(
        409,
        'NAME_CONFLICT',
        `An active file named "${entry.row.name}" already exists in destination folder`
      );
    }
    const targetName = allocateCopyName(entry.row.name, 'file', existingNames.fileNames);
    rootFileTargetNames.set(entry.row.id, validateFileNameAndExt(targetName).name);
  }

  const totalNodes = totalSubtreeFolders + rootFiles.length + totalSubtreeFiles;
  const nowIso = new Date().toISOString();

  // Asynchronous Queue fallback for large subtrees (>100 nodes) so Workers 10ms CPU stays bounded
  if (totalNodes > SYNC_COPY_NODE_LIMIT) {
    const jobId = crypto.randomUUID();
    const initialFrontier: CopyFrontierEntry[] = [
      ...rootFolders.map((entry) => ({
        kind: 'folder' as const,
        srcId: entry.row.id,
        destParentId: dest.parentId,
        targetName: rootFolderTargetNames.get(entry.row.id)!,
        depth: dest.parentId === null ? 0 : dest.depth + 1,
      })),
      ...rootFiles.map((entry) => ({
        kind: 'file' as const,
        srcId: entry.row.id,
        destParentId: dest.parentId,
        targetName: rootFileTargetNames.get(entry.row.id)!,
      })),
    ];

    const state: CopyJobState = {
      frontier: initialFrontier,
      destFloor: dest.floorClassification,
      createdFolderIds: [],
      scopeFolderIds: [dest.parentId],
    };

    await db
      .prepare(
        `INSERT INTO workspace_jobs (
           id, tenant_id, job_type, status, total_items, processed_items,
           target_folder_id, created_by, pending_json, created_at, updated_at
         ) VALUES (?, ?, 'copy_subtree', 'queued', ?, 0, ?, ?, ?, ?, ?)`
      )
      .bind(
        jobId,
        user.tenantId,
        totalNodes,
        dest.parentId,
        user.id,
        JSON.stringify(state),
        nowIso,
        nowIso
      )
      .run();

    await queue.send({
      type: 'copy_subtree',
      jobId,
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
    } satisfies CopySubtreeQueueMessage);

    return {
      ok: true,
      queued: true,
      jobId,
      totalItems: totalNodes,
      copiedFolders: [],
      copiedFiles: [],
      syncSeq: null,
      scopeFolderIds: [dest.parentId],
    };
  }

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
  const statsDeltas = new Map<ClassificationLabel, { count: number; bytes: number }>();
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

    const targetName = isRootSelected ? rootFolderTargetNames.get(orig.id)! : orig.name;
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

/**
 * Duplicate selected items in-place inside each item's current parent folder (`rename` policy).
 */
export async function duplicateWorkspaceItems(
  db: D1Database,
  queue: Queue,
  user: AuthUser,
  rawItems: unknown
): Promise<CopyWorkspaceResult & { jobIds: string[] }> {
  const items = dedupeBatchItems(rawItems);

  // Resolve current parent ID of every selected item so items can duplicate alongside themselves
  const groups = new Map<string | null, WorkspaceBatchItemInput[]>();
  const resolvedPairs = await Promise.all(
    items.map(async (ref) => {
      if (ref.type === 'folder') {
        const folder = await db
          .prepare('SELECT id, parent_id FROM folders WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL')
          .bind(user.tenantId, ref.id)
          .first<{ id: string; parent_id: string | null }>();
        if (!folder) {
          throw new WorkspaceOpError(404, 'NOT_FOUND', `Folder not found: ${ref.id}`);
        }
        return { ref, parentId: folder.parent_id };
      }
      const file = await db
        .prepare(
          `SELECT id, folder_id FROM files
            WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND upload_state = 'active'`
        )
        .bind(user.tenantId, ref.id)
        .first<{ id: string; folder_id: string | null }>();
      if (!file) {
        throw new WorkspaceOpError(404, 'NOT_FOUND', `File not found: ${ref.id}`);
      }
      return { ref, parentId: file.folder_id };
    })
  );

  for (const pair of resolvedPairs) {
    const list = groups.get(pair.parentId) ?? [];
    list.push(pair.ref);
    groups.set(pair.parentId, list);
  }

  const copiedFolders: FolderRow[] = [];
  const copiedFiles: FileRow[] = [];
  const scopeFolderIds = new Set<string | null>();
  const jobIds: string[] = [];
  let queued = false;
  let totalItems = 0;
  let syncSeq: number | null = null;

  for (const [parentId, groupItems] of groups.entries()) {
    const res = await copyWorkspaceItems(db, queue, user, {
      items: groupItems,
      targetParentId: parentId,
      conflictPolicy: 'rename',
    });
    copiedFolders.push(...res.copiedFolders);
    copiedFiles.push(...res.copiedFiles);
    for (const s of res.scopeFolderIds) scopeFolderIds.add(s);
    if (res.queued && res.jobId) {
      queued = true;
      jobIds.push(res.jobId);
    }
    totalItems += res.totalItems;
    if (res.syncSeq !== null) syncSeq = res.syncSeq;
  }

  return {
    ok: true,
    queued,
    ...(jobIds.length > 0 ? { jobId: jobIds[0] } : {}),
    jobIds,
    totalItems,
    copiedFolders,
    copiedFiles,
    syncSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}

/**
 * Process a bounded chunk (`ASYNC_COPY_CHUNK_NODES = 15`) of a queued large subtree copy
 * so each Cloudflare Queue invocation finishes comfortably within Workers 10ms CPU limits.
 */
