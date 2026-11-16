'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { useTableVirtualWindow } from '@/lib/use-virtual-window';
import {
  isImeComposingEvent,
  keyboardScopes,
} from '@/lib/keyboard-shortcuts';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type {
  ActiveModal,
} from '@/components/WorkspaceManagementModals';
import type {
  ClassificationPickerState,
} from '@/components/WorkspaceUtilityOverlays';
import type { PreviewTargetFile } from '@/components/SecurePreviewModal';
import type { VersionHistoryTarget } from '@/components/VersionHistoryModal';
import type {
  ClassificationLabel,
  FileItem,
  ResourceRole,
} from '@/types/files';

export function useWorkspaceDialogs({
  sortedFiles,
  files,
  isTrashView,
  canDownloadCurrentFolder,
  effectiveRole,
  isPrivilegedAdmin,
  syncStore,
  setError,
  setSelectedKeys,
  setFocusedRowKey,
  previewFileId,
  orderedRowKeys,
  virtualWindow,
}: {
  sortedFiles: FileItem[];
  files: FileItem[];
  isTrashView: boolean;
  canDownloadCurrentFolder: boolean;
  effectiveRole: ResourceRole;
  isPrivilegedAdmin: boolean;
  syncStore: WorkspaceSyncStore;
  setError: (message: string | null) => void;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setFocusedRowKey: (rowKey: string | null) => void;
  previewFileId: string | null;
  orderedRowKeys: string[];
  virtualWindow: ReturnType<typeof useTableVirtualWindow>;
}) {
  const [previewTarget, setPreviewTarget] = useState<{
    file: PreviewTargetFile;
    canDownload: boolean;
  } | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);
  const [folderNameInput, setFolderNameInput] = useState('');
  const [folderClassInput, setFolderClassInput] =
    useState<ClassificationLabel>('internal');
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const [classificationPicker, setClassificationPicker] =
    useState<ClassificationPickerState | null>(null);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [versionHistoryTarget, setVersionHistoryTarget] = useState<{
    target: VersionHistoryTarget;
    returnFocus: HTMLElement | null;
  } | null>(null);

  const modalScopeTokenRef = useRef<string | null>(null);
  const openedPreviewParamRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeModal) return;
    const token = keyboardScopes.pushScope('modal');
    modalScopeTokenRef.current = token;
    function handleModalEscape(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;
      if (
        e.key === 'Escape' &&
        (!modalScopeTokenRef.current ||
          keyboardScopes.isTopToken(modalScopeTokenRef.current))
      ) {
        e.preventDefault();
        e.stopPropagation();
        setActiveModal(null);
      }
    }
    window.addEventListener('keydown', handleModalEscape);
    return () => {
      window.removeEventListener('keydown', handleModalEscape);
      keyboardScopes.popScope(token);
      if (modalScopeTokenRef.current === token) {
        modalScopeTokenRef.current = null;
      }
    };
  }, [activeModal]);

  const previewableFiles = useMemo(
    () =>
      sortedFiles.filter(
        (f) => !f.optimistic && f.upload_state !== 'pending'
      ),
    [sortedFiles]
  );

  const previewFileIndex = previewTarget
    ? previewableFiles.findIndex((f) => f.id === previewTarget.file.id)
    : -1;

  const openPreviewForFile = useCallback(
    (file: FileItem) => {
      if (
        file.optimistic ||
        file.upload_state === 'pending' ||
        isTrashView
      ) {
        return;
      }
      setFocusedRowKey(`file:${file.id}`);
      setPreviewTarget({
        file: {
          id: file.id,
          folderId: file.folder_id,
          name: file.name,
          mimeType: file.mime_type,
          sizeBytes: file.size_bytes,
          classification: file.classification,
        },
        canDownload: canDownloadCurrentFolder,
      });
    },
    [canDownloadCurrentFolder, isTrashView, setFocusedRowKey]
  );

  const openVersionHistoryForFile = useCallback(
    (file: FileItem, returnFocus: HTMLElement | null = null) => {
      if (
        file.optimistic ||
        file.upload_state === 'pending' ||
        isTrashView
      ) {
        return;
      }
      setFocusedRowKey(`file:${file.id}`);
      setVersionHistoryTarget({
        target: {
          id: file.id,
          name: file.name,
          currentVersionNum: file.current_version_num,
          metaVersion: file.meta_version ?? 1,
          sizeBytes: file.size_bytes,
          mimeType: file.mime_type,
          classification: file.classification,
        },
        returnFocus,
      });
    },
    [isTrashView, setFocusedRowKey]
  );

  // Deep link: /workspace?folderId=...&preview=<fileId> opens the preview once.
  useEffect(() => {
    if (!previewFileId || isTrashView) return;
    if (openedPreviewParamRef.current === previewFileId) return;
    const file = files.find((candidate) => candidate.id === previewFileId);
    if (!file) return;
    openedPreviewParamRef.current = previewFileId;
    openPreviewForFile(file);
  }, [previewFileId, isTrashView, files, openPreviewForFile]);

  const handleNavigatePreview = useCallback(
    (direction: -1 | 1) => {
      if (previewFileIndex < 0) return;
      const next = previewableFiles[previewFileIndex + direction];
      if (!next) return;
      openPreviewForFile(next);
      const nextRowIdx = orderedRowKeys.indexOf(`file:${next.id}`);
      if (nextRowIdx >= 0) {
        virtualWindow.scrollRowIntoView(nextRowIdx);
      }
    },
    [
      previewFileIndex,
      previewableFiles,
      openPreviewForFile,
      orderedRowKeys,
      virtualWindow,
    ]
  );

  const handleApplyPickedClassification = useCallback(
    (nextLabel: Exclude<ClassificationLabel, 'unset'>) => {
      if (!classificationPicker) return;
      setError(null);
      if (classificationPicker.mode === 'single') {
        const res = syncStore.optimisticUpdateFileClassification(
          classificationPicker.file,
          { classification: nextLabel },
          { effectiveRole, isPrivilegedAdmin }
        );
        if (!res.ok) {
          setError(res.error ?? '機密区分の更新に失敗しました');
        }
      } else {
        let firstError: string | null = null;
        for (const file of classificationPicker.files) {
          const res = syncStore.optimisticUpdateFileClassification(
            file,
            { classification: nextLabel },
            { effectiveRole, isPrivilegedAdmin }
          );
          if (!res.ok && !firstError) {
            firstError =
              res.error ?? '一部の機密区分を更新できませんでした';
          }
        }
        if (firstError) setError(firstError);
        setSelectedKeys(new Set());
      }
      setClassificationPicker(null);
    },
    [
      classificationPicker,
      syncStore,
      effectiveRole,
      isPrivilegedAdmin,
      setError,
      setSelectedKeys,
    ]
  );

  function handleCreateOrRenameSubmit(
    e: React.FormEvent<HTMLFormElement>
  ) {
    e.preventDefault();
    if (!activeModal || modalSubmitting || !folderNameInput.trim()) return;
    if (
      activeModal.kind !== 'createFolder' &&
      activeModal.kind !== 'renameFolder' &&
      activeModal.kind !== 'renameFile'
    ) {
      return;
    }

    setModalSubmitting(true);
    setError(null);
    const trimmed = folderNameInput.trim();
    const res =
      activeModal.kind === 'createFolder'
        ? syncStore.optimisticCreateFolder({
            parentId: activeModal.parentId,
            name: trimmed,
            classification: folderClassInput,
          })
        : activeModal.kind === 'renameFolder'
          ? syncStore.optimisticRenameFolder(activeModal.folder, trimmed)
          : syncStore.optimisticRenameFile(
              activeModal.file,
              trimmed,
              effectiveRole
            );

    setModalSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? '更新に失敗しました');
      return;
    }
    setActiveModal(null);
  }

  return {
    previewTarget,
    setPreviewTarget,
    previewableFiles,
    previewFileIndex,
    openPreviewForFile,
    handleNavigatePreview,
    activeModal,
    setActiveModal,
    folderNameInput,
    setFolderNameInput,
    folderClassInput,
    setFolderClassInput,
    modalSubmitting,
    handleCreateOrRenameSubmit,
    classificationPicker,
    setClassificationPicker,
    handleApplyPickedClassification,
    shortcutsHelpOpen,
    setShortcutsHelpOpen,
    inspectorOpen,
    setInspectorOpen,
    versionHistoryTarget,
    setVersionHistoryTarget,
    openVersionHistoryForFile,
  };
}
