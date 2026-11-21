import type { FileLockInfo } from '@/types/files';
import { ApiClientError, apiFetch } from './core';

export interface FileLockStatusResponse {
  fileId: string;
  lock: FileLockInfo | null;
  canWrite: boolean;
  readOnly: boolean;
  syncPolicy: 'full' | 'cloud_preview_only';
}

export interface AcquireFileLockResponse {
  ok: boolean;
  fileId: string;
  lock: FileLockInfo;
  lockId: string;
  expiresAt: number;
  syncPolicy: 'full' | 'cloud_preview_only';
}

export interface ReleaseFileLockResponse {
  ok: boolean;
  released: boolean;
}

export function getFileLockStatus(
  fileId: string
): Promise<FileLockStatusResponse> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}/lock-status`);
}

export function acquireFileLock(
  fileId: string,
  options?: { lockId?: string; ttlSeconds?: number }
): Promise<AcquireFileLockResponse> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}/lock`, {
    method: 'POST',
    body: JSON.stringify(options ?? {}),
  });
}

export function releaseFileLock(
  fileId: string,
  options?: { lockId?: string }
): Promise<ReleaseFileLockResponse> {
  return apiFetch(`/api/files/${encodeURIComponent(fileId)}/lock`, {
    method: 'DELETE',
    body: JSON.stringify(options ?? {}),
  });
}

export function formatFileLockError(
  err: unknown,
  fallback = 'ファイルロックの操作に失敗しました'
): string {
  if (!(err instanceof ApiClientError)) {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  const details = err.details as
    | {
        code?: string;
        lock?: {
          ownerName?: string | null;
          ownerEmail?: string | null;
          mode?: string;
        } | null;
      }
    | undefined;
  const code = err.code ?? details?.code;
  const lock = details?.lock;
  const holder = lock?.ownerName
    ? `${lock.ownerName}${lock.ownerEmail ? ` (${lock.ownerEmail})` : ''}`
    : null;

  if (
    err.status === 423 ||
    (err.status === 409 &&
      (code === 'FILE_LOCKED' || code === 'WOPI_LOCK_ACTIVE'))
  ) {
    if (code === 'WOPI_LOCK_ACTIVE' || lock?.mode === 'wopi_collab') {
      return holder
        ? `${holder} さんが Web 同時編集中のためロックできません`
        : 'Web 同時編集セッションが有効なためロックできません';
    }
    return holder
      ? `${holder} さんがこのファイルをロック中です`
      : 'このファイルは他のユーザーまたはクライアントによってロックされています';
  }

  if (err.status === 403 && code === 'LOCK_UNLOCK_FORBIDDEN') {
    return holder
      ? `ロック保有者（${holder}）または管理者のみロックを解除できます`
      : 'ロック保有者または管理者のみロックを解除できます';
  }

  return err.message || fallback;
}
