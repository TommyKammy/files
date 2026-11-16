import { allocateCopyDisplayName, getExtensionFromName } from '@/lib/formatters';
import { checkRoleGuard } from '@/lib/mutation-outbox';
import type {
  ClassificationLabel,
  FileItem,
  FolderSummary,
  ResourceRole,
  WorkspaceBatchItemRef,
  WorkspaceConflictPolicy,
} from '@/types/files';

export interface DestinationNameSets {
  existsInCache: boolean;
  folderNames: Set<string>;
  fileNames: Set<string>;
}

export interface MovePlanningContext {
  idAliasMap: Map<string, string>;
  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  userRole: string | undefined;
  isFolderAncestorOf: (
    ancestorId: string,
    descendantId: string | null
  ) => boolean;
  resolveItemEffectiveRole: (
    type: 'file' | 'folder',
    item: FolderSummary | FileItem
  ) => ResourceRole;
  getDestinationNames: (parentId: string | null) => DestinationNameSets;
  destinationRole: ResourceRole;
  getAncestorClassifications: (folderId: string | null) => ClassificationLabel[];
  now: () => number;
}

export interface PlannedMoveFolder {
  prev: FolderSummary;
  targetName: string;
}

export interface PlannedMoveFile {
  prev: FileItem;
  targetName: string;
  targetExt: string | null;
}

export type MovePlan =
  | { ok: false; error: string; movedCount: 0; skippedCount: 0 }
  | {
      ok: true;
      movedCount: number;
      skippedCount: number;
      foldersToMove: PlannedMoveFolder[];
      filesToMove: PlannedMoveFile[];
      nowIso: string;
      destFloor: ClassificationLabel;
      batchRefs: WorkspaceBatchItemRef[];
      involvedEntityKeys: string[];
    };

