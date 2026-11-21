'use client';

import type { useRouter } from 'next/navigation';
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ActiveModal } from '@/components/WorkspaceManagementModals';
import { canAccess } from '@/lib/capabilities';
import { ApiClientError, getFileContentUrl } from '@/lib/files-api';
import {
  resolveContextSelection,
  ROOT_CREATION_NOTICE,
} from '@/lib/workspace-actions';
import {
  getWorkspaceRowKey,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type {
  BreadcrumbItem,
  Capability,
  ClassificationLabel,
  FolderSummary,
  ResourceRole,
  SearchResultItem,
} from '@/types/files';

/**
 * Encapsulates workspace navigation, file/folder opening, download, context
 * menu opening, and background click/context-menu handlers.
 */
export function useWorkspaceNavigation({
  router,
  folderId,
  isTrashView,
  currentFolder,
  breadcrumbs,
  directoryCapabilities,
  effectiveRole,
  rootCreationRestricted,
  selectedKeys,
  touchRecentFile,
  setSelectedKeys,
  setSelectionAnchorKey,
  setFocusedRowKey,
  setContextMenu,
  setBackgroundMenu,
  setFolderNameInput,
  setFolderClassInput,
  setActiveModal,
  setError,
}: {
  router: ReturnType<typeof useRouter>;
  folderId: string | null;
  isTrashView: boolean;
  currentFolder: FolderSummary | null;
  breadcrumbs: BreadcrumbItem[];
  directoryCapabilities: Capability[] | undefined;
  effectiveRole: ResourceRole;
  rootCreationRestricted: boolean;
  selectedKeys: Set<string>;
  touchRecentFile: (fileId: string) => void;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorKey: Dispatch<SetStateAction<string | null>>;
  setFocusedRowKey: Dispatch<SetStateAction<string | null>>;
  setContextMenu: Dispatch<
    SetStateAction<{
      x: number;
      y: number;
      row: WorkspaceTableRow | null;
      trigger: HTMLElement | null;
    } | null>
  >;
  setBackgroundMenu: Dispatch<
    SetStateAction<{
      x: number;
      y: number;
      trigger: HTMLElement | null;
    } | null>
  >;
  setFolderNameInput: Dispatch<SetStateAction<string>>;
  setFolderClassInput: Dispatch<SetStateAction<ClassificationLabel>>;
  setActiveModal: Dispatch<SetStateAction<ActiveModal | null>>;
  setError: (error: string | null) => void;
}) {
  const handleDownloadFile = useCallback(
    async (fileId: string) => {
      try {
        const res = await getFileContentUrl(fileId, 'download');
        window.open(res.url, '_blank', 'noopener,noreferrer');
      } catch (err) {
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'ダウンロードリンクの取得に失敗しました'
        );
      }
    },
    [setError]
  );

  const openFileOrEditor = useCallback(
    (file: { id: string; capabilities?: Capability[] }) => {
      const access = {
        capabilities: file.capabilities ?? directoryCapabilities,
        effectiveRole,
      };
      if (!canAccess(access, 'item.preview')) {
        setError(
          '現在のロールではファイルのプレビュー・ダウンロードを開けません。投稿専用 (Uploader) の場合、アップロードしたファイルは一覧に表示されません。'
        );
        return;
      }
      touchRecentFile(file.id);
      window.open(
        `/workspace/file/${encodeURIComponent(file.id)}`,
        '_blank'
      );
    },
    [directoryCapabilities, effectiveRole, setError, touchRecentFile]
  );

  const handleSearchSelect = useCallback(
    (item: SearchResultItem) => {
      if (item.folderId && item.folderId !== folderId) {
        router.push(`/workspace?folderId=${encodeURIComponent(item.folderId)}`);
      }
      openFileOrEditor({ id: item.id });
    },
    [folderId, router, openFileOrEditor]
  );

  const openRow = useCallback(
    (row: WorkspaceTableRow) => {
      if (isTrashView) return;
      if (row.kind === 'folder') {
        router.push(`/workspace?folderId=${encodeURIComponent(row.folder.id)}`);
        return;
      }
      openFileOrEditor(row.file);
    },
    [isTrashView, router, openFileOrEditor]
  );

  /**
   * Google Drive-compatible right-click normalization: right-clicking outside the
   * current selection selects that row first so the menu target and the visible
   * selection never disagree.
   */
  const openRowContextMenu = useCallback(
    (event: React.MouseEvent, row: WorkspaceTableRow) => {
      if (isTrashView) return;
      event.preventDefault();
      const rowKey = getWorkspaceRowKey(row);
      setFocusedRowKey(rowKey);
      const resolved = resolveContextSelection(selectedKeys, rowKey);
      if (resolved.changed) {
        setSelectedKeys(resolved.selectedKeys);
        setSelectionAnchorKey(resolved.anchorKey);
      }
      setBackgroundMenu(null);
      const current = event.currentTarget;
      const trigger =
        current instanceof HTMLElement
          ? current.matches('button')
            ? current
            : current.querySelector<HTMLElement>('[data-row-name-trigger="true"]') ??
              current
          : null;
      setContextMenu({ x: event.clientX, y: event.clientY, row, trigger });
    },
    [
      isTrashView,
      selectedKeys,
      setFocusedRowKey,
      setSelectedKeys,
      setSelectionAnchorKey,
      setBackgroundMenu,
      setContextMenu,
    ]
  );

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
    setFocusedRowKey(null);
  }, [setSelectedKeys, setSelectionAnchorKey, setFocusedRowKey]);

  const navigateToParentFolder = useCallback(() => {
    if (isTrashView) return;
    if (currentFolder?.parent_id) {
      router.push(
        `/workspace?folderId=${encodeURIComponent(currentFolder.parent_id)}`
      );
      return;
    }
    if (breadcrumbs.length > 1) {
      const parentCrumb = breadcrumbs[breadcrumbs.length - 2];
      if (parentCrumb) {
        router.push(`/workspace?folderId=${encodeURIComponent(parentCrumb.id)}`);
        return;
      }
    }
    if (folderId) {
      router.push('/workspace');
    }
  }, [isTrashView, currentFolder, breadcrumbs, folderId, router]);

  const openCreateFolderModal = useCallback(() => {
    if (rootCreationRestricted) {
      setError(ROOT_CREATION_NOTICE);
      return;
    }
    setFolderNameInput('');
    setFolderClassInput(
      currentFolder?.classification === 'confidential'
        ? 'confidential'
        : 'internal'
    );
    setActiveModal({ kind: 'createFolder', parentId: folderId ?? null });
  }, [
    currentFolder?.classification,
    folderId,
    rootCreationRestricted,
    setError,
    setFolderNameInput,
    setFolderClassInput,
    setActiveModal,
  ]);

  const handleBackgroundContextMenu = useCallback(
    (event: React.MouseEvent) => {
      if (isTrashView) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-row-index], thead, th, button, a, input, select, textarea, [role="menu"], [role="checkbox"], [data-marquee-ignore="true"]'
        )
      ) {
        return;
      }
      event.preventDefault();
      setContextMenu(null);
      setBackgroundMenu({
        x: event.clientX,
        y: event.clientY,
        trigger:
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('[data-workspace-table="true"]')
            : null,
      });
    },
    [isTrashView, setContextMenu, setBackgroundMenu]
  );

  const handleBackgroundEmptyClick = useCallback(
    (event: React.MouseEvent) => {
      if (isTrashView) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          '[data-row-index], thead, th, button, a, input, select, textarea, [role="menu"], [data-marquee-ignore="true"]'
        )
      ) {
        return;
      }
      clearSelection();
    },
    [isTrashView, clearSelection]
  );

  return {
    handleDownloadFile,
    openFileOrEditor,
    handleSearchSelect,
    openRow,
    openRowContextMenu,
    clearSelection,
    navigateToParentFolder,
    openCreateFolderModal,
    handleBackgroundContextMenu,
    handleBackgroundEmptyClick,
  };
}
