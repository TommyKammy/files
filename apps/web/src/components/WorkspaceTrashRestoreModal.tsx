'use client';

import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  FolderTree,
  History,
  Info,
  Loader2,
  RotateCcw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import {
  DestinationRowButton,
  type DestinationRow,
} from '@/components/DestinationRowButton';
import { ModalShell } from '@/components/ModalShell';
import { ApiClientError } from '@/lib/files-api';
import {
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
  syncStore,
  onClose,
  onSuccess,
}: {
  item: TrashItem;
  isSysAdmin: boolean;
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
    [context, item, isSysAdmin, syncStore]
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

    if (
      state.mode === 'custom' &&
      state.targetId === null &&
      item.type === 'folder' &&
      context.item.parentId !== null &&
      !isSysAdmin &&
      !evaluateTrashRestoreDestination({
        context,
        targetId: null,
        itemEffectiveRole: item.effectiveRole ?? null,
        isSysAdmin,
      }).allowed
    ) {
      setState((prev) =>
        prev
          ? {
              ...prev,
              error: 'ルートへ復元するには Owner 権限が必要です',
              errorCode: 'FORBIDDEN',
            }
          : prev
      );
      return;
    }
    void performRestore(state);
  }, [
    state,
    context,
    busy,
    loadingDestination,
    item,
    isSysAdmin,
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
            <section className="space-y-2">
              <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
                復元先
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                <label
                  className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 transition ${
                    state.mode === 'original'
                      ? 'border-blue-300 bg-blue-50/60 ring-1 ring-inset ring-blue-200'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="trash-restore-mode"
                    value="original"
                    checked={state.mode === 'original'}
                    onChange={() => switchMode('original')}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-medium text-slate-800">
                      <History className="h-3.5 w-3.5" />
                      元の場所へ復元
                    </span>
                    <span className="mt-0.5 block truncate text-[0.6875rem] text-slate-500">
                      {context.originalLocation.path}
                    </span>
                  </span>
                </label>
                <label
                  className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 transition ${
                    state.mode === 'custom'
                      ? 'border-blue-300 bg-blue-50/60 ring-1 ring-inset ring-blue-200'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="trash-restore-mode"
                    value="custom"
                    checked={state.mode === 'custom'}
                    onChange={() => switchMode('custom')}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 font-medium text-slate-800">
                      <FolderTree className="h-3.5 w-3.5" />
                      別のフォルダへ復元
                    </span>
                    <span className="mt-0.5 block text-[0.6875rem] text-slate-500">
                      アクセス可能なフォルダを選択
                    </span>
                  </span>
                </label>
              </div>
            </section>

            {state.mode === 'original' ? (
              <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[0.6875rem] font-medium text-slate-500">
                      復元先のパンくず
                    </p>
                    <p
                      className="truncate font-medium text-slate-900"
                      data-restore-destination-path={state.targetPath}
                    >
                      {state.targetPath}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className="text-[0.625rem] text-slate-500">
                      分類下限
                    </span>
                    {destinationBadge}
                  </div>
                </div>

                {state.targetIsDeleted && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-amber-900">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      元の親フォルダが削除されています（削除済み祖先{' '}
                      {state.targetDeletedAncestorCount} 件）
                    </span>
                  </div>
                )}

                <label
                  className={`flex items-start gap-2 ${
                    parentToggleAvailable
                      ? 'cursor-pointer text-slate-800'
                      : 'cursor-not-allowed text-slate-400'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={
                      parentToggleAvailable && state.restoreParentChain
                    }
                    disabled={!parentToggleAvailable}
                    onChange={(event) =>
                      setState((prev) =>
                        prev
                          ? {
                              ...prev,
                              restoreParentChain: event.target.checked,
                              error: null,
                              errorCode: null,
                            }
                          : prev
                      )
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">
                      親フォルダもまとめて復元する
                    </span>
                    <span className="mt-0.5 block text-[0.6875rem] text-slate-500">
                      {parentToggleAvailable
                        ? '削除済みの祖先フォルダ行だけを浅い順に復元します。関係ない兄弟アイテムはゴミ箱に残ります。'
                        : '親フォルダは有効なため、追加の復元は不要です。'}
                    </span>
                  </span>
                </label>
              </section>
            ) : (
              <section className="space-y-2">
                <div className="relative">
                  <input
                    ref={tree.searchInputRef}
                    type="text"
                    aria-label="復元先フォルダを検索"
                    autoComplete="off"
                    spellCheck={false}
                    data-autofocus
                    value={tree.query}
                    onChange={(event) => tree.setQuery(event.target.value)}
                    placeholder="フォルダ名で絞り込み..."
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                  />
                </div>
                <div
                  className="max-h-52 space-y-0.5 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5"
                  data-restore-destination-tree="true"
                >
                  {tree.visibleRows.map((row) => (
                    <div
                      key={row.rowKey}
                      data-restore-destination-id={
                        row.folderId ?? '__ROOT__'
                      }
                    >
                      <DestinationRowButton
                        row={row}
                        modeHint="move"
                        evaluate={evaluateRow}
                        highlighted={tree.selectedKey === row.rowKey}
                        onSelect={() => chooseDestinationRow(row)}
                        onToggleExpand={tree.toggleExpand}
                      />
                    </div>
                  ))}
                  {tree.visibleRows.length === 0 && (
                    <p className="px-3 py-6 text-center text-slate-500">
                      選択できるフォルダがありません
                    </p>
                  )}
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[0.6875rem] font-medium text-slate-500">
                        選択中の復元先
                      </p>
                      <p
                        className="truncate font-medium text-slate-900"
                        data-restore-destination-path={state.targetPath}
                      >
                        {state.targetPath}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-[0.625rem] text-slate-500">
                        分類下限
                      </span>
                      {destinationBadge}
                    </div>
                  </div>
                  {loadingDestination && (
                    <p className="mt-1 flex items-center gap-1 text-[0.6875rem] text-slate-500">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      復元先を確認中...
                    </p>
                  )}
                  {state.circular && (
                    <p className="mt-1 text-[0.6875rem] font-medium text-red-700">
                      自分自身または配下のフォルダへは復元できません
                    </p>
                  )}
                  {state.maxDepthExceeded && (
                    <p className="mt-1 text-[0.6875rem] font-medium text-red-700">
                      階層が深すぎるため復元できません（最大 20 階層）
                    </p>
                  )}
                  {!state.targetAccessible && (
                    <p className="mt-1 text-[0.6875rem] font-medium text-red-700">
                      このフォルダへのアクセス権限がありません
                    </p>
                  )}
                </div>
              </section>
            )}

            <section className="space-y-2">
              <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
                名前が重複した場合
              </h3>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <input
                    type="radio"
                    name="trash-restore-conflict"
                    checked={state.conflictPolicy === 'fail'}
                    onChange={() =>
                      setState((prev) =>
                        prev ? { ...prev, conflictPolicy: 'fail' } : prev
                      )
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-slate-800">
                      名前が重複している場合はエラーにする
                    </span>
                    <span className="mt-0.5 block text-[0.6875rem] text-slate-500">
                      何も上書きせず、再選択できます
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
                  <input
                    type="radio"
                    name="trash-restore-conflict"
                    checked={state.conflictPolicy === 'rename'}
                    onChange={() =>
                      setState((prev) =>
                        prev ? { ...prev, conflictPolicy: 'rename' } : prev
                      )
                    }
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium text-slate-800">
                      自動で別名に変更して復元
                    </span>
                    <span className="mt-0.5 block text-[0.6875rem] text-slate-500">
                      「(Restored)」連番を付与します
                    </span>
                  </span>
                </label>
              </div>

              {state.conflict.hasConflict && (
                <div
                  className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
                  data-restore-conflict="true"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <div>
                    <p className="font-medium">
                      同名のアイテムが復元先に存在します
                    </p>
                    {state.conflict.suggestedName && (
                      <p className="mt-0.5">
                        推奨名:{' '}
                        <span className="font-mono text-[0.6875rem]">
                          {state.conflict.suggestedName}
                        </span>
                      </p>
                    )}
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-2">
              {state.willUpgradeClassification && (
                <div
                  className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900"
                  data-restore-upgrade="true"
                >
                  <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    復元先の分類下限「
                    {state.targetClassification === 'confidential'
                      ? '極秘'
                      : state.targetClassification === 'internal'
                        ? '社内'
                        : state.targetClassification === 'public'
                          ? '公開'
                          : '未設定'}
                    」へ昇格します
                    {state.upgradeCount > 0
                      ? `（対象 ${state.upgradeCount} 件）`
                      : ''}
                    。
                  </span>
                </div>
              )}
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[0.6875rem] leading-relaxed text-slate-600">
                <p className="flex items-start gap-1.5">
                  <Info className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    復元先の権限を継承します。ルート直下へ復元する場合は、復元者がアクセスできなくならないよう直接権限を維持します。
                  </span>
                </p>
                <p className="mt-1 flex items-start gap-1.5">
                  <ArrowRightLeft className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    極秘へ昇格したファイルの公開共有リンクは自動的に無効化され、ダウンロード制限・電子透かしが適用されます。
                  </span>
                </p>
              </div>
            </section>

            {state.error && (
              <div
                role="alert"
                className="space-y-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800"
                data-trash-restore-error="true"
              >
                <p className="font-medium">{state.error}</p>
                {state.errorCode && (
                  <p className="font-mono text-[0.625rem] text-red-600">
                    {state.errorCode}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  {state.conflict.suggestedName &&
                    state.conflictPolicy !== 'rename' &&
                    state.errorCode === 'NAME_CONFLICT' && (
                      <button
                        type="button"
                        onClick={retryWithRename}
                        className="rounded-md border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100"
                      >
                        推奨名「{state.conflict.suggestedName}」で再試行
                      </button>
                    )}
                  {(state.errorCode === 'PARENT_FOLDER_DELETED' ||
                    state.errorCode === 'PARENT_IN_TRASH') &&
                    state.mode === 'original' &&
                    !state.restoreParentChain && (
                      <button
                        type="button"
                        onClick={retryWithParentChain}
                        className="rounded-md border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100"
                      >
                        親フォルダも復元して再試行
                      </button>
                    )}
                  {state.mode === 'original' && (
                    <button
                      type="button"
                      onClick={() => switchMode('custom')}
                      className="rounded-md border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100"
                    >
                      別のフォルダを選ぶ
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-[0.6875rem] text-slate-500">
          {state && (
            <span className="flex min-w-0 items-center gap-1">
              <Check className="h-3 w-3 shrink-0 text-emerald-600" />
              <span className="truncate">
                復元先: {state.targetPath}
                {state.mode === 'original' && state.restoreParentChain
                  ? '（親フォルダも復元）'
                  : ''}
              </span>
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <button
            type="button"
            data-autofocus
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-3.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit || busy || loadingContext || Boolean(loadError)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#5e6ad2] px-3.5 text-xs font-semibold text-white transition hover:bg-[#4f5ac2] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <RotateCcw className="h-3.5 w-3.5" />
            復元する
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