export function planOptimisticMove(
  input: {
    items: Array<{ type: 'file' | 'folder'; id: string }>;
    targetParentId: string | null;
    conflictPolicy?: WorkspaceConflictPolicy;
  },
  ctx: MovePlanningContext
): MovePlan {
  const targetParentId = input.targetParentId;
  const conflictPolicy: WorkspaceConflictPolicy =
    input.conflictPolicy ?? 'fail';

  // Dedupe references and resolve temp aliases
  const deduped = new Map<string, { type: 'file' | 'folder'; id: string }>();
  for (const raw of input.items) {
    const resolvedId = ctx.idAliasMap.get(raw.id) ?? raw.id;
    deduped.set(`${raw.type}:${resolvedId}`, {
      type: raw.type,
      id: resolvedId,
    });
  }
  if (deduped.size === 0) {
    return {
      ok: false,
      error: '移動するアイテムを選択してください',
      movedCount: 0,
      skippedCount: 0,
    };
  }

  const resolvedFolders: FolderSummary[] = [];
  const resolvedFiles: FileItem[] = [];

  for (const ref of deduped.values()) {
    if (ref.type === 'folder') {
      const folder = ctx.foldersById.get(ref.id);
      if (!folder || folder.deleted_at != null) {
        return {
          ok: false,
          error: '移動対象のフォルダが見つかりません',
          movedCount: 0,
          skippedCount: 0,
        };
      }
      if (folder.optimistic) {
        return {
          ok: false,
          error: '作成完了後に移動できます',
          movedCount: 0,
          skippedCount: 0,
        };
      }
      resolvedFolders.push(folder);
    } else {
      const file = ctx.filesById.get(ref.id);
      if (!file || file.deleted_at != null) {
        return {
          ok: false,
          error: '移動対象のファイルが見つかりません',
          movedCount: 0,
          skippedCount: 0,
        };
      }
      if (file.upload_state === 'pending' || file.optimistic) {
        return {
          ok: false,
          error: 'アップロード完了後に移動できます',
          movedCount: 0,
          skippedCount: 0,
        };
      }
      resolvedFiles.push(file);
    }
  }

  // Prune redundant descendants when an ancestor folder is also selected
  const selectedFolderIds = new Set(resolvedFolders.map((f) => f.id));
  const rootFolders = resolvedFolders.filter(
    (folder) =>
      !Array.from(selectedFolderIds).some(
        (otherId) =>
          otherId !== folder.id &&
          ctx.isFolderAncestorOf(otherId, folder.id)
      )
  );
  const rootFiles = resolvedFiles.filter(
    (file) =>
      file.folder_id === null ||
      (!selectedFolderIds.has(file.folder_id) &&
        !Array.from(selectedFolderIds).some((ancId) =>
          ctx.isFolderAncestorOf(ancId, file.folder_id)
        ))
  );

  const destNames = ctx.getDestinationNames(targetParentId);
  if (destNames.existsInCache) {
    const destRole = checkRoleGuard(ctx.destinationRole, 'editor', {
        isPrivilegedAdmin: ctx.userRole === 'sys_admin',
        allowAdminOverride: true,
      }
    );
    if (!destRole.ok) {
      return {
        ok: false,
        error: destRole.message,
        movedCount: 0,
        skippedCount: 0,
      };
    }
  }

  let skippedCount = 0;
  const foldersToMove: Array<{ prev: FolderSummary; targetName: string }> = [];
  const filesToMove: Array<{
    prev: FileItem;
    targetName: string;
    targetExt: string | null;
  }> = [];

  for (const folder of rootFolders) {
    if (folder.parent_id === targetParentId) {
      skippedCount += 1;
      continue;
    }
    if (
      folder.id === targetParentId ||
      ctx.isFolderAncestorOf(folder.id, targetParentId)
    ) {
      return {
        ok: false,
        error: '自分自身または配下のフォルダには移動できません',
        movedCount: 0,
        skippedCount: 0,
      };
    }
    const role = ctx.resolveItemEffectiveRole('folder', folder);
    const roleCheck = checkRoleGuard(role, 'editor', {
      isPrivilegedAdmin: ctx.userRole === 'sys_admin',
      allowAdminOverride: true,
    });
    if (!roleCheck.ok) {
      return {
        ok: false,
        error: roleCheck.message,
        movedCount: 0,
        skippedCount: 0,
      };
    }
    if (targetParentId === null && folder.parent_id !== null) {
      const rootOwnerCheck = checkRoleGuard(role, 'owner', {
        isPrivilegedAdmin: ctx.userRole === 'sys_admin',
        allowAdminOverride: true,
      });
      if (!rootOwnerCheck.ok) {
        return {
          ok: false,
          error: 'ルートへ移動するには Owner 権限が必要です',
          movedCount: 0,
          skippedCount: 0,
        };
      }
    }

    let targetName = folder.name;
    if (destNames.existsInCache && destNames.folderNames.has(targetName)) {
      if (conflictPolicy === 'fail') {
        return {
          ok: false,
          error: `移動先に同名フォルダ「${targetName}」がすでに存在します`,
          movedCount: 0,
          skippedCount: 0,
        };
      }
      targetName = allocateCopyDisplayName(
        targetName,
        'folder',
        destNames.folderNames
      );
    } else {
      destNames.folderNames.add(targetName);
    }

    foldersToMove.push({ prev: { ...folder }, targetName });
  }

  for (const file of rootFiles) {
    if (file.folder_id === targetParentId) {
      skippedCount += 1;
      continue;
    }
    const role = ctx.resolveItemEffectiveRole('file', file);
    const roleCheck = checkRoleGuard(role, 'editor', {
      isPrivilegedAdmin: ctx.userRole === 'sys_admin',
      allowAdminOverride: true,
    });
    if (!roleCheck.ok) {
      return {
        ok: false,
        error: roleCheck.message,
        movedCount: 0,
        skippedCount: 0,
      };
    }

    let targetName = file.name;
    if (destNames.existsInCache && destNames.fileNames.has(targetName)) {
      if (conflictPolicy === 'fail') {
        return {
          ok: false,
          error: `移動先に同名ファイル「${targetName}」がすでに存在します`,
          movedCount: 0,
          skippedCount: 0,
        };
      }
      targetName = allocateCopyDisplayName(
        targetName,
        'file',
        destNames.fileNames
      );
    } else {
      destNames.fileNames.add(targetName);
    }
    const targetExt = getExtensionFromName(targetName) || null;
    filesToMove.push({ prev: { ...file }, targetName, targetExt });
  }

  const movedCount = foldersToMove.length + filesToMove.length;
  const nowIso = new Date(ctx.now()).toISOString();
  const destAncestors = ctx.getAncestorClassifications(targetParentId);
  const destFloor: ClassificationLabel = destAncestors.includes('confidential')
    ? 'confidential'
    : 'unset';

  const batchRefs: WorkspaceBatchItemRef[] = [];
  const involvedEntityKeys: string[] = [];
  for (const { prev } of foldersToMove) {
    batchRefs.push({
      type: 'folder',
      id: prev.id,
      expectedVersion: prev.version,
    });
    involvedEntityKeys.push(`folder:${prev.id}`);
  }
  for (const { prev } of filesToMove) {
    batchRefs.push({
      type: 'file',
      id: prev.id,
      expectedVersion: prev.meta_version,
    });
    involvedEntityKeys.push(`file:${prev.id}`);
  }

  return {
    ok: true,
    movedCount,
    skippedCount,
    foldersToMove,
    filesToMove,
    nowIso,
    destFloor,
    batchRefs,
    involvedEntityKeys,
  };
}
