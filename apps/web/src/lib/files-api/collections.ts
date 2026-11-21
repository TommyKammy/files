import type { Capability, ClassificationLabel } from '@/types/files';
import { apiFetch } from './core';
import type { FavoriteRecentItemType } from './favorites-recents';

export type CollectionColor =
  | 'slate'
  | 'indigo'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'sky'
  | 'violet';

export const COLLECTION_MAX_NAME_LENGTH = 60;

export const COLLECTION_COLOR_OPTIONS: ReadonlyArray<{
  value: CollectionColor;
  label: string;
  dotClass: string;
}> = [
  { value: 'slate', label: 'スレート', dotClass: 'bg-slate-500' },
  { value: 'indigo', label: 'インディゴ', dotClass: 'bg-indigo-500' },
  { value: 'sky', label: 'スカイ', dotClass: 'bg-sky-500' },
  { value: 'emerald', label: 'エメラルド', dotClass: 'bg-emerald-500' },
  { value: 'amber', label: 'アンバー', dotClass: 'bg-amber-500' },
  { value: 'rose', label: 'ローズ', dotClass: 'bg-rose-500' },
  { value: 'violet', label: 'バイオレット', dotClass: 'bg-violet-500' },
];

export function getCollectionDotClass(color: CollectionColor | string): string {
  return (
    COLLECTION_COLOR_OPTIONS.find((opt) => opt.value === color)?.dotClass ??
    'bg-slate-500'
  );
}

export function validateCollectionName(
  raw: string
): { valid: true; name: string } | { valid: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { valid: false, error: 'コレクション名を入力してください。' };
  }
  if (trimmed.length > COLLECTION_MAX_NAME_LENGTH) {
    return {
      valid: false,
      error: `コレクション名は${COLLECTION_MAX_NAME_LENGTH}文字以内で入力してください。`,
    };
  }
  return { valid: true, name: trimmed };
}

export interface UserCollection {
  id: string;
  name: string;
  color: CollectionColor;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionItemEntry {
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
  addedAt: string;
}

export function listCollections(
  signal?: AbortSignal
): Promise<{ collections: UserCollection[] }> {
  return apiFetch<{ collections: UserCollection[] }>('/api/collections', {
    signal,
  });
}

export function createCollection(payload: {
  name: string;
  color?: CollectionColor;
}): Promise<{ collection: UserCollection }> {
  return apiFetch<{ collection: UserCollection }>('/api/collections', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateCollection(
  collectionId: string,
  payload: {
    name?: string;
    color?: CollectionColor;
  }
): Promise<{ collection: UserCollection }> {
  return apiFetch<{ collection: UserCollection }>(
    `/api/collections/${encodeURIComponent(collectionId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }
  );
}

export function deleteCollection(
  collectionId: string
): Promise<{ ok: true; id: string }> {
  return apiFetch<{ ok: true; id: string }>(
    `/api/collections/${encodeURIComponent(collectionId)}`,
    {
      method: 'DELETE',
    }
  );
}

export function listCollectionItems(
  collectionId: string,
  signal?: AbortSignal
): Promise<{ collection: UserCollection; items: CollectionItemEntry[] }> {
  return apiFetch<{ collection: UserCollection; items: CollectionItemEntry[] }>(
    `/api/collections/${encodeURIComponent(collectionId)}/items`,
    { signal }
  );
}

export function addCollectionItem(
  collectionId: string,
  itemType: FavoriteRecentItemType,
  itemId: string
): Promise<{
  ok: true;
  collectionId: string;
  itemType: FavoriteRecentItemType;
  itemId: string;
}> {
  return apiFetch<{
    ok: true;
    collectionId: string;
    itemType: FavoriteRecentItemType;
    itemId: string;
  }>(`/api/collections/${encodeURIComponent(collectionId)}/items`, {
    method: 'POST',
    body: JSON.stringify({ itemType, itemId }),
  });
}

export function removeCollectionItem(
  collectionId: string,
  itemType: FavoriteRecentItemType,
  itemId: string
): Promise<{
  ok: true;
  collectionId: string;
  itemType: FavoriteRecentItemType;
  itemId: string;
}> {
  return apiFetch<{
    ok: true;
    collectionId: string;
    itemType: FavoriteRecentItemType;
    itemId: string;
  }>(
    `/api/collections/${encodeURIComponent(collectionId)}/items/${encodeURIComponent(itemType)}/${encodeURIComponent(itemId)}`,
    {
      method: 'DELETE',
    }
  );
}
