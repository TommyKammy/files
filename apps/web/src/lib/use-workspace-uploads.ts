'use client';

import { useCallback, useEffect, useRef } from 'react';
import { isEditableTarget, keyboardScopes } from '@/lib/keyboard-shortcuts';
import type { WorkspaceClipboardStore } from '@/lib/workspace-clipboard';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { AuthUser, FolderSummary } from '@/types/files';

export function useWorkspaceUploads({
  authChecked,
  user,
  isTrashView,
  currentFolder,
  canUploadNew,
  clipboardStore,
  syncStore,
  handlePasteClipboard,
}: {
  authChecked: boolean;
  user: AuthUser | null;
  isTrashView: boolean;
  currentFolder: FolderSummary | null;
  canUploadNew: boolean;
  clipboardStore: WorkspaceClipboardStore;
  syncStore: WorkspaceSyncStore;
  handlePasteClipboard: () => void;
}) {
  const backgroundFileInputRef = useRef<HTMLInputElement>(null);
  const backgroundFolderInputRef = useRef<HTMLInputElement>(null);
  const pasteEnqueueFilesRef = useRef<
    ((files: FileList | File[]) => void) | null
  >(null);
  const lastOsPasteAtRef = useRef(0);
  const lastVirtualPasteAtRef = useRef(0);

  const enqueueBackgroundUpload = useCallback(
    (files: FileList | null, source: 'files' | 'folder') => {
      if (!files || files.length === 0) return;
      if (
        !currentFolder ||
        !canUploadNew ||
        !pasteEnqueueFilesRef.current
      ) {
        syncStore.pushToast({
          kind: 'warning',
          message: 'アップロードは編集可能なフォルダ内で行えます',
        });
        return;
      }
      pasteEnqueueFilesRef.current(files);
      if (source === 'folder') {
        syncStore.pushToast({
          kind: 'info',
          message:
            'フォルダ内のファイルを現在のフォルダへ追加します（階層は保持されません）',
        });
      }
    },
    [currentFolder, canUploadNew, syncStore]
  );

  useEffect(() => {
    const input = backgroundFolderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  // OS Paste upload (screenshots / copied local files) + virtual clipboard Cmd+V resolution
  useEffect(() => {
    if (!authChecked || !user || isTrashView) return;

    function handleWindowPaste(e: ClipboardEvent) {
      if (isEditableTarget(e.target)) return;
      if (keyboardScopes.getTopScope() !== 'workspace') return;

      const clipFiles = e.clipboardData?.files;
      if (clipFiles && clipFiles.length > 0) {
        e.preventDefault();
        lastOsPasteAtRef.current = performance.now();
        if (
          !currentFolder ||
          !canUploadNew ||
          !pasteEnqueueFilesRef.current
        ) {
          syncStore.pushToast({
            kind: 'warning',
            message:
              'ファイルや画像のペーストアップロードは編集可能なフォルダ内で行えます',
          });
          return;
        }
        const normalized = Array.from(clipFiles).map((file, idx) => {
          if (file.name && file.name.trim().length > 0) return file;
          const ext = file.type.split('/')[1] || 'png';
          return new File(
            [file],
            `pasted-${Date.now()}-${idx + 1}.${ext}`,
            { type: file.type || 'image/png' }
          );
        });
        pasteEnqueueFilesRef.current(normalized);
        syncStore.pushToast({
          kind: 'info',
          message: `${normalized.length} 件をクリップボードからアップロードキューに追加しました`,
        });
        return;
      }

      if (clipboardStore.getItemCount() > 0) {
        e.preventDefault();
        lastVirtualPasteAtRef.current = performance.now();
        handlePasteClipboard();
      }
    }

    window.addEventListener('paste', handleWindowPaste);
    return () => window.removeEventListener('paste', handleWindowPaste);
  }, [
    authChecked,
    user,
    isTrashView,
    currentFolder,
    canUploadNew,
    clipboardStore,
    syncStore,
    handlePasteClipboard,
  ]);

  return {
    backgroundFileInputRef,
    backgroundFolderInputRef,
    pasteEnqueueFilesRef,
    lastOsPasteAtRef,
    lastVirtualPasteAtRef,
    enqueueBackgroundUpload,
  };
}
