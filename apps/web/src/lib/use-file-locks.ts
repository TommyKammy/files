'use client';

import { useEffect, useState } from 'react';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { FileLockInfo } from '@/types/files';

export function useFileLocks(
  syncStore: WorkspaceSyncStore
): Record<string, FileLockInfo> {
  const [locks, setLocks] = useState<Record<string, FileLockInfo>>({});

  useEffect(() => {
    return syncStore.subscribeRealtimeSignals((signal) => {
      if (signal.eventKind !== 'file.lock_changed') return;
      const metadata = signal.metadata as
        | { fileId?: unknown; lock?: FileLockInfo | null }
        | undefined;
      const fileId =
        typeof metadata?.fileId === 'string' ? metadata.fileId : null;
      if (!fileId) return;
      setLocks((prev) => {
        const next = { ...prev };
        if (metadata?.lock) {
          next[fileId] = metadata.lock;
        } else {
          delete next[fileId];
        }
        return next;
      });
    });
  }, [syncStore]);

  return locks;
}
