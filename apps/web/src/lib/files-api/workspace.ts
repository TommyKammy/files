import type {
  BatchMoveWorkspaceResponse,
  BreadcrumbItem,
  ClassificationLabel,
  CopyWorkspaceResponse,
  FileItem,
  FolderChildrenResponse,
  FolderSummary,
  SearchResultItem,
  WorkspaceBatchItemRef,
  WorkspaceConflictPolicy,
  WorkspaceJobStatus,
} from '@/types/files';
import {
  apiFetch,
} from './core';

export function listRootFolders(
  cursor?: string | null,
  signal?: AbortSignal
): Promise<{
  folders: FolderSummary[];
  nextCursor: string | null;
}> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiFetch(`/api/folders/roots${qs}`, { signal });
}

export function listFolderChildren(
  folderId: string,
  cursor?: string | null,
  limit = 50,
  options?: { includeBreadcrumbs?: boolean; signal?: AbortSignal }
): Promise<FolderChildrenResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) {
    params.set('cursor', cursor);
  } else if (options?.includeBreadcrumbs !== false) {
    params.set('include', 'breadcrumbs');
  }
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/children?${params.toString()}`, {
    signal: options?.signal,
  });
}

export function getFolderBreadcrumbs(folderId: string): Promise<{
  breadcrumbs: BreadcrumbItem[];
}> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}/breadcrumbs`);
}

export function listTrash(limit = 50): Promise<{
  folders: FolderSummary[];
  files: FileItem[];
}> {
  return apiFetch(`/api/folders/trash?limit=${limit}`);
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
  payload: { name?: string; isPinned?: boolean; expectedVersion?: number }
): Promise<{ folder: FolderSummary }> {
  return apiFetch(`/api/folders/${encodeURIComponent(folderId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
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

