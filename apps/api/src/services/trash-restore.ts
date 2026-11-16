import type { AuthUser } from '../types/api';
import { pickStricterClassification } from '../utils/classification';
import { buildAuditLogStmt } from './audit';
import { resolveTargetAccess } from './authorization';
import { can } from './capabilities';
import { buildClassificationPolicyStatements } from './classification-updater';
import {
  type FileRow,
  FileUploadError,
  validateFileNameAndExt,
} from './file-upload-common';
import {
  findActiveFileNameConflict,
  resolveUniqueRestoredFileName,
} from './filename-conflict';
import {
  type FolderRow,
  FolderServiceError,
  restoreFolderWithOptions,
} from './folder-closure-service';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';
import {
  buildRestoreDestinationContext,
  isPrivilegedAdmin,
  loadDeletedAncestorChain,
  resolveAncestorRestoreName,
  type AdminRestoreDelegation,
  type RestoreDestinationContext,
} from './trash-restore-context';
import {
  TrashRequestError,
  type TrashItemRefInput,
} from './trash-items';

export type TrashConflictPolicy = 'fail' | 'rename';

export interface RestoreFileOptions {
  newName?: unknown;
  conflictPolicy?: TrashConflictPolicy;
  /** `undefined` keeps the original folder; `null` restores to the root. */
  targetFolderId?: string | null;
  restoreParentChain?: boolean;
  expectedVersion?: number;
  /**
   * Tenant admin restoring for the item owner. Bypasses item/folder ACL checks
   * while still enforcing tenant boundaries, destination validity and locks.
   */
  adminDelegation?: AdminRestoreDelegation;
}

export interface RestoreTrashFileResult {
  file: FileRow;
  syncSeq: number | null;
  scopeFolderId: string | null;
  scopeFolderIds: Array<string | null>;
  destination: RestoreDestinationContext;
  restoredAncestorIds: string[];
  affectedFolderIds: Array<string | null>;
}

export interface RestoreTrashFolderResult {
  folder: FolderRow;
  restoredAt: string;
  syncSeq: number | null;
  scopeFolderId: string | null;
  scopeFolderIds: Array<string | null>;
  destination: RestoreDestinationContext;
  restoredAncestorIds: string[];
  affectedFolderIds: Array<string | null>;
}

export interface TrashBulkItemResult {
  type: 'file' | 'folder';
  id: string;
  ok: boolean;
  status: 'succeeded' | 'failed';
  name?: string;
  code?: string;
  error?: string;
  file?: FileRow;
  folder?: FolderRow;
}

export interface TrashRestoreBulkResult {
  results: TrashBulkItemResult[];
  succeededCount: number;
  failedCount: number;
  syncSeq: number | null;
  scopeFolderIds: Array<string | null>;
}

function wrapFileUploadError(err: FileUploadError): never {
  throw new TrashRequestError(err.status, err.code, err.message);
}

interface AncestorRestorePlan {
  folder: FolderRow;
  name: string;
  renamed: boolean;
}

function trashRestoreError(
  status: 400 | 403 | 404 | 409 | 413,
  code: string,
  message: string,
  details?: Record<string, unknown>
): never {
  throw new TrashRequestError(status, code, message, details);
}

/**
 * Restore one soft-deleted file with the authorization, destination, parent
 * chain, conflict, classification, audit and sync rules shared by
 * `POST /api/files/:id/restore` and `POST /api/trash/restore`.
 *
 * `newName` remains the single-file API's explicit override. `restoreParentChain`
 * restores only the deleted folder rows on the file's ancestry path; unrelated
 * siblings deleted in another batch are never touched.
 */
