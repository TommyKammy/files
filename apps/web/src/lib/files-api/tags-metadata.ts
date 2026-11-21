import { apiFetch } from './core';

export type TagItemType = 'file' | 'folder';
export type MetadataFieldType = 'text' | 'number' | 'date' | 'enum';

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_ITEM = 20;

export interface ItemTagEntry {
  tag: string;
  createdBy: string;
  createdAt: string;
}

export interface MetadataFieldDefinition {
  key: string;
  label: string;
  type: MetadataFieldType;
  required?: boolean;
  options?: string[];
}

export interface MetadataTemplate {
  id: string;
  key: string;
  displayName: string;
  description: string | null;
  fields: MetadataFieldDefinition[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type MetadataValueMap = Record<string, string | number | null>;

export interface ItemMetadataEntry {
  templateId: string;
  templateKey: string;
  displayName: string;
  values: MetadataValueMap;
  updatedBy: string;
  updatedAt: string;
}

export function normalizeTagInput(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateTagInput(
  raw: string
): { valid: true; tag: string } | { valid: false; error: string } {
  const tag = normalizeTagInput(raw);
  if (!tag) {
    return { valid: false, error: 'タグを入力してください。' };
  }
  if (tag.length > MAX_TAG_LENGTH) {
    return {
      valid: false,
      error: `タグは${MAX_TAG_LENGTH}文字以内で入力してください。`,
    };
  }
  return { valid: true, tag };
}

export function listTenantTags(
  query?: string,
  signal?: AbortSignal
): Promise<{ tags: string[] }> {
  const trimmed = query?.trim().toLowerCase() ?? '';
  const qs = trimmed ? `?q=${encodeURIComponent(trimmed)}` : '';
  return apiFetch<{ tags: string[] }>(`/api/tags${qs}`, { signal });
}

export function listItemTags(
  itemType: TagItemType,
  itemId: string,
  signal?: AbortSignal
): Promise<{ itemType: TagItemType; itemId: string; tags: ItemTagEntry[] }> {
  return apiFetch<{
    itemType: TagItemType;
    itemId: string;
    tags: ItemTagEntry[];
  }>(`/api/items/${itemType}/${encodeURIComponent(itemId)}/tags`, { signal });
}

export function addItemTag(
  itemType: TagItemType,
  itemId: string,
  tag: string
): Promise<{ ok: true; tag: ItemTagEntry }> {
  return apiFetch<{ ok: true; tag: ItemTagEntry }>(
    `/api/items/${itemType}/${encodeURIComponent(itemId)}/tags`,
    {
      method: 'POST',
      body: JSON.stringify({ tag }),
    }
  );
}

export function removeItemTag(
  itemType: TagItemType,
  itemId: string,
  tag: string
): Promise<{ ok: true; tag: string }> {
  return apiFetch<{ ok: true; tag: string }>(
    `/api/items/${itemType}/${encodeURIComponent(itemId)}/tags/${encodeURIComponent(tag)}`,
    {
      method: 'DELETE',
    }
  );
}

export function listMetadataTemplates(
  signal?: AbortSignal
): Promise<{ templates: MetadataTemplate[] }> {
  return apiFetch<{ templates: MetadataTemplate[] }>(
    '/api/metadata-templates',
    { signal }
  );
}

export function createMetadataTemplate(payload: {
  key: string;
  displayName: string;
  description?: string | null;
  fields: MetadataFieldDefinition[];
}): Promise<{ template: MetadataTemplate }> {
  return apiFetch<{ template: MetadataTemplate }>(
    '/api/admin/metadata-templates',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export function updateMetadataTemplate(
  templateId: string,
  payload: {
    displayName?: string;
    description?: string | null;
    fields?: MetadataFieldDefinition[];
  }
): Promise<{ template: MetadataTemplate }> {
  return apiFetch<{ template: MetadataTemplate }>(
    `/api/admin/metadata-templates/${encodeURIComponent(templateId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }
  );
}

export function deleteMetadataTemplate(
  templateId: string
): Promise<{ ok: true; id: string }> {
  return apiFetch<{ ok: true; id: string }>(
    `/api/admin/metadata-templates/${encodeURIComponent(templateId)}`,
    {
      method: 'DELETE',
    }
  );
}

export function listItemMetadata(
  itemType: TagItemType,
  itemId: string,
  signal?: AbortSignal
): Promise<{
  itemType: TagItemType;
  itemId: string;
  metadata: ItemMetadataEntry[];
}> {
  return apiFetch<{
    itemType: TagItemType;
    itemId: string;
    metadata: ItemMetadataEntry[];
  }>(`/api/items/${itemType}/${encodeURIComponent(itemId)}/metadata`, {
    signal,
  });
}

export function saveItemMetadata(
  itemType: TagItemType,
  itemId: string,
  templateId: string,
  values: MetadataValueMap
): Promise<{ ok: true; metadata: ItemMetadataEntry }> {
  return apiFetch<{ ok: true; metadata: ItemMetadataEntry }>(
    `/api/items/${itemType}/${encodeURIComponent(itemId)}/metadata/${encodeURIComponent(templateId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }
  );
}
