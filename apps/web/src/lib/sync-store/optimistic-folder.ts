import { isClassificationFloorViolated } from '@/lib/formatters';
import { checkRoleGuard, type MutationOutbox } from '@/lib/mutation-outbox';
import type { DirectoryViewModel } from '@/lib/sync-store/cache';
import type { UndoAction } from '@/lib/sync-store/toasts';
import type {
  ClassificationLabel,
  FolderSummary,
} from '@/types/files';

export interface OptimisticFolderContext {
  foldersById: Map<string, FolderSummary>;
  outbox: MutationOutbox;
  now: () => number;
  getDirectoryView: (folderId: string | null) => DirectoryViewModel;
  getAncestorClassifications: (
    folderId: string | null
  ) => ClassificationLabel[];
  upsertFolderInCache: (folder: FolderSummary) => void;
  removeFolderFromCache: (folder: FolderSummary) => void;
  pushUndo: (entry: Omit<UndoAction, 'id'>, message: string) => void;
  restoreFolder: (
    folder: FolderSummary,
    conflictPolicy?: 'fail' | 'rename'
  ) => void;
}

export function makeClientMutationId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
}

export function optimisticCreateFolder(
  ctx: OptimisticFolderContext,
  input: {
    parentId: string | null;
    name: string;
    classification: ClassificationLabel;
    isPinned?: boolean;
  }
): { ok: boolean; error?: string; tempId?: string } {
  const name = input.name.trim();
  if (!name) {
    return { ok: false, error: 'フォルダ名を入力してください' };
  }

  const parentRole = ctx.getDirectoryView(input.parentId).effectiveRole;
  const roleCheck = checkRoleGuard(parentRole, 'editor');
  if (!roleCheck.ok) {
    return { ok: false, error: roleCheck.message };
  }

  const parentView = ctx.getDirectoryView(input.parentId);
  if (
    parentView.folders.some(
      (f) => f.name === name && f.deleted_at == null
    )
  ) {
    return {
      ok: false,
      error: `同名フォルダ「${name}」がすでに存在します`,
    };
  }

  const tempId = makeClientMutationId('tmp-folder');
  const nowIso = new Date(ctx.now()).toISOString();
  const effectiveClassification = isClassificationFloorViolated(
    ctx.getAncestorClassifications(input.parentId),
    input.classification
  )
    ? 'confidential'
    : input.classification;

  const tempFolder: FolderSummary = {
    id: tempId,
    parent_id: input.parentId,
    name,
    classification: effectiveClassification,
    is_pinned: input.isPinned ? 1 : 0,
    version: 1,
    updated_at: nowIso,
    effectiveRole: 'owner',
    optimistic: true,
  };

  ctx.upsertFolderInCache(tempFolder);
  ctx.outbox.enqueue({
    id: makeClientMutationId('mut'),
    entityType: 'folder',
    entityId: tempId,
    kind: 'folder.create',
    payload: {
      parentId: input.parentId,
      name,
      classification: effectiveClassification,
      isPinned: Boolean(input.isPinned),
    },
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      existedBefore: false,
      parentId: input.parentId,
    },
  });
  return { ok: true, tempId };
}

export function optimisticRenameFolder(
  ctx: OptimisticFolderContext,
  folder: FolderSummary,
  nextName: string,
  options?: { skipUndo?: boolean }
): { ok: boolean; error?: string } {
  const trimmed = nextName.trim();
  if (!trimmed) {
    return { ok: false, error: 'フォルダ名を入力してください' };
  }
  if (trimmed === folder.name) {
    return { ok: true };
  }

  const parentView = ctx.getDirectoryView(folder.parent_id);
  const effectiveRole = folder.effectiveRole ?? parentView.effectiveRole;
  const roleCheck = checkRoleGuard(effectiveRole, 'editor');
  if (!roleCheck.ok) {
    return { ok: false, error: roleCheck.message };
  }
  if (
    parentView.folders.some(
      (f) =>
        f.id !== folder.id &&
        f.name === trimmed &&
        f.deleted_at == null
    )
  ) {
    return {
      ok: false,
      error: `同名フォルダ「${trimmed}」がすでに存在します`,
    };
  }

  const prevFolder: FolderSummary = { ...folder };
  const updated: FolderSummary = {
    ...folder,
    name: trimmed,
    updated_at: new Date(ctx.now()).toISOString(),
  };

  ctx.upsertFolderInCache(updated);
  if (!options?.skipUndo) {
    ctx.pushUndo(
      {
        label: `「${trimmed}」の名前変更を取り消す`,
        applyUndo: () => {
          const current = ctx.foldersById.get(updated.id) ?? updated;
          optimisticRenameFolder(ctx, current, prevFolder.name, {
            skipUndo: true,
          });
        },
      },
      `フォルダ名を「${trimmed}」に変更しました`
    );
  }

  ctx.outbox.enqueue({
    id: makeClientMutationId('mut'),
    entityType: 'folder',
    entityId: folder.id,
    kind: 'folder.patch',
    payload: { name: trimmed },
    expectedVersion: folder.version,
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      folder: prevFolder,
      existedBefore: true,
      parentId: folder.parent_id,
    },
  });

  return { ok: true };
}