export async function restoreTrashFile(
  db: D1Database,
  user: AuthUser,
  fileId: string,
  options: RestoreFileOptions = {}
): Promise<RestoreTrashFileResult> {
  const conflictPolicy = options.conflictPolicy ?? 'fail';
  const restoreParentChain = options.restoreParentChain === true;
  const privilegedAdmin = isPrivilegedAdmin(user);
  const adminDelegation = options.adminDelegation;
  const adminBypass = Boolean(adminDelegation?.onBehalfOfUserId);
  if (adminDelegation && (!privilegedAdmin || !adminBypass)) {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }

  const [access, file] = await Promise.all([
    resolveTargetAccess(db, user, 'file', fileId),
    db
      .prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, fileId)
      .first<FileRow>(),
  ]);

  if (!file || (!access && !adminBypass)) {
    throw new TrashRequestError(404, 'NOT_FOUND', 'File not found');
  }
  if (file.deleted_at === null) {
    throw new TrashRequestError(409, 'NOT_IN_TRASH', 'File is not in trash');
  }
  if (
    !adminBypass &&
    !privilegedAdmin &&
    !can(access?.capabilities, 'trash.restore')
  ) {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }
  if (
    options.expectedVersion !== undefined &&
    file.meta_version !== options.expectedVersion
  ) {
    throw new TrashRequestError(
      409,
      'VERSION_CONFLICT',
      `File version mismatch (expected ${options.expectedVersion}, actual ${file.meta_version})`,
      { latest: file }
    );
  }

  const explicitTarget = options.targetFolderId !== undefined;
  const targetFolderId = explicitTarget
    ? options.targetFolderId!
    : file.folder_id;
  const isMoving = targetFolderId !== file.folder_id;
  const isOriginalDestination = targetFolderId === file.folder_id;

  const destination = await buildRestoreDestinationContext(
    db,
    user,
    targetFolderId,
    { bypassAccess: adminBypass }
  );
  if (!destination) {
    trashRestoreError(404, 'TARGET_NOT_FOUND', 'Destination folder not found');
  }

  if (destination.isDeleted) {
    const chainCoversDestination =
      isOriginalDestination && restoreParentChain;
    if (!chainCoversDestination) {
      trashRestoreError(
        409,
        'PARENT_FOLDER_DELETED',
        'Parent folder is deleted; restore parent folder first',
        { destination }
      );
    }
  }

  if (isMoving && targetFolderId !== null) {
    const destAccess = await resolveTargetAccess(
      db,
      user,
      'folder',
      targetFolderId
    );
    if (!destAccess || destAccess.deletedAt !== null) {
      trashRestoreError(
        409,
        'PARENT_FOLDER_DELETED',
        'Destination folder is deleted',
        { destination }
      );
    }
    if (!can(destAccess.capabilities, 'folder.create') && !adminBypass) {
      trashRestoreError(
        403,
        'FORBIDDEN',
        'Editor permission required on destination folder',
        { destination }
      );
    }
  }

  const ancestorPlans: AncestorRestorePlan[] = [];
  if (isOriginalDestination && restoreParentChain) {
    const chain = await loadDeletedAncestorChain(db, user.tenantId, file.folder_id);
    for (const ancestor of chain) {
      const ancestorAccess = await resolveTargetAccess(
        db,
        user,
        'folder',
        ancestor.id
      );
      if (
        !privilegedAdmin &&
        (!ancestorAccess ||
          !can(ancestorAccess.capabilities, 'trash.restore'))
      ) {
        trashRestoreError(
          403,
          'FORBIDDEN',
          'Editor permission required on every deleted ancestor folder',
          {
            destination,
            failedAncestorId: ancestor.id,
            failedAncestorName: ancestor.name,
            restoreParentChainRequired: true,
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
        trashRestoreError(
          409,
          'NAME_CONFLICT',
          `An active folder named "${ancestor.name}" already exists at the ancestor destination`,
          {
            destination,
            failedAncestorId: ancestor.id,
            failedAncestorName: ancestor.name,
            suggestedName,
            restoreParentChainRequired: true,
          }
        );
      }
      ancestorPlans.push({
        folder: ancestor,
        name: suggestedName ?? ancestor.name,
        renamed: suggestedName !== null,
      });
    }
  }

  let restoredName = file.name;
  let restoredExt = file.extension;
  if (options.newName !== undefined) {
    try {
      const parsed = validateFileNameAndExt(options.newName);
      restoredName = parsed.name;
      restoredExt = parsed.extension;
    } catch (err) {
      if (err instanceof FileUploadError) wrapFileUploadError(err);
      throw err;
    }
  }

  const conflict = await findActiveFileNameConflict(
    db,
    user.tenantId,
    targetFolderId,
    restoredName,
    file.id
  );
  if (conflict) {
    const suggestedName = await resolveUniqueRestoredFileName(
      db,
      user.tenantId,
      targetFolderId,
      restoredName
    );
    if (conflictPolicy !== 'rename') {
      throw new TrashRequestError(
        409,
        'NAME_CONFLICT',
        `An active file named "${restoredName}" already exists in destination folder`,
        { destination, suggestedName }
      );
    }
    restoredName = suggestedName;
    restoredExt = validateFileNameAndExt(restoredName).extension;
  }

  const nextClassification = pickStricterClassification(
    file.classification,
    destination.classification
  );
  const nowIso = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  for (const plan of ancestorPlans) {
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
          restoredFor: 'file',
          restoredTargetId: file.id,
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
            version: plan.folder.version + 1,
            updated_at: nowIso,
          },
          reason: 'parent_chain',
          restoredTargetId: file.id,
        },
        nowIso,
      })
    );
  }

  statements.push(
    db
      .prepare(
        `UPDATE files
            SET folder_id = ?,
                deleted_at = NULL,
                deleted_by = NULL,
                name = ?,
                extension = ?,
                classification = ?,
                meta_version = meta_version + 1,
                updated_by = ?,
                updated_at = ?
          WHERE tenant_id = ? AND id = ? AND deleted_at IS NOT NULL`
      )
      .bind(
        targetFolderId,
        restoredName,
        restoredExt,
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
        restoredName,
        restoredExt ?? '',
        file.ai_reason ?? ''
      )
  );

  if (nextClassification !== file.classification) {
    statements.push(
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
  }

  // Moving a file to the workspace root removes inherited folder ACLs. Keep the
  // restorer's explicit access exactly like `PATCH /api/files/:id`. For an
  // administrator acting on behalf of the owner, grant the owner instead so the
  // delegated restore does not silently leave the owner without access.
  if (adminBypass && adminDelegation && isMoving) {
    statements.push(
      db
        .prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at
           ) VALUES (?, ?, 'file', ?, 'user', ?, 'owner', ?, ?)
           ON CONFLICT (target_type, target_id, grantee_type, grantee_id) DO NOTHING`
        )
        .bind(
          crypto.randomUUID(),
          user.tenantId,
          file.id,
          adminDelegation.onBehalfOfUserId,
          user.id,
          nowIso
        )
    );
  } else if (isMoving && targetFolderId === null && access?.effectiveRole) {
    statements.push(
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
          access.effectiveRole,
          user.id,
          nowIso
        )
    );
  }

  const restoredAncestorIds = ancestorPlans.map((plan) => plan.folder.id);
  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: adminBypass ? 'admin.file.restore' : 'file.restore',
      targetType: 'file',
      targetId: file.id,
      classificationSnapshot: nextClassification,
      metadata: {
        ...(adminBypass && adminDelegation
          ? {
              targetName: file.name,
              onBehalfOfUserId: adminDelegation.onBehalfOfUserId,
              ownerId:
                adminDelegation.ownerId ?? adminDelegation.onBehalfOfUserId,
              ownerName: adminDelegation.ownerName ?? null,
              ownerEmail: adminDelegation.ownerEmail ?? null,
              sourceVersion: file.current_version_num,
              targetParentId: targetFolderId,
              restoredTo: {
                id: destination.id,
                name: destination.name,
                path: destination.path,
              },
              restoredName,
              adminRestore: true,
            }
          : {}),
        restoredName,
        originalName: restoredName === file.name ? undefined : file.name,
        fromFolderId: file.folder_id,
        toFolderId: targetFolderId,
        restoredAncestorIds,
        restoreParentChain,
        conflictPolicy,
        classificationFloor: destination.classification,
        fromClassification: file.classification,
        toClassification: nextClassification,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'file',
      entityId: file.id,
      folderId: targetFolderId,
      targetUserId: adminBypass
        ? adminDelegation?.onBehalfOfUserId ?? null
        : null,
      action: 'file.restore',
      payload: {
        name: restoredName,
        extension: restoredExt,
        folderId: targetFolderId,
        previousFolderId: file.folder_id,
        classification: nextClassification,
        deletedBy: null,
        restoredAncestorIds,
        metaVersion: file.meta_version + 1,
        updatedAt: nowIso,
      },
      nowIso,
    })
  );

  if (isMoving && file.folder_id !== null) {
    statements.push(
      buildSyncChangeStmt(db, {
        tenantId: user.tenantId,
        entityType: 'file',
        entityId: file.id,
        folderId: file.folder_id,
        action: 'file.moved_out',
        payload: {
          toFolderId: targetFolderId,
          metaVersion: file.meta_version + 1,
          updatedAt: nowIso,
        },
        nowIso,
      })
    );
  }

  const batchResults = await db.batch(statements);

  const restored = await db
    .prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, file.id)
    .first<FileRow>();

  const finalDestination =
    (await buildRestoreDestinationContext(db, user, targetFolderId, {
      bypassAccess: adminBypass,
    })) ?? destination;

  const scopeFolderIds = new Set<string | null>([file.folder_id, targetFolderId]);
  const affectedFolderIds = new Set<string | null>([file.folder_id, targetFolderId]);
  for (const plan of ancestorPlans) {
    scopeFolderIds.add(plan.folder.parent_id);
    scopeFolderIds.add(plan.folder.id);
    affectedFolderIds.add(plan.folder.parent_id);
    affectedFolderIds.add(plan.folder.id);
  }

  return {
    file: restored!,
    syncSeq: extractLastSyncSeq(batchResults),
    scopeFolderId: targetFolderId,
    scopeFolderIds: [...scopeFolderIds],
    destination: finalDestination,
    restoredAncestorIds,
    affectedFolderIds: [...affectedFolderIds],
  };
}

/**
 * Restore one soft-deleted folder subtree through the shared closure-table
 * restore service. Exposed here so single and bulk routes converge on one
 * contract.
 */
export async function restoreTrashFolder(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  conflictPolicy: TrashConflictPolicy = 'fail',
  options: {
    targetParentId?: string | null;
    restoreParentChain?: boolean;
    adminDelegation?: AdminRestoreDelegation;
  } = {}
): Promise<RestoreTrashFolderResult> {
  const restored = await restoreFolderWithOptions(db, user, folderId, {
    conflictPolicy,
    targetParentId: options.targetParentId,
    restoreParentChain: options.restoreParentChain,
    adminDelegation: options.adminDelegation,
  });
  return {
    folder: restored.folder,
    restoredAt: restored.restoredAt,
    syncSeq: restored.syncSeq,
    scopeFolderId: restored.destination.id,
    scopeFolderIds: restored.scopeFolderIds,
    destination: restored.destination,
    restoredAncestorIds: restored.restoredAncestorIds,
    affectedFolderIds: restored.affectedFolderIds,
  };
}

function toFailedResult(
  item: TrashItemRefInput,
  err: unknown
): TrashBulkItemResult {
  if (
    err instanceof TrashRequestError ||
    err instanceof FolderServiceError ||
    err instanceof FileUploadError
  ) {
    return {
      type: item.type,
      id: item.id,
      ok: false,
      status: 'failed',
      code: err.code,
      error: err.message,
    };
  }
  console.error('[trash-restore] unexpected item failure:', err);
  return {
    type: item.type,
    id: item.id,
    ok: false,
    status: 'failed',
    code: 'INTERNAL_ERROR',
    error: 'Failed to restore item',
  };
}

/**
 * Restore up to 100 Trash items independently. One failure never rolls back
 * another item; every successful item records its own audit + sync change and
 * the whole batch is announced to the TenantSyncHub by the route.
 */
export async function restoreTrashItems(
  db: D1Database,
  user: AuthUser,
  items: readonly TrashItemRefInput[],
  conflictPolicy: TrashConflictPolicy = 'fail'
): Promise<TrashRestoreBulkResult> {
  const results: TrashBulkItemResult[] = [];
  const scopeFolderIds = new Set<string | null>();
  let lastSeq: number | null = null;

  for (const item of items) {
    try {
      if (item.type === 'file') {
        const result = await restoreTrashFile(db, user, item.id, {
          conflictPolicy,
        });
        for (const folderId of result.scopeFolderIds) {
          scopeFolderIds.add(folderId);
        }
        if (result.syncSeq !== null) {
          lastSeq = Math.max(lastSeq ?? 0, result.syncSeq);
        }
        results.push({
          type: 'file',
          id: item.id,
          ok: true,
          status: 'succeeded',
          name: result.file.name,
          file: result.file,
        });
      } else {
        const result = await restoreTrashFolder(
          db,
          user,
          item.id,
          conflictPolicy
        );
        for (const folderId of result.scopeFolderIds) {
          scopeFolderIds.add(folderId);
        }
        if (result.syncSeq !== null) {
          lastSeq = Math.max(lastSeq ?? 0, result.syncSeq);
        }
        results.push({
          type: 'folder',
          id: item.id,
          ok: true,
          status: 'succeeded',
          name: result.folder.name,
          folder: result.folder,
        });
      }
    } catch (err) {
      results.push(toFailedResult(item, err));
    }
  }

  const succeededCount = results.filter((result) => result.ok).length;
  return {
    results,
    succeededCount,
    failedCount: results.length - succeededCount,
    syncSeq: lastSeq,
    scopeFolderIds: [...scopeFolderIds],
  };
}
