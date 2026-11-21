import { checkCapabilityGuard, checkClassificationFloorGuard, type MutationOutbox } from '@/lib/mutation-outbox';
import { getExtensionFromName } from '@/lib/formatters';
import type { DirectoryViewModel } from '@/lib/sync-store/cache';
import type { UndoAction } from '@/lib/sync-store/toasts';
import type {
  AuthUser,
  ClassificationLabel,
  FileItem,
  ResourceRole,
} from '@/types/files';

export interface OptimisticFileContext {
  filesById: Map<string, FileItem>;
  userRole: AuthUser['role'] | undefined;
  outbox: MutationOutbox;
  now: () => number;
  getDirectoryView: (folderId: string | null) => DirectoryViewModel;
  getAncestorClassifications: (
    folderId: string | null
  ) => ClassificationLabel[];
  upsertFileInCache: (file: FileItem) => void;
  removeFileFromCache: (fileId: string, folderId: string | null) => void;
  pushUndo: (entry: Omit<UndoAction, 'id'>, message: string) => void;
  restoreFile: (file: FileItem) => void;
}

function makeClientMutationId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export function optimisticRenameFile(
  ctx: OptimisticFileContext,
  file: FileItem,
  nextName: string,
  effectiveRole: ResourceRole,
  options?: { skipUndo?: boolean }
): { ok: boolean; error?: string } {
  if (file.upload_state === 'pending' || file.optimistic) {
    return { ok: false, error: 'アップロード完了後に名前を変更できます' };
  }
  const trimmed = nextName.trim();
  if (!trimmed) {
    return { ok: false, error: 'ファイル名を入力してください' };
  }
  if (trimmed === file.name) {
    return { ok: true };
  }

  const roleCheck = checkCapabilityGuard(effectiveRole, 'item.rename');
  if (!roleCheck.ok) {
    return { ok: false, error: roleCheck.message };
  }

  const dirView = ctx.getDirectoryView(file.folder_id);
  if (
    dirView.files.some(
      (f) => f.id !== file.id && f.name === trimmed && f.deleted_at == null
    )
  ) {
    return {
      ok: false,
      error: `同名ファイル「${trimmed}」がすでに存在します`,
    };
  }

  const prevFile: FileItem = { ...file };
  const nextExt = getExtensionFromName(trimmed) || null;
  const updated: FileItem = {
    ...file,
    name: trimmed,
    extension: nextExt,
    updated_at: new Date(ctx.now()).toISOString(),
  };

  ctx.upsertFileInCache(updated);
  if (!options?.skipUndo) {
    ctx.pushUndo(
      {
        label: `「${trimmed}」の名前変更を取り消す`,
        applyUndo: () => {
          const current = ctx.filesById.get(updated.id) ?? updated;
          optimisticRenameFile(
            ctx,
            current,
            prevFile.name,
            effectiveRole,
            { skipUndo: true }
          );
        },
        redoLabel: `「${trimmed}」への名前変更をやり直す`,
        applyRedo: () => {
          const current = ctx.filesById.get(updated.id) ?? prevFile;
          optimisticRenameFile(
            ctx,
            current,
            trimmed,
            effectiveRole,
            { skipUndo: true }
          );
        },
      },
      `ファイル名を「${trimmed}」に変更しました`
    );
  }

  ctx.outbox.enqueue({
    id: makeClientMutationId('mut'),
    entityType: 'file',
    entityId: file.id,
    kind: 'file.patch',
    payload: { name: trimmed },
    expectedVersion: file.meta_version,
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      file: prevFile,
      existedBefore: true,
      parentId: file.folder_id,
    },
  });

  return { ok: true };
}

export function optimisticSoftDeleteFile(
  ctx: OptimisticFileContext,
  file: FileItem,
  folderId: string | null,
  effectiveRole: ResourceRole,
  options?: { skipUndo?: boolean }
): { ok: boolean; error?: string } {
  if (file.upload_state === 'pending' || file.optimistic) {
    return { ok: false, error: 'アップロード完了後に削除できます' };
  }
  const roleCheck = checkCapabilityGuard(effectiveRole, 'item.delete');
  if (!roleCheck.ok) {
    return { ok: false, error: roleCheck.message };
  }

  const prevFile: FileItem = { ...file };
  ctx.removeFileFromCache(file.id, folderId);

  if (!options?.skipUndo) {
    ctx.pushUndo(
      {
        label: `「${file.name}」の削除を取り消す`,
        applyUndo: () => {
          ctx.restoreFile(prevFile);
        },
      },
      `「${file.name}」をゴミ箱へ移動しました`
    );
  }

  ctx.outbox.enqueue({
    id: makeClientMutationId('mut'),
    entityType: 'file',
    entityId: file.id,
    kind: 'file.soft_delete',
    payload: { folderId },
    expectedVersion: file.meta_version,
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      file: prevFile,
      existedBefore: true,
      parentId: folderId,
    },
  });

  return { ok: true };
}

