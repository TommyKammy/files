'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  emptyTrash,
  purgeTrashItems,
  restoreTrashItems,
} from '@/lib/files-api';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  buildTrashEmptyConfirmState,
  buildTrashPurgeConfirmState,
  chunkTrashBulkItems,
  createTrashBulkGuard,
  getTrashBulkActionResultMessage,
  summarizeTrashBulkResults,
  toTrashBulkItemRefs,
  type TrashBulkConfirmState,
  type TrashBulkSummary,
} from '@/lib/trash-bulk';
import type { TrashBulkItemResult, TrashItem } from '@/types/files';

export type TrashBulkAction = 'restore' | 'purge' | 'empty';

export interface TrashBulkResultState {
  action: TrashBulkAction;
  summary: TrashBulkSummary;
}

export function useWorkspaceTrashBulkActions({
  syncStore,
  selectedItems,
  allItems,
  removeTrashItem,
  reloadTrash,
  resetTrashView,
  setSelectedKeys,
}: {
  syncStore: WorkspaceSyncStore;
  selectedItems: TrashItem[];
  allItems: TrashItem[];
  removeTrashItem: (type: 'file' | 'folder', id: string) => void;
  reloadTrash: () => Promise<void>;
  resetTrashView: () => Promise<void>;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
}) {
  const [busyAction, setBusyAction] = useState<TrashBulkAction | null>(null);
  const [confirmState, setConfirmState] = useState<TrashBulkConfirmState | null>(
    null
  );
  const [resultState, setResultState] = useState<TrashBulkResultState | null>(
    null
  );
  const guardRef = useRef(createTrashBulkGuard());

  const itemByKey = useMemo(() => {
    const map = new Map<string, TrashItem>();
    for (const item of allItems) {
      map.set(`${item.type}:${item.id}`, item);
    }
    return map;
  }, [allItems]);

  const removeSucceededFromTrash = useCallback(
    (summary: TrashBulkSummary) => {
      for (const item of summary.succeeded) {
        removeTrashItem(item.type, item.id);
        const source = itemByKey.get(item.key);
        if (item.type === 'file') {
          const folderId =
            source?.type === 'file' ? source.folder_id : null;
          syncStore.removeFileFromCache(item.id, folderId);
        } else if (source?.type === 'folder') {
          syncStore.removeFolderFromCache(source);
        }
      }
    },
    [itemByKey, removeTrashItem, syncStore]
  );

  const finishWithResults = useCallback(
    (action: TrashBulkAction, results: TrashBulkItemResult[]) => {
      const summary = summarizeTrashBulkResults(results, allItems);
      removeSucceededFromTrash(summary);
      setSelectedKeys(
        new Set([...summary.failed, ...summary.skipped].map((item) => item.key))
      );
      syncStore.pushToast({
        kind:
          summary.failed.length > 0 || summary.skipped.length > 0
            ? 'warning'
            : 'info',
        message: getTrashBulkActionResultMessage(action, summary),
      });
      if (summary.failed.length > 0 || summary.skipped.length > 0) {
        setResultState({ action, summary });
      }
    },
    [allItems, removeSucceededFromTrash, setSelectedKeys, syncStore]
  );

  const runGuarded = useCallback(
    async (action: TrashBulkAction, task: () => Promise<void>) => {
      if (guardRef.current.isRunning()) return;
      setBusyAction(action);
      await guardRef.current.run(async () => {
        try {
          await task();
        } catch (err) {
          syncStore.pushToast({
            kind: 'error',
            message:
              err instanceof Error
                ? err.message
                : 'ゴミ箱の一括操作に失敗しました',
          });
          // Reconcile local state after an ambiguous network failure.
          await reloadTrash().catch(() => undefined);
        } finally {
          setBusyAction(null);
        }
      });
    },
    [reloadTrash, syncStore]
  );

  const requestRestore = useCallback(
    async (conflictPolicy: 'fail' | 'rename') => {
      if (busyAction || selectedItems.length === 0) return;
      const refs = toTrashBulkItemRefs(selectedItems);
      await runGuarded('restore', async () => {
        const results: TrashBulkItemResult[] = [];
        for (const chunk of chunkTrashBulkItems(refs)) {
          const response = await restoreTrashItems({
            items: chunk,
            conflictPolicy,
          });
          results.push(...response.results);
        }
        finishWithResults('restore', results);
      });
    },
    [busyAction, finishWithResults, runGuarded, selectedItems]
  );

  const requestPurge = useCallback(() => {
    if (busyAction || selectedItems.length === 0) return;
    setConfirmState(buildTrashPurgeConfirmState(selectedItems.length));
  }, [busyAction, selectedItems.length]);

  const requestEmpty = useCallback(
    (visibleCount: number) => {
      if (busyAction) return;
      setConfirmState(buildTrashEmptyConfirmState(visibleCount));
    },
    [busyAction]
  );

  const confirmPendingAction = useCallback(async () => {
    const current = confirmState;
    if (!current || busyAction) return;
    setConfirmState(null);

    if (current.kind === 'purge') {
      const refs = toTrashBulkItemRefs(selectedItems);
      if (refs.length === 0) return;
      await runGuarded('purge', async () => {
        const results: TrashBulkItemResult[] = [];
        for (const chunk of chunkTrashBulkItems(refs)) {
          const response = await purgeTrashItems({ items: chunk });
          results.push(...response.results);
        }
        finishWithResults('purge', results);
      });
      return;
    }

    await runGuarded('empty', async () => {
      const response = await emptyTrash({ confirm: 'EMPTY_TRASH' });
      const summary = summarizeTrashBulkResults(response.results, allItems);
      removeSucceededFromTrash(summary);
      setSelectedKeys(new Set());
      syncStore.pushToast({
        kind:
          summary.failed.length > 0 || summary.skipped.length > 0
            ? 'warning'
            : 'info',
        message:
          response.deletedCount > 0
            ? `${response.deletedCount} 件をゴミ箱から完全削除しました`
            : '削除できるゴミ箱項目はありませんでした',
      });
      if (summary.failed.length > 0 || summary.skipped.length > 0) {
        setResultState({ action: 'empty', summary });
      }
      // Emptying is a whole-Trash operation: clear search/filter state so the
      // user sees the authoritative remaining Trash (including locked items).
      await resetTrashView();
    });
  }, [
    allItems,
    busyAction,
    confirmState,
    finishWithResults,
    reloadTrash,
    removeSucceededFromTrash,
    resetTrashView,
    runGuarded,
    selectedItems,
    setSelectedKeys,
    syncStore,
  ]);

  const cancelConfirm = useCallback(() => {
    if (busyAction) return;
    setConfirmState(null);
  }, [busyAction]);

  const closeResult = useCallback(() => setResultState(null), []);

  return {
    busyAction,
    isBusy: busyAction !== null,
    confirmState,
    resultState,
    requestRestore,
    requestPurge,
    requestEmpty,
    confirmPendingAction,
    cancelConfirm,
    closeResult,
  };
}
