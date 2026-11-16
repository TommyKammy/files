'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { keyboardScopes } from '@/lib/keyboard-shortcuts';
import type { useTableVirtualWindow } from '@/lib/use-virtual-window';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  getWorkspaceRowKey,
  isRowSelectable,
  type InlineRenameState,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type {
  FileItem,
  FolderSummary,
  ResourceRole,
} from '@/types/files';

export function useWorkspaceInlineRename({
  isTrashView,
  canEditRow,
  syncStore,
  virtualWindow,
  folders,
  files,
  effectiveRole,
  setFocusedRowKey,
  setError,
}: {
  isTrashView: boolean;
  canEditRow: (row: WorkspaceTableRow) => boolean;
  syncStore: WorkspaceSyncStore;
  virtualWindow: ReturnType<typeof useTableVirtualWindow>;
  folders: FolderSummary[];
  files: FileItem[];
  effectiveRole: ResourceRole;
  setFocusedRowKey: (rowKey: string | null) => void;
  setError: (message: string | null) => void;
}) {
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(
    null
  );
  const inlineScopeTokenRef = useRef<string | null>(null);
  const inlineCommittedRef = useRef<string | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!inlineRename) return;
    const token = keyboardScopes.pushScope('inlineRename');
    inlineScopeTokenRef.current = token;
    const focusTimer = window.setTimeout(() => {
      const input = inlineInputRef.current;
      if (!input) return;
      input.focus();
      const dotIdx =
        inlineRename.kind === 'file'
          ? inlineRename.value.lastIndexOf('.')
          : -1;
      input.setSelectionRange(
        0,
        dotIdx > 0 ? dotIdx : inlineRename.value.length
      );
    }, 10);
    return () => {
      window.clearTimeout(focusTimer);
      keyboardScopes.popScope(token);
      if (inlineScopeTokenRef.current === token) {
        inlineScopeTokenRef.current = null;
      }
    };
    // Focus & select stem only when entering inline rename for a row
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineRename?.rowKey]);

  const startInlineRename = useCallback(
    (row: WorkspaceTableRow, rowIdx: number) => {
      if (isTrashView) return;
      if (row.kind === 'file' && !isRowSelectable(row)) {
        syncStore.pushToast({
          kind: 'warning',
          message: 'アップロード完了後に名前を変更できます',
        });
        return;
      }
      if (!canEditRow(row)) {
        syncStore.pushToast({
          kind: 'error',
          message: '名前を変更するには編集者以上の権限が必要です',
        });
        return;
      }
      const key = getWorkspaceRowKey(row);
      const name = row.kind === 'folder' ? row.folder.name : row.file.name;
      inlineCommittedRef.current = null;
      setFocusedRowKey(key);
      virtualWindow.scrollRowIntoView(rowIdx);
      setInlineRename({
        rowKey: key,
        kind: row.kind,
        id: row.kind === 'folder' ? row.folder.id : row.file.id,
        originalName: name,
        value: name,
      });
    },
    [
      isTrashView,
      canEditRow,
      syncStore,
      virtualWindow,
      setFocusedRowKey,
    ]
  );

  const commitInlineRename = useCallback(() => {
    if (!inlineRename) return;
    if (inlineCommittedRef.current === inlineRename.rowKey) return;
    inlineCommittedRef.current = inlineRename.rowKey;

    const trimmed = inlineRename.value.trim();
    if (!trimmed || trimmed === inlineRename.originalName) {
      setInlineRename(null);
      return;
    }

    setError(null);
    const res =
      inlineRename.kind === 'folder'
        ? (() => {
            const folder = folders.find((f) => f.id === inlineRename.id);
            return folder
              ? syncStore.optimisticRenameFolder(folder, trimmed)
              : { ok: false, error: 'フォルダが見つかりません' };
          })()
        : (() => {
            const file = files.find((f) => f.id === inlineRename.id);
            return file
              ? syncStore.optimisticRenameFile(
                  file,
                  trimmed,
                  effectiveRole
                )
              : { ok: false, error: 'ファイルが見つかりません' };
          })();

    if (!res.ok) {
      setError(res.error ?? '名前の変更に失敗しました');
    }
    setInlineRename(null);
  }, [inlineRename, folders, files, syncStore, effectiveRole, setError]);

  return {
    inlineRename,
    setInlineRename,
    inlineInputRef,
    inlineCommittedRef,
    startInlineRename,
    commitInlineRename,
  };
}
