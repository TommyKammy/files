import { getExtensionFromName } from '@/lib/formatters';
import type { PersistedDirectoryRecord } from '@/lib/sync-idb';
import type {
  ClassificationLabel,
  FileItem,
} from '@/types/files';

export interface OptimisticUploadContext {
  filesById: Map<string, FileItem>;
  directoriesByKey: Map<string, PersistedDirectoryRecord>;
  now: () => number;
  emit: () => void;
  upsertFileInCache: (file: FileItem) => void;
  getAncestorClassifications: (
    folderId: string | null
  ) => ClassificationLabel[];
}

function dirKeyForFolder(folderId: string | null): string {
  return folderId ?? '__ROOT__';
}

function removeFromIdList(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : list;
}

export function startOptimisticUpload(
  ctx: OptimisticUploadContext,
  folderId: string | null,
  tempId: string,
  meta: { name: string; mimeType: string; sizeBytes: number }
): void {
  const ancestorLabels = ctx.getAncestorClassifications(folderId);
  const defaultLabel: ClassificationLabel = ancestorLabels.includes(
    'confidential'
  )
    ? 'confidential'
    : 'unset';

  const pendingRow: FileItem = {
    id: tempId,
    folder_id: folderId,
    name: meta.name,
    extension: getExtensionFromName(meta.name) || null,
    mime_type: meta.mimeType,
    size_bytes: meta.sizeBytes,
    current_version_num: 1,
    meta_version: 1,
    classification: defaultLabel,
    ai_suggested_label: null,
    ai_confidence: null,
    ai_reason: null,
    updated_at: new Date(ctx.now()).toISOString(),
    upload_state: 'pending',
    upload_progress: 0,
    optimistic: true,
  };

  ctx.filesById.set(tempId, pendingRow);
  const dir = ctx.directoriesByKey.get(dirKeyForFolder(folderId));
  if (dir && !dir.fileIds.includes(tempId)) {
    dir.fileIds = [tempId, ...dir.fileIds];
  }
  ctx.emit();
}

export function updateOptimisticUploadProgress(
  ctx: OptimisticUploadContext,
  tempId: string,
  percent: number
): void {
  const existing = ctx.filesById.get(tempId);
  if (!existing || existing.upload_state !== 'pending') return;
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  if (existing.upload_progress === clamped) return;

  ctx.filesById.set(tempId, {
    ...existing,
    upload_progress: clamped,
  });
  ctx.emit();
}

export function completeOptimisticUpload(
  ctx: OptimisticUploadContext,
  tempId: string,
  serverFile: FileItem
): void {
  const existing = ctx.filesById.get(tempId);
  const folderId = existing?.folder_id ?? serverFile.folder_id;

  ctx.filesById.delete(tempId);
  const dir = ctx.directoriesByKey.get(dirKeyForFolder(folderId));
  if (dir) {
    dir.fileIds = removeFromIdList(dir.fileIds, tempId);
  }

  ctx.upsertFileInCache({
    ...serverFile,
    upload_state: 'active',
    upload_progress: 100,
    optimistic: false,
  });
}

export function failOrCancelOptimisticUpload(
  ctx: OptimisticUploadContext,
  tempId: string
): void {
  const existing = ctx.filesById.get(tempId);
  if (!existing) return;
  ctx.filesById.delete(tempId);
  const dir = ctx.directoriesByKey.get(
    dirKeyForFolder(existing.folder_id)
  );
  if (dir) {
    dir.fileIds = removeFromIdList(dir.fileIds, tempId);
  }
  ctx.emit();
}
