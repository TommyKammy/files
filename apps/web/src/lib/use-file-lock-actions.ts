'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  acquireFileLock,
  formatFileLockError,
  getFileLockStatus,
  releaseFileLock,
} from '@/lib/files-api/locks';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { FileLockInfo } from '@/types/files';

export function canUserUnlockFileLock(options: {
  lock: FileLockInfo | null | undefined;
  currentUserId?: string | null;
  isPrivilegedAdmin?: boolean;
  canManagePermissions?: boolean;
  canEditContent?: boolean;
}): boolean {
  const {
    lock,
    currentUserId,
    isPrivilegedAdmin = false,
    canManagePermissions = false,
    canEditContent = false,
  } = options;
  if (!lock) return false;
  if (isPrivilegedAdmin || canManagePermissions) return true;
  if (!canEditContent) return false;
  if (!currentUserId) return true;
  return lock.ownerId === currentUserId;
}

export function useFileLockActions({
  fileId,
  initialLock = null,
  syncStore,
  onLockChanged,
}: {
  fileId: string | null;
  initialLock?: FileLockInfo | null;
  syncStore?: WorkspaceSyncStore;
  onLockChanged?: (fileId: string, lock: FileLockInfo | null) => void;
}) {
  const [lock, setLock] = useState<FileLockInfo | null>(initialLock ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLock(initialLock ?? null);
    setError(null);
  }, [fileId, initialLock]);

  const refreshLockStatus = useCallback(async () => {
    if (!fileId) return null;
    try {
      const status = await getFileLockStatus(fileId);
      setLock(status.lock);
      onLockChanged?.(fileId, status.lock);
      return status.lock;
    } catch {
      return null;
    }
  }, [fileId, onLockChanged]);

  const acquireLock = useCallback(
    async (options?: { ttlSeconds?: number }) => {
      if (!fileId || busy) return null;
      setBusy(true);
      setError(null);
      try {
        const res = await acquireFileLock(fileId, options);
        setLock(res.lock);
        onLockChanged?.(fileId, res.lock);
        syncStore?.pushToast({
          kind: 'info',
          message: 'ファイルをロックしました',
        });
        return res.lock;
      } catch (err) {
        const message = formatFileLockError(err, 'ファイルのロックに失敗しました');
        setError(message);
        syncStore?.pushToast({ kind: 'error', message });
        await refreshLockStatus();
        return null;
      } finally {
        setBusy(false);
      }
    },
    [busy, fileId, onLockChanged, refreshLockStatus, syncStore]
  );

  const releaseLock = useCallback(
    async (options?: { lockId?: string }) => {
      if (!fileId || busy) return false;
      setBusy(true);
      setError(null);
      try {
        await releaseFileLock(fileId, options);
        setLock(null);
        onLockChanged?.(fileId, null);
        syncStore?.pushToast({
          kind: 'info',
          message: 'ファイルのロックを解除しました',
        });
        return true;
      } catch (err) {
        const message = formatFileLockError(
          err,
          'ファイルロックの解除に失敗しました'
        );
        setError(message);
        syncStore?.pushToast({ kind: 'error', message });
        await refreshLockStatus();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, fileId, onLockChanged, refreshLockStatus, syncStore]
  );

  const toggleLock = useCallback(async () => {
    if (lock) {
      return releaseLock();
    }
    return Boolean(await acquireLock());
  }, [acquireLock, lock, releaseLock]);

  return {
    lock,
    busy,
    error,
    setError,
    refreshLockStatus,
    acquireLock,
    releaseLock,
    toggleLock,
  };
}
