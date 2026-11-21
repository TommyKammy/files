'use client';

import { Loader2, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import type { DestinationRow } from '@/components/DestinationRowButton';
import { ModalShell } from '@/components/ModalShell';
import { RestoreDestinationPicker } from '@/components/trash-restore/RestoreDestinationPicker';
import { RestoreErrorAlert } from '@/components/trash-restore/RestoreErrorAlert';
import { RestoreModalFooter } from '@/components/trash-restore/RestoreModalFooter';
import { RestoreOptionsSection } from '@/components/trash-restore/RestoreOptionsSection';
import {
  ApiClientError,
  getTrashRestoreContext,
  restoreFileWithOptions,
  restoreFolderWithOptions,
} from '@/lib/files-api';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import { useTrashRestoreDestinationTree } from '@/lib/use-trash-restore-destination-tree';
import {
  applyTrashRestoreContext,
  applyTrashRestoreError,
  buildDestinationFromCachedFolder,
  buildInitialTrashRestoreDialogState,
  canSubmitTrashRestore,
  evaluateTrashRestoreDestination,
  isTrashRestoreParentToggleAvailable,
  selectOriginalTrashRestoreDestination,
  selectTrashRestoreDestination,
  type TrashRestoreDialogState,
} from '@/lib/trash-restore-options';
import type {
  FileItem,
  FolderStructureMode,
  FolderSummary,
  RestoreDestinationContext,
  TrashItem,
  TrashRestoreContextResponse,
} from '@/types/files';

export interface TrashRestoreSuccessResult {
  destination: RestoreDestinationContext;
  restoredAncestorIds: string[];
  affectedFolderIds: Array<string | null>;
  restoredName: string;
  file?: FileItem;
  folder?: FolderSummary;
}

const LOAD_CONTEXT_ERROR = '復元情報の取得に失敗しました';

export function WorkspaceTrashRestoreModal({
  item,
  isSysAdmin,
  folderStructureMode = 'open',
  syncStore,
  onClose,
  onSuccess,
}: {
  item: TrashItem;
  isSysAdmin: boolean;
  folderStructureMode?: FolderStructureMode;
  syncStore: WorkspaceSyncStore;
  onClose: () => void;
  onSuccess: (result: TrashRestoreSuccessResult) => void;
}) {
  const titleId = useId();
  const [context, setContext] = useState<TrashRestoreContextResponse | null>(
    null
  );
  const [state, setState] = useState<TrashRestoreDialogState | null>(null);
  const [loadingContext, setLoadingContext] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingDestination, setLoadingDestination] = useState(false);
  const [busy, setBusy] = useState(false);
  const destinationRequestRef = useRef(0);

  const tree = useTrashRestoreDestinationTree({ syncStore });

  useEffect(() => {
    let cancelled = false;
    setLoadingContext(true);
    setLoadError(null);
    setContext(null);
    setState(null);

    void getTrashRestoreContext(item.type, item.id)
      .then((fresh) => {
        if (cancelled) return;
        setContext(fresh);
        setState(buildInitialTrashRestoreDialogState(fresh));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiClientError ? err.message : LOAD_CONTEXT_ERROR
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingContext(false);
      });

    return () => {
      cancelled = true;
    };
  }, [item.type, item.id]);

  const evaluateRow = useCallback(
    (row: DestinationRow) => {
      if (!context) {
        return {
          moveEval: { allowed: false, reason: '復元情報を読み込み中です' },
          copyEval: { allowed: false, reason: '復元情報を読み込み中です' },
        };
      }
      const evalResult = evaluateTrashRestoreDestination({
        context,
        targetId: row.folderId,
        targetEffectiveRole: row.effectiveRole,
        itemEffectiveRole: item.effectiveRole ?? null,
        isSysAdmin,
        folderStructureMode,
        isDescendantOfItem:
          item.type === 'folder'
            ? syncStore.isFolderAncestorOf(item.id, row.folderId)
            : false,
      });
      return {
        moveEval: { allowed: evalResult.allowed, reason: evalResult.reason },
        copyEval: { allowed: evalResult.allowed, reason: evalResult.reason },
      };
    },
    [context, item, isSysAdmin, folderStructureMode, syncStore]
  );

  const refreshDestinationContext = useCallback(
    (targetId: string | null) => {
      const seq = destinationRequestRef.current + 1;
      destinationRequestRef.current = seq;
      setLoadingDestination(true);
      void getTrashRestoreContext(item.type, item.id, targetId)
        .then((fresh) => {
          if (destinationRequestRef.current !== seq) return;
          setContext(fresh);
          setState((prev) =>
            prev ? applyTrashRestoreContext(prev, fresh) : prev
          );
        })
        .catch((err) => {
          if (destinationRequestRef.current !== seq) return;
          setState((prev) =>
            prev
              ? {
                  ...prev,
                  error:
                    err instanceof ApiClientError
                      ? err.message
                      : LOAD_CONTEXT_ERROR,
                  errorCode:
                    err instanceof ApiClientError ? (err.code ?? null) : null,
                }
              : prev
          );
        })
        .finally(() => {
          if (destinationRequestRef.current === seq) {
            setLoadingDestination(false);
          }
        });
    },
    [item.id, item.type]
  );

  const chooseDestinationRow = useCallback(
    (row: DestinationRow) => {
      if (!context || !state) return;
      tree.setSelectedKey(row.rowKey);
      const view = row.folderId
        ? syncStore.getDirectoryView(row.folderId)
        : null;
      const destination = buildDestinationFromCachedFolder({
        folderId: row.folderId,
        folderName: row.name,
        classification: row.classification,
        breadcrumbs: view?.breadcrumbs ?? [],
      });
      setState((prev) =>
        prev ? selectTrashRestoreDestination(prev, context, destination) : prev
      );
      refreshDestinationContext(row.folderId);
    },
    [context, state, tree, syncStore, refreshDestinationContext]
  );

  const switchMode = useCallback(
    (mode: 'original' | 'custom') => {
      if (!context || !state) return;
      if (mode === 'original') {
        setState((prev) =>
          prev ? selectOriginalTrashRestoreDestination(prev, context) : prev
        );
        return;
      }

      const rootDestination = buildDestinationFromCachedFolder({
        folderId: null,
        folderName: 'マイファイル (ルート)',
        classification: 'unset',
        breadcrumbs: [],
      });
      setState((prev) =>
        prev
          ? selectTrashRestoreDestination(prev, context, rootDestination)
          : prev
      );
      tree.setSelectedKey('tree:__ROOT__');
      refreshDestinationContext(null);
    },
    [context, state, tree, refreshDestinationContext]
  );

  const performRestore = useCallback(
    async (dialog: TrashRestoreDialogState) => {
      if (busy) return;
      setBusy(true);
      try {
        if (item.type === 'file') {
          const response = await restoreFileWithOptions(item.id, {
            conflictPolicy: dialog.conflictPolicy,
            ...(dialog.mode === 'original'
              ? { restoreParentChain: dialog.restoreParentChain }
              : { targetFolderId: dialog.targetId }),
            ...(typeof item.meta_version === 'number'
              ? { expectedVersion: item.meta_version }
              : {}),
          });
          onSuccess({
            destination: response.destination,
            restoredAncestorIds: response.restoredAncestorIds,
            affectedFolderIds: response.affectedFolderIds,
            restoredName: response.file.name,
            file: response.file,
          });
        } else {
          const response = await restoreFolderWithOptions(item.id, {
            conflictPolicy: dialog.conflictPolicy,
            ...(dialog.mode === 'original'
              ? { restoreParentChain: dialog.restoreParentChain }
              : { targetParentId: dialog.targetId }),
          });
          onSuccess({
            destination: response.destination,
            restoredAncestorIds: response.restoredAncestorIds,
            affectedFolderIds: response.affectedFolderIds,
            restoredName: response.folder.name,
            folder: response.folder,
          });
        }
      } catch (err) {
        if (err instanceof ApiClientError) {
          setState((prev) => {
            if (!prev) return prev;
            return applyTrashRestoreError(prev, {
              status: err.status,
              code: err.code,
              message: err.message,
              details: err.details,
            }).state;
          });
        } else {
          setState((prev) =>
            prev
              ? {
                  ...prev,
                  error: '復元に失敗しました',
                  errorCode: null,
                }
              : prev
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, item, onSuccess]
  );

  const submit = useCallback(() => {
    if (!state || !context) return;
    if (!canSubmitTrashRestore(state, { busy, loadingDestination })) return;

    if (state.mode === 'custom' && state.targetId === null) {
      const rootEvaluation = evaluateTrashRestoreDestination({
        context,
        targetId: null,
        itemEffectiveRole: item.effectiveRole ?? null,
        isSysAdmin,
        folderStructureMode,
      });
      if (!rootEvaluation.allowed) {
        setState((prev) =>
          prev
            ? {
                ...prev,
                error:
                  rootEvaluation.reason ??
                  'ルート直下へ復元する権限がありません',
                errorCode: 'FORBIDDEN',
              }
            : prev
        );
        return;
      }
    }
    void performRestore(state);
  }, [
    state,
    context,
    busy,
    loadingDestination,
    item,
    isSysAdmin,
    folderStructureMode,
    performRestore,
  ]);

  const retryWithRename = useCallback(() => {
    if (!state) return;
    const next: TrashRestoreDialogState = {
      ...state,
      conflictPolicy: 'rename',
      error: null,
      errorCode: null,
    };
    setState(next);
    void performRestore(next);
  }, [state, performRestore]);

  const retryWithParentChain = useCallback(() => {
    if (!state) return;
    const next: TrashRestoreDialogState = {
      ...state,
      restoreParentChain: true,
      error: null,
      errorCode: null,
    };
    setState(next);
    void performRestore(next);
  }, [state, performRestore]);

  const parentToggleAvailable = state
    ? isTrashRestoreParentToggleAvailable(state)
    : false;
  const canSubmit = state
    ? canSubmitTrashRestore(state, { busy, loadingDestination })
    : false;
  const typeLabel = item.type === 'folder' ? 'フォルダ' : 'ファイル';

  const destinationBadge = useMemo(
    () => (
      <ClassificationBadge
        classification={state?.targetClassification ?? 'unset'}
        compact
      />
    ),
    [state?.targetClassification]
  );

  return (
    <ModalShell
      label="ゴミ箱から復元"
      labelledBy={titleId}
      onClose={onClose}
      backdrop="deep"
      className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
    >
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
            <RotateCcw className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-slate-900">
              ゴミ箱から復元
            </h2>
            <p className="truncate text-[0.6875rem] text-slate-500">
              {typeLabel}: {item.name}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="閉じる"
          onClick={onClose}
          className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-xs">
        {loadingContext && (
          <div
            className="flex items-center justify-center gap-2 py-10 text-slate-500"
            data-trash-restore-loading="true"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>復元情報を読み込み中...</span>
          </div>
        )}

        {!loadingContext && loadError && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800"
            data-trash-restore-error="true"
          >
            {loadError}
          </div>
        )}

        {!loadingContext && !loadError && context && state && (
          <>
            <RestoreDestinationPicker
              context={context}
              state={state}
              tree={tree}
              destinationBadge={destinationBadge}
              parentToggleAvailable={parentToggleAvailable}
              loadingDestination={loadingDestination}
              evaluateRow={evaluateRow}
              onSwitchMode={switchMode}
              onSelectDestinationRow={chooseDestinationRow}
              onToggleParentChain={(checked) =>
                setState((prev) =>
                  prev
                    ? {
                        ...prev,
                        restoreParentChain: checked,
                        error: null,
                        errorCode: null,
                      }
                    : prev
                )
              }
            />

            <RestoreOptionsSection
              state={state}
              onChangeConflictPolicy={(policy) =>
                setState((prev) =>
                  prev ? { ...prev, conflictPolicy: policy } : prev
                )
              }
            />

            <RestoreErrorAlert
              state={state}
              onRetryWithRename={retryWithRename}
              onRetryWithParentChain={retryWithParentChain}
              onSwitchToCustom={() => switchMode('custom')}
            />
          </>
        )}
      </div>

      <RestoreModalFooter
        state={state}
        busy={busy}
        canSubmit={canSubmit}
        loadingContext={loadingContext}
        hasLoadError={Boolean(loadError)}
        onClose={onClose}
        onSubmit={submit}
      />
    </ModalShell>
  );
}
