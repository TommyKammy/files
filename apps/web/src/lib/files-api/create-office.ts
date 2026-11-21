import { apiFetch } from './core';
import type { FileItem } from '@/types/files';

export type OfficeDocumentKind = 'docx' | 'xlsx' | 'pptx';

/**
 * Normalizes a user-entered document name so it ends with `.{kind}` (case-insensitive).
 */
export function normalizeOfficeFileName(
  rawName: string,
  kind: OfficeDocumentKind
): string {
  const trimmed = rawName.trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().endsWith(`.${kind}`)
    ? trimmed
    : `${trimmed}.${kind}`;
}

export async function createOfficeFile(params: {
  folderId: string;
  name: string;
  kind: OfficeDocumentKind;
}): Promise<{ file: FileItem }> {
  return apiFetch<{ file: FileItem }>('/api/files/create-office', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}
