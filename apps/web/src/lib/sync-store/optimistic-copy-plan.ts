import {
  allocateCopyDisplayName,
  getExtensionFromName,
  hasRoleAtLeast,
  pickStricterClassification,
} from '@/lib/formatters';
import { checkRoleGuard } from '@/lib/mutation-outbox';
import type {
  ClassificationLabel,
  FileItem,
  FolderSummary,
  ResourceRole,
  WorkspaceConflictPolicy,
} from '@/types/files';
import type { DestinationNameSets } from './optimistic-move-plan';

export interface CopyPlanningContext {
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
  nextId: (prefix: string) => string;
}

export type CopyPlan =
  | { ok: false; error: string; tempIds: string[] }
  | {
      ok: true;
      nowIso: string;
      mutationId: string;
      tempFolderIds: string[];
      tempFileIds: string[];
      tempFolders: FolderSummary[];
      tempFiles: FileItem[];
      apiItems: Array<{ type: 'file' | 'folder'; id: string }>;
      involvedEntityKeys: string[];
      totalCount: number;
      duplicateInPlace: boolean;
      conflictPolicy: WorkspaceConflictPolicy;
    };

export function planOptimisticCopy(
  input: {
    items: Array<{ type: 'file' | 'folder'; id: string }>;
    targetParentId: string | null;
    mode?: 'copy' | 'duplicate';
    conflictPolicy?: WorkspaceConflictPolicy;
  },
  ctx: CopyPlanningContext
): CopyPlan {
  const mode = input.mode ?? 'copy';
  const duplicateInPlace = mode === 'duplicate';
  const targetParentId = input.targetParentId;
  const conflictPolicy: WorkspaceConflictPolicy =
    input.conflictPolicy ?? 'rename';

  const deduped = new Map<string, { type: 'file' | 'folder'; id: string }>();
  for (const raw of input.items) {
    const resolvedId = ctx.idAliasMap.get(raw.id) ?? raw.id;
    deduped.set(`${raw.type}:${resolvedId}`, {
      type: raw.type,
      id: resolvedId,
    });
  }
  if (deduped.size === 0) {
    return { ok: false, error: 'コピーするアイテムを選択してください', tempIds: [] };
  }

  const srcFolders: FolderSummary[] = [];
  const srcFiles: FileItem[] = [];
  for (const ref of deduped.values()) {
    if (ref.type === 'folder') {
      const f = ctx.foldersById.get(ref.id);
      if (!f || f.deleted_at != null) {
        return {
          ok: false,
          error: 'コピー元のフォルダが見つかりません',
          tempIds: [],
        };
      }
      if (f.optimistic) {
        return {
          ok: false,
          error: 'フォルダ作成完了後にコピーできます',
          tempIds: [],
        };
      }
      srcFolders.push(f);
    } else {
      const fl = ctx.filesById.get(ref.id);
      if (!fl || fl.deleted_at != null) {
        return {
          ok: false,
          error: 'コピー元のファイルが見つかりません',
          tempIds: [],
        };
      }
      if (fl.upload_state === 'pending' || fl.optimistic) {
        return {
          ok: false,
          error: 'アップロード完了後にコピーできます',
          tempIds: [],
        };
      }
      srcFiles.push(fl);
    }
  }

  // Prune redundant selected descendants
  const selectedFolderIds = new Set(srcFolders.map((f) => f.id));
  const rootFolders = srcFolders.filter(
    (f) =>
      !Array.from(selectedFolderIds).some(
        (otherId) =>
          otherId !== f.id && ctx.isFolderAncestorOf(otherId, f.id)
      )
  );
  const rootFiles = srcFiles.filter(
    (fl) =>
      fl.folder_id === null ||
      (!selectedFolderIds.has(fl.folder_id) &&
        !Array.from(selectedFolderIds).some((ancId) =>
          ctx.isFolderAncestorOf(ancId, fl.folder_id)
        ))
  );

  // Zero-Trust DLP client guardrail: viewer+ required on source (previewer blocked at 0ms)
  for (const f of rootFolders) {
    const role = ctx.resolveItemEffectiveRole('folder', f);
    if (!hasRoleAtLeast(role, 'viewer') && ctx.userRole !== 'sys_admin') {
      return {
        ok: false,
        error: 'Previewer 権限のフォルダはコピーできません (DLP 保護)',
        tempIds: [],
      };
    }
  }
  for (const fl of rootFiles) {
    const role = ctx.resolveItemEffectiveRole('file', fl);
    if (!hasRoleAtLeast(role, 'viewer') && ctx.userRole !== 'sys_admin') {
      return {
        ok: false,
        error: 'Previewer 権限のファイルはコピーできません (DLP 保護)',
        tempIds: [],
      };
    }
  }

  if (!duplicateInPlace) {
    const destRole = checkRoleGuard(ctx.destinationRole, 'editor', {
      isPrivilegedAdmin: ctx.userRole === 'sys_admin',
      allowAdminOverride: true,
    });
    if (!destRole.ok) {
      return { ok: false, error: destRole.message, tempIds: [] };
    }
  }

  const namesCache = new Map<string, DestinationNameSets>();
  const getDestNames = (parentId: string | null) => {
    const key = parentId ?? '__ROOT__';
    let entry = namesCache.get(key);
    if (!entry) {
      entry = ctx.getDestinationNames(parentId);
      namesCache.set(key, entry);
    }
    return entry;
  };

  const nowIso = new Date(ctx.now()).toISOString();
  const mutationId = ctx.nextId('mut');
  const tempFolderIds: string[] = [];
  const tempFileIds: string[] = [];
  const tempFolders: FolderSummary[] = [];
  const tempFiles: FileItem[] = [];
  const apiItems: Array<{ type: 'file' | 'folder'; id: string }> = [];
  const involvedEntityKeys: string[] = [];

  for (const f of rootFolders) {
    const destParentId = duplicateInPlace ? f.parent_id : targetParentId;
    const destNames = getDestNames(destParentId);
    if (
      conflictPolicy === 'fail' &&
      !duplicateInPlace &&
      destNames.existsInCache &&
      destNames.folderNames.has(f.name)
    ) {
      return {
        ok: false,
        error: `コピー先に同名フォルダ「${f.name}」がすでに存在します`,
        tempIds: [],
      };
    }
    const nextName = allocateCopyDisplayName(
      f.name,
      'folder',
      destNames.folderNames
    );
    const destFloor: ClassificationLabel =
      ctx.getAncestorClassifications(destParentId).includes('confidential')
        ? 'confidential'
        : 'unset';
    const tempId = ctx.nextId('tmp-copy-folder');
    tempFolderIds.push(tempId);
    tempFolders.push({
      id: tempId,
      parent_id: destParentId,
      name: nextName,
      classification: pickStricterClassification(f.classification, destFloor),
      is_pinned: 0,
      version: 1,
      updated_at: nowIso,
      effectiveRole: 'owner',
      optimistic: true,
    });
    apiItems.push({ type: 'folder', id: f.id });
    involvedEntityKeys.push(`folder:${f.id}`);
  }

  for (const fl of rootFiles) {
    const destParentId = duplicateInPlace ? fl.folder_id : targetParentId;
    const destNames = getDestNames(destParentId);
    if (
      conflictPolicy === 'fail' &&
      !duplicateInPlace &&
      destNames.existsInCache &&
      destNames.fileNames.has(fl.name)
    ) {
      return {
        ok: false,
        error: `コピー先に同名ファイル「${fl.name}」がすでに存在します`,
        tempIds: [],
      };
    }
    const nextName = allocateCopyDisplayName(
      fl.name,
      'file',
      destNames.fileNames
    );
    const destFloor: ClassificationLabel =
      ctx.getAncestorClassifications(destParentId).includes('confidential')
        ? 'confidential'
        : 'unset';
    const tempId = ctx.nextId('tmp-copy-file');
    tempFileIds.push(tempId);
    tempFiles.push({
      id: tempId,
      folder_id: destParentId,
      name: nextName,
      extension: getExtensionFromName(nextName) || fl.extension,
      mime_type: fl.mime_type,
      size_bytes: fl.size_bytes,
      current_version_num: 1,
      meta_version: 1,
      classification: pickStricterClassification(fl.classification, destFloor),
      ai_suggested_label: null,
      ai_confidence: null,
      ai_reason: null,
      updated_at: nowIso,
      upload_state: 'active',
      optimistic: true,
    });
    apiItems.push({ type: 'file', id: fl.id });
    involvedEntityKeys.push(`file:${fl.id}`);
  }

  return {
    ok: true,
    nowIso,
    mutationId,
    tempFolderIds,
    tempFileIds,
    tempFolders,
    tempFiles,
    apiItems,
    involvedEntityKeys,
    totalCount: tempFolderIds.length + tempFileIds.length,
    duplicateInPlace,
    conflictPolicy,
  };
}
