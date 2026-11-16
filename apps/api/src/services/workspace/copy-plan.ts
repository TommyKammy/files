import type { AuthUser, ResourceRole } from '../../types/api';
import { chunkArray } from '../../utils/batch';
import { resolveTargetAccess } from '../authorization';
import { can } from '../capabilities';
import {
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from '../file-upload-common';
import { type FolderRow, MAX_FOLDER_DEPTH, validateFolderName } from '../folder-closure-service';
import {
  type CopyableFileRow,
  type DestinationContext,
  WorkspaceConflictPolicy,
  WorkspaceOpError,
  allocateCopyName,
  dedupeBatchItems,
  findSelectedDescendantFolderSet,
  loadExistingNamesInDestination,
  resolveDestinationContext,
} from './shared';

export interface CopyPlan {
  dest: DestinationContext;
  rootFolders: Array<{ row: FolderRow; effectiveRole: ResourceRole }>;
  rootFiles: Array<{ row: CopyableFileRow; effectiveRole: ResourceRole }>;
  rootFolderTargetNames: Map<string, string>;
  rootFileTargetNames: Map<string, string>;
  dedupedRootFolderIds: string[];
  totalNodes: number;
  nowIso: string;
}

async function auditCopyDenied(
  db: D1Database,
  user: AuthUser,
  targetType: 'file' | 'folder',
  targetId: string,
  classification: string | null,
  effectiveRole: string,
  targetParentId: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action,
         target_type, target_id, classification_snapshot, status, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, 'workspace.copy_denied', ?, ?, ?, 'blocked', ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      user.tenantId,
      user.id,
      user.email,
      user.ipAddress,
      targetType,
      targetId,
      classification,
      JSON.stringify({ effectiveRole, targetParentId }),
      new Date().toISOString()
    )
    .run();
}

export async function resolveCopyPlan(
  db: D1Database,
  user: AuthUser,
  input: {
    items: unknown;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
  }
): Promise<CopyPlan> {
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
      if (!can(access.capabilities, 'item.download')) {
        await auditCopyDenied(
          db,
          user,
          'folder',
          ref.id,
          row.classification,
          access.effectiveRole ?? 'none',
          dest.parentId
        );
        throw new WorkspaceOpError(
          403,
          'DLP_COPY_FORBIDDEN',
          'Download permission required to copy folder (preview-only roles cannot export)'
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
      if (!can(access.capabilities, 'item.download')) {
        await auditCopyDenied(
          db,
          user,
          'file',
          ref.id,
          row.classification,
          access.effectiveRole ?? 'none',
          dest.parentId
        );
        throw new WorkspaceOpError(
          403,
          'DLP_COPY_FORBIDDEN',
          'Download permission required to copy file (preview-only roles cannot export)'
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

  const rootFolders = validatedFolders.filter(
    (v) => !strictDescendantSet.has(v.row.id)
  );
  const rootFiles = validatedFiles.filter(
    (v) =>
      v.row.folder_id === null ||
      (!selectedFolderIdSet.has(v.row.folder_id) &&
        !strictDescendantSet.has(v.row.folder_id))
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

  return {
    dest,
    rootFolders,
    rootFiles,
    rootFolderTargetNames,
    rootFileTargetNames,
    dedupedRootFolderIds,
    totalNodes: totalSubtreeFolders + rootFiles.length + totalSubtreeFiles,
    nowIso: new Date().toISOString(),
  };
}
