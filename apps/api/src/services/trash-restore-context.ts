import type {
  AuthUser,
  ClassificationLabel,
  ResourceRole,
} from '../types/api';
import {
  CLASSIFICATION_STRICTNESS,
  isClassificationStricter,
  pickStricterClassification,
} from '../utils/classification';
import { hasAtLeastRole, resolveTargetAccess } from './authorization';
import { canRole } from './capabilities';
import {
  findActiveFileNameConflict,
  resolveUniqueRestoredFileName,
} from './filename-conflict';
import {
  type FolderRow,
  MAX_FOLDER_DEPTH,
  hasDuplicateFolderName,
  resolveUniqueRestoredName,
} from './folder-closure/shared';
import type { FileRow } from './file-upload-common';
import { TrashRequestError, type TrashItemType } from './trash-items';

export interface RestoreBreadcrumb {
  id: string;
  name: string;
  classification: ClassificationLabel;
  depth: number;
  version: number;
}

/**
 * Administrator acting for the item owner. The delegation is only honored when
 * the authenticated user is a tenant admin; services still record the real
 * actor and resolve the owner from tenant-scoped data before restoring.
 */
export interface AdminRestoreDelegation {
  onBehalfOfUserId: string;
  ownerId?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
}

export interface RestoreDestinationContext {
  id: string | null;
  name: string;
  path: string;
  breadcrumbs: RestoreBreadcrumb[];
  /** Strictest classification across the destination chain (the restore floor). */
  classification: ClassificationLabel;
  isDeleted: boolean;
  deletedAncestorCount: number;
  /**
   * `false` when the caller may not read the destination. Names are then
   * redacted so an item that is visible in Trash never leaks a private parent
   * folder name to an outsider.
   */
  accessible: boolean;
}

export interface TrashRestoreItemRef {
  id: string;
  type: TrashItemType;
  name: string;
  classification: ClassificationLabel;
  folderId: string | null;
  parentId: string | null;
}

export interface TrashRestoreContextResponse {
  type: TrashItemType;
  item: TrashRestoreItemRef;
  itemEffectiveRole: ResourceRole | null;
  originalLocation: RestoreDestinationContext;
  /** Original location, or the explicitly requested destination. */
  destination: RestoreDestinationContext;
  conflict: {
    hasConflict: boolean;
    suggestedName: string | null;
  };
  classification: {
    floor: ClassificationLabel;
    willUpgrade: boolean;
    upgradeCount: number;
  };
  restoreParentChainAvailable: boolean;
  restoreParentChainDefault: boolean;
  destinationChecks: {
    circular: boolean;
    maxDepthExceeded: boolean;
    targetDeleted: boolean;
    canRestoreToRoot: boolean;
  };
}

/**
 * Target selection has two independent permissions:
 * - restoring the Trash row (file restore keeps the historical sec/sys admin bypass)
 * - writing into the *destination* (same editor rule as move/file-update)
 */
export function isPrivilegedAdmin(user: Pick<AuthUser, 'role'>): boolean {
  return user.role === 'sec_admin' || user.role === 'sys_admin';
}

export function canRestoreTargetItem(
  user: Pick<AuthUser, 'role'>,
  targetType: TrashItemType,
  effectiveRole: ResourceRole | null
): boolean {
  if (targetType === 'file' && isPrivilegedAdmin(user)) return true;
  return canRole(effectiveRole, 'trash.restore');
}

const ROOT_DESTINATION: RestoreDestinationContext = {
  id: null,
  name: 'マイファイル (ルート)',
  path: 'マイファイル (ルート)',
  breadcrumbs: [],
  classification: 'unset',
  isDeleted: false,
  deletedAncestorCount: 0,
  accessible: true,
};

const REDACTED_DESTINATION_NAME = '（アクセス権限のないフォルダ）';
const REDACTED_DESTINATION_PATH = '（アクセス権限のない場所）';

