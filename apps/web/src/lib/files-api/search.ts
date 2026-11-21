import type { ClassificationLabel, SearchResultItem } from '@/types/files';
import { apiFetch } from './core';

export type SearchTargetType = 'all' | 'file' | 'folder';

export interface SearchFolderResultItem {
  id: string;
  parentId: string | null;
  parentName: string | null;
  name: string;
  depth: number;
  classification: ClassificationLabel;
  updatedAt: string;
}

export interface SearchWorkspaceParams {
  q?: string;
  type?: SearchTargetType;
  classification?: ClassificationLabel | '';
  extension?: string;
  folderId?: string;
  updatedFrom?: string;
  updatedTo?: string;
  minSize?: number | null;
  maxSize?: number | null;
  ownerId?: string;
  limit?: number;
  offset?: number;
}

export interface SearchWorkspaceResponse {
  query: string;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  folders: SearchFolderResultItem[];
  results: SearchResultItem[];
}

export function buildSearchQueryString(params: SearchWorkspaceParams): string {
  const qs = new URLSearchParams();
  const q = params.q?.trim() ?? '';
  if (q) {
    qs.set('q', q);
  }
  if (params.type && params.type !== 'all') {
    qs.set('type', params.type);
  }
  if (params.classification) {
    qs.set('classification', params.classification);
  }
  const normalizedExt = params.extension?.trim().replace(/^\.+/, '').toLowerCase();
  if (normalizedExt) {
    qs.set('extension', normalizedExt);
  }
  const folderId = params.folderId?.trim();
  if (folderId) {
    qs.set('folderId', folderId);
  }
  const updatedFrom = params.updatedFrom?.trim();
  if (updatedFrom) {
    qs.set('updatedFrom', updatedFrom);
  }
  const updatedTo = params.updatedTo?.trim();
  if (updatedTo) {
    qs.set('updatedTo', updatedTo);
  }
  if (typeof params.minSize === 'number' && Number.isFinite(params.minSize) && params.minSize >= 0) {
    qs.set('minSize', String(Math.floor(params.minSize)));
  }
  if (typeof params.maxSize === 'number' && Number.isFinite(params.maxSize) && params.maxSize >= 0) {
    qs.set('maxSize', String(Math.floor(params.maxSize)));
  }
  const ownerId = params.ownerId?.trim();
  if (ownerId) {
    qs.set('ownerId', ownerId);
  }
  if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
    qs.set('limit', String(Math.min(Math.max(Math.floor(params.limit), 1), 100)));
  }
  if (typeof params.offset === 'number' && Number.isFinite(params.offset) && params.offset > 0) {
    qs.set('offset', String(Math.floor(params.offset)));
  }
  return qs.toString();
}

export function hasActiveSearchFilters(params: SearchWorkspaceParams): boolean {
  return Boolean(
    params.q?.trim() ||
      (params.type && params.type !== 'all') ||
      params.classification ||
      params.extension?.trim().replace(/^\.+/, '') ||
      params.folderId?.trim() ||
      params.updatedFrom?.trim() ||
      params.updatedTo?.trim() ||
      (typeof params.minSize === 'number' && Number.isFinite(params.minSize)) ||
      (typeof params.maxSize === 'number' && Number.isFinite(params.maxSize)) ||
      params.ownerId?.trim()
  );
}

export function mergeSearchPages(
  prev: SearchWorkspaceResponse,
  next: SearchWorkspaceResponse
): SearchWorkspaceResponse {
  const seenFolderIds = new Set(prev.folders.map((f) => f.id));
  const mergedFolders = [...prev.folders];
  for (const folder of next.folders) {
    if (!seenFolderIds.has(folder.id)) {
      seenFolderIds.add(folder.id);
      mergedFolders.push(folder);
    }
  }

  const seenFileIds = new Set(prev.results.map((f) => f.id));
  const mergedResults = [...prev.results];
  for (const file of next.results) {
    if (!seenFileIds.has(file.id)) {
      seenFileIds.add(file.id);
      mergedResults.push(file);
    }
  }

  return {
    query: next.query,
    limit: next.limit,
    offset: next.offset,
    hasMore: next.hasMore,
    nextOffset: next.nextOffset,
    folders: mergedFolders,
    results: mergedResults,
  };
}

export function searchWorkspace(
  params: SearchWorkspaceParams,
  signal?: AbortSignal
): Promise<SearchWorkspaceResponse> {
  const qs = buildSearchQueryString(params);
  return apiFetch<SearchWorkspaceResponse>(`/api/search${qs ? `?${qs}` : ''}`, {
    signal,
  });
}
