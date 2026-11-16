import { apiFetch } from './core';
import type { WopiSessionResponse } from '@/types/files';

export async function createWopiSession(
  fileId: string
): Promise<WopiSessionResponse> {
  return apiFetch<WopiSessionResponse>(
    `/api/files/${encodeURIComponent(fileId)}/wopi-session`,
    { method: 'POST', body: '{}' }
  );
}