/** Load every folder from the root to `folderId` inclusive, oldest ancestor first. */
export async function loadFolderChain(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<FolderRow[]> {
  const rows = await db
    .prepare(
      `SELECT f.*
         FROM folder_closures fc
         JOIN folders f
           ON f.tenant_id = fc.tenant_id AND f.id = fc.ancestor_id
        WHERE fc.tenant_id = ? AND fc.descendant_id = ?
        ORDER BY fc.depth DESC`
    )
    .bind(tenantId, folderId)
    .all<FolderRow>();
  return rows.results;
}

/**
 * Deleted folders between the workspace root and `parentId` inclusive, ordered
 * shallowest first. This is the exact chain `restoreParentChain` restores.
 *
 * Only the folder rows themselves are returned: unrelated siblings that were
 * deleted independently are NOT part of the chain and stay in Trash.
 */
export async function loadDeletedAncestorChain(
  db: D1Database,
  tenantId: string,
  parentId: string | null
): Promise<FolderRow[]> {
  if (parentId === null) return [];
  const chain = await loadFolderChain(db, tenantId, parentId);
  return chain.filter((folder) => folder.deleted_at !== null);
}

export async function buildRestoreDestinationContext(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId' | 'role'>,
  folderId: string | null,
  options: { bypassAccess?: boolean } = {}
): Promise<RestoreDestinationContext | null> {
  if (folderId === null) return { ...ROOT_DESTINATION };

  const chain = await loadFolderChain(db, user.tenantId, folderId);
  if (chain.length === 0) return null;

  const target = chain[chain.length - 1]!;
  const access = await resolveTargetAccess(db, user, 'folder', folderId);
  const accessible =
    options.bypassAccess === true ||
    (Boolean(access) &&
      (isPrivilegedAdmin(user) || canRole(access!.effectiveRole, 'folder.list')));

  if (!accessible) {
    return {
      id: folderId,
      name: REDACTED_DESTINATION_NAME,
      path: REDACTED_DESTINATION_PATH,
      breadcrumbs: [],
      classification: 'unset',
      isDeleted: target.deleted_at !== null,
      deletedAncestorCount: chain.filter((row) => row.deleted_at !== null).length,
      accessible: false,
    };
  }

  let floor: ClassificationLabel = 'unset';
  for (const row of chain) {
    floor = pickStricterClassification(floor, row.classification);
  }

  const breadcrumbs: RestoreBreadcrumb[] = chain.map((row) => ({
    id: row.id,
    name: row.name,
    classification: row.classification,
    depth: row.depth,
    version: row.version,
  }));

  return {
    id: folderId,
    name: target.name,
    path: breadcrumbs.map((crumb) => crumb.name).join(' / '),
    breadcrumbs,
    classification: floor,
    isDeleted: target.deleted_at !== null,
    deletedAncestorCount: chain.filter((row) => row.deleted_at !== null).length,
    accessible: true,
  };
}

export async function folderSubtreeMaxDepth(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(depth), 0) AS max_depth
         FROM folder_closures
        WHERE tenant_id = ? AND ancestor_id = ?`
    )
    .bind(tenantId, folderId)
    .first<{ max_depth: number }>();
  return row?.max_depth ?? 0;
}

/** O(1) closure-based cycle check: is `candidateId` inside `folderId`? */
export async function isFolderWithinSubtree(
  db: D1Database,
  tenantId: string,
  ancestorId: string,
  candidateId: string
): Promise<boolean> {
  if (ancestorId === candidateId) return true;
  const row = await db
    .prepare(
      `SELECT 1 AS hit
         FROM folder_closures
        WHERE tenant_id = ? AND ancestor_id = ? AND descendant_id = ?
        LIMIT 1`
    )
    .bind(tenantId, ancestorId, candidateId)
    .first<{ hit: number }>();
  return Boolean(row);
}

export function classificationStrictnessBelow(
  floor: ClassificationLabel
): ClassificationLabel[] {
  const target = CLASSIFICATION_STRICTNESS[floor];
  return (['unset', 'public', 'internal', 'confidential'] as ClassificationLabel[]).filter(
    (label) => CLASSIFICATION_STRICTNESS[label] < target
  );
}

/**
 * Count the restored subtree rows that would be promoted to `floor`.
 * Only rows belonging to the folder's own deletion batch are considered, so a
 * sibling deleted independently never inflates the warning.
 */
export async function countFolderSubtreeClassificationUpgrades(
  db: D1Database,
  tenantId: string,
  folderId: string,
  batchDeletedAt: string,
  floor: ClassificationLabel
): Promise<number> {
  const strictLabels = classificationStrictnessBelow(floor);
  if (strictLabels.length === 0) return 0;

  const placeholders = strictLabels.map(() => '?').join(', ');
  const row = await db
    .prepare(
      `SELECT (
          (SELECT COUNT(*)
             FROM folders
            WHERE tenant_id = ?
              AND id IN (
                SELECT descendant_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND ancestor_id = ?
              )
              AND deleted_at = ?
              AND classification IN (${placeholders}))
          +
          (SELECT COUNT(*)
             FROM files
            WHERE tenant_id = ?
              AND upload_state = 'active'
              AND folder_id IN (
                SELECT descendant_id
                  FROM folder_closures
                 WHERE tenant_id = ? AND ancestor_id = ?
              )
              AND deleted_at = ?
              AND classification IN (${placeholders}))
        ) AS upgrade_count`
    )
    .bind(
      tenantId,
      tenantId,
      folderId,
      batchDeletedAt,
      ...strictLabels,
      tenantId,
      tenantId,
      folderId,
      batchDeletedAt,
      ...strictLabels
    )
    .first<{ upgrade_count: number }>();
  return row?.upgrade_count ?? 0;
}

async function suggestedFileRestoreName(
  db: D1Database,
  tenantId: string,
  folderId: string | null,
  baseName: string
): Promise<string | null> {
  if (!(await findActiveFileNameConflict(db, tenantId, folderId, baseName))) {
    return null;
  }
  return resolveUniqueRestoredFileName(db, tenantId, folderId, baseName);
}

async function suggestedFolderRestoreName(
  db: D1Database,
  tenantId: string,
  parentId: string | null,
  baseName: string,
  excludeFolderId: string
): Promise<string | null> {
  if (
    !(await hasDuplicateFolderName(
      db,
      tenantId,
      parentId,
      baseName,
      excludeFolderId
    ))
  ) {
    return null;
  }
  return resolveUniqueRestoredName(db, tenantId, parentId, baseName);
}

/**
 * Lightweight "what will happen if I restore this?" projection used by the
 * confirmation dialog. It performs the same RBAC check as the restore API but
 * never leaks a parent folder name the caller cannot read.
 */
export async function buildTrashRestoreContext(
  db: D1Database,
  user: AuthUser,
  type: TrashItemType,
  id: string,
  target?: { provided: boolean; parentId: string | null }
): Promise<TrashRestoreContextResponse> {
  if (type === 'file') {
    const [access, file] = await Promise.all([
      resolveTargetAccess(db, user, 'file', id),
      db
        .prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
        .bind(user.tenantId, id)
        .first<FileRow>(),
    ]);
    if (!access || !file) {
      throw new TrashRequestError(404, 'NOT_FOUND', 'File not found');
    }
    if (file.deleted_at === null) {
      throw new TrashRequestError(409, 'NOT_IN_TRASH', 'File is not in trash');
    }
    if (!canRestoreTargetItem(user, 'file', access.effectiveRole)) {
      throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
    }

    const originalLocation = await buildRestoreDestinationContext(
      db,
      user,
      file.folder_id
    );
    if (!originalLocation) {
      throw new TrashRequestError(404, 'NOT_FOUND', 'Original folder not found');
    }

    const destination = target?.provided
      ? await buildRestoreDestinationContext(db, user, target.parentId)
      : originalLocation;
    if (!destination) {
      throw new TrashRequestError(404, 'TARGET_NOT_FOUND', 'Destination folder not found');
    }

    const suggestedName = destination.accessible
      ? await suggestedFileRestoreName(
          db,
          user.tenantId,
          destination.id,
          file.name
        )
      : null;
    const floor = destination.classification;
    const willUpgrade = isClassificationStricter(floor, file.classification);

    return {
      type: 'file',
      item: {
        id: file.id,
        type: 'file',
        name: file.name,
        classification: file.classification,
        // The original parent id is only exposed when its name is readable too.
        folderId: originalLocation.accessible ? file.folder_id : null,
        parentId: null,
      },
      itemEffectiveRole: access.effectiveRole,
      originalLocation,
      destination,
      conflict: { hasConflict: suggestedName !== null, suggestedName },
      classification: {
        floor,
        willUpgrade,
        upgradeCount: willUpgrade ? 1 : 0,
      },
      restoreParentChainAvailable: originalLocation.deletedAncestorCount > 0,
      restoreParentChainDefault: originalLocation.deletedAncestorCount > 0,
      destinationChecks: {
        circular: false,
        maxDepthExceeded: false,
        targetDeleted: destination.isDeleted,
        canRestoreToRoot: true,
      },
    };
  }

  const [access, folder] = await Promise.all([
    resolveTargetAccess(db, user, 'folder', id),
    db
      .prepare('SELECT * FROM folders WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, id)
      .first<FolderRow>(),
  ]);
  if (!access || !folder) {
    throw new TrashRequestError(404, 'NOT_FOUND', 'Folder not found');
  }
  if (folder.deleted_at === null) {
    throw new TrashRequestError(409, 'NOT_IN_TRASH', 'Folder is not in Trash');
  }
  if (!canRestoreTargetItem(user, 'folder', access.effectiveRole)) {
    throw new TrashRequestError(403, 'FORBIDDEN', 'Forbidden');
  }

  const originalLocation = await buildRestoreDestinationContext(
    db,
    user,
    folder.parent_id
  );
  if (!originalLocation) {
    throw new TrashRequestError(404, 'NOT_FOUND', 'Original parent not found');
  }

  const destination = target?.provided
    ? await buildRestoreDestinationContext(db, user, target.parentId)
    : originalLocation;
  if (!destination) {
    throw new TrashRequestError(404, 'TARGET_NOT_FOUND', 'Destination folder not found');
  }

  const suggestedName = destination.accessible
    ? await suggestedFolderRestoreName(
        db,
        user.tenantId,
        destination.id,
        folder.name,
        folder.id
      )
    : null;
  const floor = destination.classification;
  const upgradeCount = await countFolderSubtreeClassificationUpgrades(
    db,
    user.tenantId,
    folder.id,
    folder.deleted_at,
    floor
  );

  let circular = false;
  let maxDepthExceeded = false;
  if (target?.provided && destination.id !== null) {
    circular = await isFolderWithinSubtree(
      db,
      user.tenantId,
      folder.id,
      destination.id
    );
    if (!circular && destination.id !== folder.parent_id) {
      const subtreeDepth = await folderSubtreeMaxDepth(
        db,
        user.tenantId,
        folder.id
      );
      const destinationChain = await loadFolderChain(
        db,
        user.tenantId,
        destination.id
      );
      const destinationDepth =
        destinationChain[destinationChain.length - 1]?.depth ?? 0;
      maxDepthExceeded =
        destinationDepth + 1 + subtreeDepth > MAX_FOLDER_DEPTH;
    }
  }

  return {
    type: 'folder',
    item: {
      id: folder.id,
      type: 'folder',
      name: folder.name,
      classification: folder.classification,
      folderId: null,
      parentId: originalLocation.accessible ? folder.parent_id : null,
    },
    itemEffectiveRole: access.effectiveRole,
    originalLocation,
    destination,
    conflict: { hasConflict: suggestedName !== null, suggestedName },
    classification: {
      floor,
      willUpgrade: upgradeCount > 0,
      upgradeCount,
    },
    restoreParentChainAvailable: originalLocation.deletedAncestorCount > 0,
    restoreParentChainDefault: originalLocation.deletedAncestorCount > 0,
    destinationChecks: {
      circular,
      maxDepthExceeded,
      targetDeleted: destination.isDeleted,
      canRestoreToRoot:
        folder.parent_id === null ||
        hasAtLeastRole(access.effectiveRole, 'owner'),
    },
  };
}

/** Present a chain rename suggestion on ancestor conflicts. */
export async function resolveAncestorRestoreName(
  db: D1Database,
  tenantId: string,
  parentId: string | null,
  name: string,
  folderId: string
): Promise<string | null> {
  if (!(await hasDuplicateFolderName(db, tenantId, parentId, name, folderId))) {
    return null;
  }
  return resolveUniqueRestoredName(db, tenantId, parentId, name);
}