export function optimisticToggleFolderPin(
  ctx: OptimisticFolderContext,
  folder: FolderSummary,
  options?: { skipUndo?: boolean }
): { ok: boolean; error?: string } {
  const parentView = ctx.getDirectoryView(folder.parent_id);
  const effectiveRole = folder.effectiveRole ?? parentView.effectiveRole;
  const roleCheck = checkRoleGuard(effectiveRole, 'editor');
  if (!roleCheck.ok) {
    return { ok: false, error: roleCheck.message };
  }

  const prevFolder: FolderSummary = { ...folder };
  const nextPinned = folder.is_pinned === 1 ? 0 : 1;
  const updated: FolderSummary = {
    ...folder,
    is_pinned: nextPinned,
    updated_at: new Date(ctx.now()).toISOString(),
  };

  ctx.upsertFolderInCache(updated);
  if (!options?.skipUndo) {
    ctx.pushUndo(
      {
        label: 'ピン留め変更を取り消す',
        applyUndo: () => {
          const current = ctx.foldersById.get(updated.id) ?? updated;
          optimisticToggleFolderPin(ctx, current, { skipUndo: true });
        },
      },
      nextPinned === 1
        ? `「${folder.name}」をピン留めしました`
        : `「${folder.name}」のピン留めを解除しました`
    );
  }

  ctx.outbox.enqueue({
    id: makeClientMutationId('mut'),
    entityType: 'folder',
    entityId: folder.id,
    kind: 'folder.patch',
    payload: { isPinned: nextPinned === 1 },
    expectedVersion: folder.version,
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      folder: prevFolder,
      existedBefore: true,
      parentId: folder.parent_id,
    },
  });

  return { ok: true };
}

export function optimisticSoftDeleteFolder(
  ctx: OptimisticFolderContext,
  folder: FolderSummary,
  options?: { skipUndo?: boolean }
): { ok: boolean; error?: string } {
  const parentView = ctx.getDirectoryView(folder.parent_id);
  const effectiveRole = folder.effectiveRole ?? parentView.effectiveRole;
  const roleCheck = checkRoleGuard(effectiveRole, 'editor');
  if (!roleCheck.ok) {
    return { ok: false, error: roleCheck.message };
  }

  const prevFolder: FolderSummary = { ...folder };
  ctx.removeFolderFromCache(folder);

  if (!options?.skipUndo) {
    ctx.pushUndo(
      {
        label: `「${folder.name}」の削除を取り消す`,
        applyUndo: () => {
          ctx.restoreFolder(prevFolder);
        },
      },
      `「${folder.name}」をゴミ箱へ移動しました`
    );
  }

  ctx.outbox.enqueue({
    id: makeClientMutationId('mut'),
    entityType: 'folder',
    entityId: folder.id,
    kind: 'folder.soft_delete',
    payload: {},
    expectedVersion: folder.version,
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      folder: prevFolder,
      existedBefore: true,
      parentId: folder.parent_id,
    },
  });

  return { ok: true };
}

export function optimisticRestoreFolder(
  ctx: OptimisticFolderContext,
  folder: FolderSummary,
  conflictPolicy: 'fail' | 'rename' = 'rename'
): void {
  const restored: FolderSummary = {
    ...folder,
    deleted_at: null,
    updated_at: new Date(ctx.now()).toISOString(),
  };
  ctx.upsertFolderInCache(restored);
  ctx.outbox.enqueue({
    id: makeClientMutationId('mut'),
    entityType: 'folder',
    entityId: folder.id,
    kind: 'folder.restore',
    payload: { conflictPolicy, parentId: folder.parent_id },
    createdAt: ctx.now(),
    retryCount: 0,
    rollback: {
      folder,
      existedBefore: false,
      parentId: folder.parent_id,
    },
  });
}
