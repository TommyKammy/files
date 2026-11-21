import type {
  AccessMode,
  BatchMoveWorkspaceResponse,
  BreadcrumbItem,
  Capability,
  ClassificationLabel,
  CopyWorkspaceResponse,
  FileItem,
  FileViewerInfo,
  FolderChildrenResponse,
  FolderSummary,
  InvitePolicy,
  ResourceRole,
  RestoreFileOptionsPayload,
  RestoreFileOptionsResponse,
  RestoreFolderOptionsPayload,
  RestoreFolderOptionsResponse,
  SearchResultItem,
  SharedItemEntry,
  TrashBulkItemRef,
  TrashBulkResponse,
  TrashEmptyResponse,
  TrashItemType,
  TrashListResponse,
  TrashRestoreContextResponse,
  TrashSort,
  TrashTypeFilter,
  WorkspaceBatchItemRef,
  WorkspaceConflictPolicy,
  WorkspaceJobStatus,
} from '@/types/files';
import {
  apiFetch,
  apiFetchBlob,
  parseContentDispositionFilename,
} from './core';
import { buildTrashQueryString } from '@/lib/trash-view';
import type {
  WorkspaceSortDirection,
  WorkspaceSortField,
} from '@/lib/workspace-sort-and-view';

export function listRootFolders(
  cursor?: string | null,
  signal?: AbortSignal,
  options?: { sortBy?: WorkspaceSortField; sortDir?: WorkspaceSortDirection }
): Promise<{
  folders: FolderSummary[];
  capabilities?: Capability[];
  nextCursor: string | null;
}> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  if (options?.sortBy) params.set('sortBy', options.sortBy);
  if (options?.sortDir) params.set('sortDir', options.sortDir);
  const qs = params.toString();
  return apiFetch(`/api/folders/roots${qs ? `?${qs}` : ''}`, { signal });
}

export function listFolderChildren(
  folderId: string,
  cursor?: string | null,
  limit = 50,
  options?: {
    includeBreadcrumbs?: boolean;
    signal?: AbortSignal;
    sortBy?: WorkspaceSortField;
    sortDir?: WorkspaceSortDirection;
  }
): Promise<FolderChildrenResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set('cursor', cursor);
  } else if (options?.includeBreadcrumbs !== false) {
    params.set('include', 'breadcrumbs');
  }
  if (options?.sortBy) params.set('sortBy', options.sortBy);
  if (options?.sortDir) params.set('sortDir', options.sortDir);
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/children?${params.toString()}`, {
    signal: options?.signal,
  });
}

export function getFolderBreadcrumbs(folderId: string): Promise<{
  breadcrumbs: BreadcrumbItem[];
  accessMode?: AccessMode | null;
  effectiveRole?: ResourceRole | null;
  capabilities?: Capability[];
}> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/breadcrumbs`);
}

/** GET /api/shared-items — items directly granted to the signed-in user/groups. */
export function listSharedItems(
  limit = 200,
  signal?: AbortSignal
): Promise<{ items: SharedItemEntry[] }> {
  return apiFetch(`/api/shared-items?limit=${limit}`, { signal });
}

export function listTrash(params: {
  limit?: number;
  cursor?: string | null;
  query?: string;
  type?: TrashTypeFilter;
  deletedBy?: string | null;
  deletedFrom?: string | null;
  deletedTo?: string | null;
  sort?: TrashSort;
} = {}): Promise<TrashListResponse> {
  return apiFetch(
    `/api/folders/trash?${buildTrashQueryString({
      limit: params.limit ?? 50,
      cursor: params.cursor ?? null,
      query: params.query ?? '',
      type: params.type ?? 'all',
      deletedBy: params.deletedBy ?? null,
      deletedFrom: params.deletedFrom ?? null,
      deletedTo: params.deletedTo ?? null,
      sort: params.sort ?? 'deletedAt_desc',
    })}`
  );
}

/** POST /api/trash/restore — per-item bulk restore (max 100 items per call). */
export function restoreTrashItems(payload: {
  items: TrashBulkItemRef[];
  conflictPolicy?: 'fail' | 'rename';
}): Promise<TrashBulkResponse> {
  return apiFetch<TrashBulkResponse>('/api/trash/restore', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** DELETE /api/trash/items — per-item permanent deletion (max 100 items). */
export function purgeTrashItems(payload: {
  items: TrashBulkItemRef[];
}): Promise<TrashBulkResponse> {
  return apiFetch<TrashBulkResponse>('/api/trash/items', {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });
}

/** POST /api/trash/empty — destructive empty with mandatory confirmation. */
export function emptyTrash(payload: {
  confirm: 'EMPTY_TRASH';
}): Promise<TrashEmptyResponse> {
  return apiFetch<TrashEmptyResponse>('/api/trash/empty', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createFolder(payload: {
  parentId: string | null;
  name: string;
  classification?: ClassificationLabel;
}): Promise<{ folder: FolderSummary }> {
  return apiFetch('/api/folders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateFolder(
  folderId: string,
  payload: {
    name?: string;
    isPinned?: boolean;
    invitePolicy?: InvitePolicy | null;
    expectedVersion?: number;
  }
): Promise<{ folder: FolderSummary }> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/** PATCH /api/folders/:id — owner / co-owner folder invite policy override. */
export function updateFolderInvitePolicy(
  folderId: string,
  invitePolicy: InvitePolicy | null
): Promise<{ folder: FolderSummary }> {
  return updateFolder(folderId, { invitePolicy });
}

export function softDeleteFolder(
  folderId: string,
  expectedVersion?: number
): Promise<{ ok: boolean; deletedAt?: string; version?: number }> {
  const qs =
    expectedVersion !== undefined
      ? `?expectedVersion=${encodeURIComponent(String(expectedVersion))}`
      : '';
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}${qs}`, {
    method: 'DELETE',
  });
}

export function restoreFolder(
  folderId: string,
  conflictPolicy: 'fail' | 'rename' = 'rename'
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/restore`, {
    method: 'POST',
    body: JSON.stringify({ conflictPolicy }),
  });
}

export function searchWorkspaceFiles(
  query: string,
  limit = 20
): Promise<{ query: string; limit: number; results: SearchResultItem[] }> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return apiFetch(`/api/search?${params.toString()}`);
}

export function updateFileMetadata(
  fileId: string,
  payload: { name?: string; folderId?: string | null; expectedVersion?: number }
): Promise<{ file: FileItem }> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function softDeleteFile(
  fileId: string,
  expectedVersion?: number
): Promise<{ ok: boolean; deletedAt?: string }> {
  const qs =
    expectedVersion !== undefined
      ? `?expectedVersion=${encodeURIComponent(String(expectedVersion))}`
      : '';
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}${qs}`, {
    method: 'DELETE',
  });
}

export function restoreFile(
  fileId: string,
  newName?: string
): Promise<{ ok: boolean; file: FileItem }> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}/restore`, {
    method: 'POST',
    body: JSON.stringify(newName ? { newName } : {}),
  });
}