export function optimisticRestoreFile(
  ctx: OptimisticFileContext,
  file: FileItem
): void {
  const restored: FileItem = {
    ...file,
    deleted_at: null,
    updated_at: new Date(ctx.now()).toISOString(),
  };
  ctx.upsertFileInCache(restored);
  ctx.outbox.enqueue({
    id: makeClientMutationId('mut'),
    entityType: 'file',
    entityId: file.id,
    kind: 'file.restore',
    payload: { folderId: file.folder_id },
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      file,
      existedBefore: false,
      parentId: file.folder_id,
    },
  });
}

export function optimisticUpdateFileClassification(
  ctx: OptimisticFileContext,
  file: FileItem,
  next:
    | { acceptSuggestion: true }
    | { classification: Exclude<ClassificationLabel, 'unset'> },
  options?: {
    effectiveRole?: ResourceRole;
    isPrivilegedAdmin?: boolean;
    skipUndo?: boolean;
  }
): { ok: boolean; error?: string; file?: FileItem } {
  if (file.upload_state === 'pending' || file.optimistic) {
    return {
      ok: false,
      error: 'アップロード完了後に機密区分を変更できます',
    };
  }

  const dirView = ctx.getDirectoryView(file.folder_id);
  const role = options?.effectiveRole ?? dirView.effectiveRole;
  const isAdmin =
    options?.isPrivilegedAdmin ??
    (ctx.userRole === 'sec_admin' || ctx.userRole === 'sys_admin');

  const roleCheck = checkCapabilityGuard(role, 'classification.edit', {
    isPrivilegedAdmin: isAdmin,
    allowAdminOverride: true,
  });
  if (!roleCheck.ok) {
    return { ok: false, error: roleCheck.message };
  }

  let targetLabel: Exclude<ClassificationLabel, 'unset'>;
  if ('acceptSuggestion' in next) {
    if (!file.ai_suggested_label || file.ai_suggested_label === 'unset') {
      return {
        ok: false,
        error: '承認可能な AI 分類提案がありません',
      };
    }
    targetLabel = file.ai_suggested_label;
  } else {
    targetLabel = next.classification;
  }

  const ancestorLabels = ctx.getAncestorClassifications(file.folder_id);
  const floorCheck = checkClassificationFloorGuard(
    ancestorLabels,
    targetLabel
  );
  if (!floorCheck.ok) {
    return { ok: false, error: floorCheck.message };
  }

  const prevFile: FileItem = { ...file };
  const updated: FileItem = {
    ...file,
    classification: targetLabel,
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: new Date(ctx.now()).toISOString(),
  };

  ctx.upsertFileInCache(updated);
  if (!options?.skipUndo && prevFile.classification !== 'unset') {
    const revertLabel = prevFile.classification;
    ctx.pushUndo(
      {
        label: `「${file.name}」の機密区分変更を取り消す`,
        applyUndo: () => {
          const current = ctx.filesById.get(updated.id) ?? updated;
          optimisticUpdateFileClassification(
            ctx,
            current,
            { classification: revertLabel },
            {
              effectiveRole: role,
              isPrivilegedAdmin: isAdmin,
              skipUndo: true,
            }
          );
        },
      },
      `「${file.name}」の機密区分を ${targetLabel} に変更しました`
    );
  }

  ctx.outbox.enqueue({
    id: makeClientMutationId('mut'),
    entityType: 'file',
    entityId: file.id,
    kind: 'file.classification',
    payload:
      'acceptSuggestion' in next
        ? { acceptSuggestion: true }
        : { classification: targetLabel },
    expectedVersion: file.meta_version,
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      file: prevFile,
      existedBefore: true,
      parentId: file.folder_id,
    },
  });

  return { ok: true, file: updated };
}
