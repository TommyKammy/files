'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClientError, bulkApproveAiSuggestions } from '@/lib/files-api';
import { AdminAiBatchCoalescer } from '@/lib/mutation-outbox';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { AiSuggestionItem, ClassificationLabel } from '@/types/files';

interface UseGovernanceAiSuggestionsOptions {
  syncStore: WorkspaceSyncStore;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
}

/**
 * Manages AI classification suggestion state, selection, and optimistic batch
 * approval with rollback via `AdminAiBatchCoalescer`.
 */
export function useGovernanceAiSuggestions({
  syncStore,
  setError,
  setNotice,
}: UseGovernanceAiSuggestionsOptions) {
  const [suggestions, setSuggestions] = useState<AiSuggestionItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [labelFilter, setLabelFilter] = useState<ClassificationLabel | 'all'>(
    'all'
  );
  const [bulkBusy] = useState(false);

  const aiRollbackRef = useRef(
    new Map<string, { item: AiSuggestionItem; index: number }>()
  );

  const aiCoalescer = useMemo(
    () =>
      new AdminAiBatchCoalescer({
        submit: async (batch) => {
          const res = await bulkApproveAiSuggestions(batch);
          for (const item of batch) {
            aiRollbackRef.current.delete(item.fileId);
          }
          setNotice(`${res.approvedCount}件のAI分類提案を承認しました。`);
          void syncStore.syncDelta();
        },
        onError: (batch, err) => {
          setSuggestions((prev) => {
            const next = [...prev];
            for (const b of batch) {
              const snap = aiRollbackRef.current.get(b.fileId);
              if (snap && !next.some((s) => s.fileId === b.fileId)) {
                next.splice(Math.min(snap.index, next.length), 0, snap.item);
              }
              aiRollbackRef.current.delete(b.fileId);
            }
            return next;
          });
          setError(
            err instanceof ApiClientError
              ? err.message
              : 'AI分類承認に失敗したためロールバックしました'
          );
        },
      }),
    [syncStore, setError, setNotice]
  );

  useEffect(() => () => aiCoalescer.clear(), [aiCoalescer]);

  const applyAiSuggestions = useCallback((items: AiSuggestionItem[]) => {
    setSuggestions(items);
    setSelectedIds(new Set());
  }, []);

  const clearAiSuggestions = useCallback(() => {
    setSuggestions([]);
    setSelectedIds(new Set());
  }, []);

  function toggleSelection(fileId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function handleSelectAllSuggestions(checked: boolean) {
    setSelectedIds(
      checked
        ? new Set(suggestions.slice(0, 50).map((s) => s.fileId))
        : new Set()
    );
  }

  function handleBulkApprove() {
    if (selectedIds.size === 0 || bulkBusy) return;
    setError(null);
    setNotice(null);

    const targetIds = new Set([...selectedIds].slice(0, 50));
    const items = [...targetIds].map((fileId) => ({ fileId }));
    suggestions.forEach((item, index) => {
      if (targetIds.has(item.fileId)) {
        aiRollbackRef.current.set(item.fileId, { item, index });
      }
    });

    setSuggestions((prev) => prev.filter((s) => !targetIds.has(s.fileId)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of targetIds) next.delete(id);
      return next;
    });
    setNotice(`${items.length}件のAI分類提案を承認しました（同期中）`);
    aiCoalescer.enqueue(items);
  }

  function handleSingleApprove(
    fileId: string,
    overrideLabel?: Exclude<ClassificationLabel, 'unset'>
  ) {
    setError(null);
    setNotice(null);
    const index = suggestions.findIndex((s) => s.fileId === fileId);
    if (index >= 0) {
      aiRollbackRef.current.set(fileId, { item: suggestions[index], index });
    }
    setSuggestions((prev) => prev.filter((s) => s.fileId !== fileId));
    setSelectedIds((prev) => {
      if (!prev.has(fileId)) return prev;
      const next = new Set(prev);
      next.delete(fileId);
      return next;
    });
    setNotice('1件のファイル分類を確定しました（同期中）');
    aiCoalescer.enqueue([
      overrideLabel ? { fileId, label: overrideLabel } : { fileId },
    ]);
  }

  return {
    suggestions,
    selectedIds,
    labelFilter,
    bulkBusy,
    setLabelFilter,
    applyAiSuggestions,
    clearAiSuggestions,
    toggleSelection,
    handleSelectAllSuggestions,
    handleBulkApprove,
    handleSingleApprove,
  };
}