/** POST /api/files/:id/restore — destination, chain and conflict options. */
export function restoreFileWithOptions(
  fileId: string,
  payload: RestoreFileOptionsPayload
): Promise<RestoreFileOptionsResponse> {
  return apiFetch<RestoreFileOptionsResponse>(
    `/api/files/${encodeURIComponent(fileId)}/restore`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

/** POST /api/folders/:id/restore — destination, chain and conflict options. */
export function restoreFolderWithOptions(
  folderId: string,
  payload: RestoreFolderOptionsPayload
): Promise<RestoreFolderOptionsResponse> {
  return apiFetch<RestoreFolderOptionsResponse>(
    `/api/folders/${encodeURIComponent(folderId)}/restore`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

/**
 * GET /api/trash/restore-context — breadcrumbs, floor, conflict and parent
 * chain metadata for the restore confirmation dialog.
 */
export function getTrashRestoreContext(
  type: TrashItemType,
  id: string,
  targetParentId?: string | null
): Promise<TrashRestoreContextResponse> {
  const params = new URLSearchParams({ type, id });
  if (targetParentId !== undefined) {
    params.set(
      'targetParentId',
      targetParentId === null ? '__ROOT__' : targetParentId
    );
  }
  return apiFetch<TrashRestoreContextResponse>(
    `/api/trash/restore-context?${params.toString()}`
  );
}


export function getFileViewerInfo(fileId: string): Promise<FileViewerInfo> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}`);
}

export function updateFileClassification(
  fileId: string,
  payload:
    | { acceptSuggestion: true; expectedVersion?: number }
    | { classification: Exclude<ClassificationLabel, 'unset'>; expectedVersion?: number }
): Promise<{ ok: boolean; file: FileItem }> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}/classification`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}


export function moveFolder(
  folderId: string,
  payload: {
    targetParentId: string | null;
    expectedVersion?: number;
  }
): Promise<{
  ok: boolean;
  folder: FolderSummary;
  classificationJobQueued?: boolean;
}> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/move`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/workspace/batch-move — batch move folders and files atomically */
export function batchMoveWorkspaceItems(payload: {
  items: WorkspaceBatchItemRef[];
  targetParentId: string | null;
  conflictPolicy?: WorkspaceConflictPolicy;
}): Promise<BatchMoveWorkspaceResponse> {
  return apiFetch<BatchMoveWorkspaceResponse>('/api/workspace/batch-move', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/workspace/copy — zero-copy CoW duplication into target directory */
export function copyWorkspaceItems(payload: {
  items: Array<{ type: 'file' | 'folder'; id: string }>;
  targetParentId: string | null;
  conflictPolicy?: WorkspaceConflictPolicy;
}): Promise<CopyWorkspaceResponse> {
  return apiFetch<CopyWorkspaceResponse>('/api/workspace/copy', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/workspace/duplicate — in-place CoW duplicate */
export function duplicateWorkspaceItems(payload: {
  items: Array<{ type: 'file' | 'folder'; id: string }>;
}): Promise<CopyWorkspaceResponse> {
  return apiFetch<CopyWorkspaceResponse>('/api/workspace/duplicate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** GET /api/workspace/jobs/:id — inspect background async copy job progress */
export function getWorkspaceJob(
  jobId: string,
  signal?: AbortSignal
): Promise<{ job: WorkspaceJobStatus }> {
  return apiFetch<{ job: WorkspaceJobStatus }>(
    `/api/workspace/jobs/${encodeURIComponent(jobId)}`,
    { signal }
  );
}

/** POST /api/workspace/download-zip — bulk / folder ZIP download */
export async function downloadWorkspaceZip(payload: {
  items: Array<{ type: 'file' | 'folder'; id: string }>;
}): Promise<{ blob: Blob; filename: string }> {
  const { blob, headers } = await apiFetchBlob('/api/workspace/download-zip', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return {
    blob,
    filename: parseContentDispositionFilename(
      headers.get('Content-Disposition'),
      'workspace-download.zip'
    ),
  };
}

