import type { Capability, ClassificationLabel } from '@/types/files';
import { apiFetch } from './core';

export type FavoriteRecentItemType = 'file' | 'folder';
export type RecentActionType = 'view' | 'edit' | 'download' | 'upload';

export interface FavoriteItemEntry {
  itemType: FavoriteRecentItemType;
  id: string;
  name: string;
  classification: ClassificationLabel;
  folderId: string | null;
  parentId: string | null;
  updatedAt: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  effectiveRole: string | null;
  capabilities: Capability[];
  breadcrumbs: Array<{ id: string; name: string }>;
  pathLabel: string;
  favoritedAt: string;
}

export interface RecentItemEntry {
  itemType: FavoriteRecentItemType;
  id: string;
  name: string;
  classification: ClassificationLabel;
  folderId: string | null;
  parentId: string | null;
  updatedAt: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  effectiveRole: string | null;
  capabilities: Capability[];
  breadcrumbs: Array<{ id: string; name: string }>;
  pathLabel: string;
  lastAction: RecentActionType;
  accessedAt: string;
}

export function buildFavoriteKey(
  itemType: FavoriteRecentItemType,
  itemId: string
): string {
  return `${itemType}:${itemId}`;
}

export function clampRecentsLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

export function recentActionLabel(action: RecentActionType): string {
  switch (action) {
    case 'edit':
      return '編集';
    case 'download':
      return 'ダウンロード';
    case 'upload':
      return 'アップロード';
    case 'view':
    default:
      return '閲覧';
  }
}

export function filterFavoriteRecentItems<
  T extends { name: string; pathLabel?: string | null }
>(items: ReadonlyArray<T>, query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...items];
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(normalized) ||
      (item.pathLabel ? item.pathLabel.toLowerCase().includes(normalized) : false)
  );
}

export function listFavorites(
  signal?: AbortSignal
): Promise<{ items: FavoriteItemEntry[] }> {
  return apiFetch('/api/favorites', { signal });
}

export function addFavorite(
  itemType: FavoriteRecentItemType,
  itemId: string
): Promise<{ ok: boolean; itemType: FavoriteRecentItemType; itemId: string }> {
  return apiFetch('/api/favorites', {
    method: 'POST',
    body: JSON.stringify({ itemType, itemId }),
  });
}

export function removeFavorite(
  itemType: FavoriteRecentItemType,
  itemId: string
): Promise<{ ok: boolean; itemType: FavoriteRecentItemType; itemId: string }> {
  return apiFetch(
    `/api/favorites/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' }
  );
}

export function listRecents(
  limit = 50,
  signal?: AbortSignal
): Promise<{ items: RecentItemEntry[] }> {
  const clamped = clampRecentsLimit(limit);
  return apiFetch(`/api/recents?limit=${clamped}`, { signal });
}

export function touchRecentItem(
  itemType: FavoriteRecentItemType,
  itemId: string,
  action: RecentActionType = 'view'
): Promise<{
  ok: boolean;
  itemType: FavoriteRecentItemType;
  itemId: string;
  action: RecentActionType;
}> {
  return apiFetch('/api/recents/touch', {
    method: 'POST',
    body: JSON.stringify({ itemType, itemId, action }),
  });
}
