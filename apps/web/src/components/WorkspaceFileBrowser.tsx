'use client';

import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Inbox,
  Info,
  Keyboard,
  LayoutGrid,
  Link2,
  List,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Scissors,
  Shield,
  Sparkles,
  Star,
  Tag,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppShellRail,
  type WorkspacePaletteActions,
} from '@/components/AppShellRail';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ClassificationCell } from '@/components/ClassificationCell';
import { CreateFileRequestModal } from '@/components/CreateFileRequestModal';
import { FileDropzoneUploader } from '@/components/FileDropzoneUploader';
import { ModalShell } from '@/components/ModalShell';
import { MoveCopyTreeModal } from '@/components/MoveCopyTreeModal';
import { PermissionsModal } from '@/components/PermissionsModal';
import {
  type PreviewTargetFile,
  SecurePreviewModal,
} from '@/components/SecurePreviewModal';
import { SharePopover } from '@/components/SharePopover';
import { SignInCard } from '@/components/SignInCard';
import { WorkspaceBackgroundMenu } from '@/components/WorkspaceBackgroundMenu';
import {
  type ContextMenuActionId,
  WorkspaceContextMenu,
} from '@/components/WorkspaceContextMenu';
import {
  type InspectorTarget,
  WorkspaceInspectorDrawer,
} from '@/components/WorkspaceInspectorDrawer';
import { WorkspaceItemCard } from '@/components/WorkspaceItemCard';
import {
  ClassificationPickerModal,
  ShortcutsHelpModal,
} from '@/components/WorkspaceKeyboardOverlays';
import { WorkspaceBreadcrumbs } from '@/components/WorkspaceBreadcrumbs';
import { WorkspaceSelectionCheckbox } from '@/components/WorkspaceSelectionCheckbox';
import {
  getDropTargetClassName,
  WorkspaceDragProvider,
} from '@/components/WorkspaceDragPortal';
import {
  type DragWorkspaceItem,
  ROOT_DROP_ID,
} from '@/lib/drag-drop-controller';
import {
  ApiClientError,
  getFileContentUrl,
  listTrash,
} from '@/lib/files-api';
import {
  formatBytes,
  formatDateTime,
  hasRoleAtLeast,
  isPdfFile,
} from '@/lib/formatters';
import { IntentPrefetcher } from '@/lib/intent-prefetch';
import {
  isEditableTarget,
  isImeComposingEvent,
  isInteractiveNonRowTarget,
  isTrashShortcut,
  keyboardScopes,
  selectKeyRange,
  shouldHandleWorkspaceKey,
  toggleKeySelection,
} from '@/lib/keyboard-shortcuts';
import {
  getWorkspaceSyncStore,
  useWorkspaceDirectory,
} from '@/lib/sync-store';
import { useMarqueeSelection } from '@/lib/use-marquee-selection';
import { useTableVirtualWindow } from '@/lib/use-virtual-window';
import {
  getWorkspaceRowKey,
  isRowControlTarget,
  isRowSelectable,
  type InlineRenameState,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import { useWorkspaceViewPrefs } from '@/lib/use-workspace-view-prefs';
import {
  getWorkspaceClipboardStore,
  useWorkspaceClipboard,
} from '@/lib/workspace-clipboard';
import {
  buildContextMenuCapabilities,
  resolveContextSelection,
  resolvePointerSelection,
  resolveTargetRows,
} from '@/lib/workspace-actions';
import {
  chunkItemsIntoGridRows,
  getAriaSortValue,
  sortWorkspaceFoldersAndFiles,
} from '@/lib/workspace-sort-and-view';
import type {
  ClassificationLabel,
  FileItem,
  FolderSummary,
  ResourceRole,
  SearchResultItem,
} from '@/types/files';

type ClassificationPickerState =
  | { mode: 'single'; file: FileItem }
  | { mode: 'bulk'; files: FileItem[] };

/**
 * Rows/cards are full click targets (Google Drive parity), but inner controls such as
 * action icons, checkboxes, menus, and rename inputs must not trigger row selection.
 * The row name button is deliberately allowed so clicking the name selects the row.
 */
function BulkActionButton({
  label,
  shortcut,
  icon,
  onClick,
  variant = 'default',
}: {
  label: string;
  shortcut?: string;
  icon: React.ReactNode;
  onClick: () => void;
  variant?: 'default' | 'primary' | 'danger';
}) {
  const title = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      onClick={onClick}
      className={`inline-flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-[0.6875rem] font-medium transition ${
        variant === 'primary'
          ? 'border-[#5e6ad2] bg-[#5e6ad2] text-white hover:bg-[#4f5ac2]'
          : variant === 'danger'
            ? 'border-[#f3d3d5] bg-white text-[#d9343f] hover:bg-[#fdf0f1]'
            : 'border-[#dfe2f5] bg-white text-[#3c3f46] hover:bg-[#f2f2f4]'
      }`}
    >
      {icon}
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function toDragWorkspaceItem(
  row: WorkspaceTableRow,
  fallbackRole: ResourceRole
): DragWorkspaceItem {
  if (row.kind === 'folder') {
    return {
      type: 'folder',
      id: row.folder.id,
      name: row.folder.name,
      parentId: row.folder.parent_id,
      classification: row.folder.classification,
      effectiveRole: row.folder.effectiveRole ?? fallbackRole,
    };
  }
  return {
    type: 'file',
    id: row.file.id,
    name: row.file.name,
    parentId: row.file.folder_id,
    classification: row.file.classification,
    effectiveRole: fallbackRole,
  };
}

function collectDragItemsForRow(
  row: WorkspaceTableRow,
  selectedRows: WorkspaceTableRow[],
  selectedKeys: Set<string>,
  isTrashView: boolean,
  fallbackRole: ResourceRole
): DragWorkspaceItem[] {
  if (isTrashView || !isRowSelectable(row)) return [];
  const rowKey = getWorkspaceRowKey(row);
  if (selectedKeys.has(rowKey) && selectedRows.length > 0) {
    return selectedRows
      .filter((r) => isRowSelectable(r))
      .map((r) => toDragWorkspaceItem(r, fallbackRole));
  }
  return [toDragWorkspaceItem(row, fallbackRole)];
}

type ActiveModal =
  | { kind: 'permissions'; targetType: 'folder' | 'file'; targetId: string; targetName: string; effectiveRole: ResourceRole }
  | { kind: 'share'; targetType: 'folder' | 'file'; targetId: string; targetName: string; classification: ClassificationLabel; canEdit: boolean }
  | { kind: 'fileRequest'; folderId: string; folderName: string; canEdit: boolean }
  | { kind: 'createFolder'; parentId: string | null }
  | { kind: 'renameFolder'; folder: FolderSummary }
  | { kind: 'renameFile'; file: FileItem };

export function WorkspaceFileBrowser() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderId = searchParams.get('folderId');
  const previewFileId = searchParams.get('preview');
  const isTrashView = searchParams.get('view') === 'trash';

  const syncStore = getWorkspaceSyncStore();
  const { snapshot, directory, pinnedFolders } = useWorkspaceDirectory(
    isTrashView ? null : folderId
  );
  const user = snapshot.user;
  const authChecked = snapshot.authStatus !== 'unknown';

  const prefetcher = useMemo(
    () => new IntentPrefetcher(syncStore),
    [syncStore]
  );

  const [trashFolders, setTrashFolders] = useState<FolderSummary[]>([]);
  const [trashFiles, setTrashFiles] = useState<FileItem[]>([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashLoaded, setTrashLoaded] = useState(false);

  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentFolder = isTrashView ? null : directory.folder;
  const effectiveRole: ResourceRole = isTrashView ? 'editor' : directory.effectiveRole;
  const breadcrumbs = isTrashView ? [] : directory.breadcrumbs;
  const folders = isTrashView ? trashFolders : directory.folders;
  const files = isTrashView ? trashFiles : directory.files;
  const nextCursor = isTrashView ? null : directory.nextCursor;

  const isInitialLoading = isTrashView
    ? trashLoading && !trashLoaded
    : !directory.existsInCache &&
      (!snapshot.bootstrapDone || snapshot.revalidating);

  const [previewTarget, setPreviewTarget] = useState<{
    file: PreviewTargetFile;
    canDownload: boolean;
  } | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal | null>(null);

  // Modal form state for create/rename folder
  const [folderNameInput, setFolderNameInput] = useState('');
  const [folderClassInput, setFolderClassInput] =
    useState<ClassificationLabel>('internal');
  const [modalSubmitting, setModalSubmitting] = useState(false);

  // Keyboard navigation, selection, inline rename, picker, and help overlay state
  const [focusedRowKey, setFocusedRowKey] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [selectionAnchorKey, setSelectionAnchorKey] = useState<string | null>(null);
  const [inlineRename, setInlineRename] = useState<InlineRenameState | null>(null);
  const [classificationPicker, setClassificationPicker] =
    useState<ClassificationPickerState | null>(null);
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false);

  const modalScopeTokenRef = useRef<string | null>(null);
  const inlineScopeTokenRef = useRef<string | null>(null);
  const inlineCommittedRef = useRef<string | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => prefetcher.cancel(), [prefetcher]);

  useEffect(() => {
    setFocusedRowKey(null);
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
    setInlineRename(null);
    setClassificationPicker(null);
    setContextMenu(null);
    setBackgroundMenu(null);
  }, [folderId, isTrashView]);

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

  useEffect(() => {
    if (!inlineRename) return;
    const token = keyboardScopes.pushScope('inlineRename');
    inlineScopeTokenRef.current = token;
    const focusTimer = window.setTimeout(() => {
      const input = inlineInputRef.current;
      if (!input) return;
      input.focus();
      const dotIdx =
        inlineRename.kind === 'file' ? inlineRename.value.lastIndexOf('.') : -1;
      input.setSelectionRange(0, dotIdx > 0 ? dotIdx : inlineRename.value.length);
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

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const hydrated = await syncStore.hydrateFromScopeHint();
      if (!cancelled && hydrated && !isTrashView) {
        void syncStore.ensureDirectoryLoaded(folderId).catch(() => undefined);
      }
      await syncStore.bootstrap();
    })();
    return () => {
      cancelled = true;
    };
    // Initial SWR hydration + bootstrap once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStore]);

  // Idle-time warm-up ONLY of static pdfjs-dist runtime chunk (NEVER calls /content-url)
  useEffect(() => {
    if (snapshot.authStatus !== 'authenticated' || !user) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof w.requestIdleCallback === 'function') {
      const idleId = w.requestIdleCallback(
        () => prefetcher.warmPdfPreviewRuntime(),
        { timeout: 2500 }
      );
      return () => w.cancelIdleCallback?.(idleId);
    }
    const timer = window.setTimeout(
      () => prefetcher.warmPdfPreviewRuntime(),
      1200
    );
    return () => window.clearTimeout(timer);
  }, [snapshot.authStatus, user, prefetcher]);

  // Fail-closed handler for instant SCIM suspension, permission revocation, and share revocation
  const clipboardStore = getWorkspaceClipboardStore();
  const clipboardState = useWorkspaceClipboard();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    row: WorkspaceTableRow | null;
    trigger: HTMLElement | null;
  } | null>(null);
  const [backgroundMenu, setBackgroundMenu] = useState<{
    x: number;
    y: number;
    trigger: HTMLElement | null;
  } | null>(null);
  const backgroundFileInputRef = useRef<HTMLInputElement>(null);
  const backgroundFolderInputRef = useRef<HTMLInputElement>(null);
  const marqueeSurfaceRef = useRef<HTMLDivElement>(null);
  const [moveCopyModal, setMoveCopyModal] = useState<{
    items: DragWorkspaceItem[];
    modeHint: 'move' | 'copy';
  } | null>(null);
  const {
    sortBy,
    sortDir,
    viewMode,
    setSortBy,
    setSortDir,
    setViewMode,
    handleSortHeaderClick,
    handleToggleViewMode,
  } = useWorkspaceViewPrefs(user);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const sortDrainErrorKeyRef = useRef<string | null>(null);
  const pasteEnqueueFilesRef = useRef<((files: FileList | File[]) => void) | null>(
    null
  );
  const lastOsPasteAtRef = useRef(0);
  const lastVirtualPasteAtRef = useRef(0);
  const openedPreviewParamRef = useRef<string | null>(null);

  useEffect(() => {
    clipboardStore.setScope(
      user ? { tenantId: user.tenantId, id: user.id } : null
    );
  }, [clipboardStore, user]);

  useEffect(() => {
    return syncStore.subscribeSecurityRevocations((event) => {
      if (event.kind === 'user.suspended') {
        clipboardStore.purge();
        setInspectorOpen(false);
        setContextMenu(null);
        setBackgroundMenu(null);
        setMoveCopyModal(null);
        setPreviewTarget(null);
        setActiveModal(null);
        setInlineRename(null);
        setClassificationPicker(null);
        setShortcutsHelpOpen(false);
        setSelectedKeys(new Set());
        setError(
          'アカウント停止またはセッション失効のためワークスペースキャッシュを消去しました。'
        );
        return;
      }

      if (event.kind === 'permission.revoke') {
        setPreviewTarget((prev) => {
          if (!prev) return null;
          setError(
            'アクセス権限が取り消されたためプレビューを安全に閉じました。'
          );
          return null;
        });
        setActiveModal((prev) =>
          prev && (prev.kind === 'share' || prev.kind === 'permissions')
            ? null
            : prev
        );
        return;
      }

      if (event.kind === 'shared_link.revoke') {
        setActiveModal((prev) => (prev?.kind === 'share' ? null : prev));
      }
    });
  }, [syncStore, clipboardStore]);

  const loadActiveView = useCallback(
    async (options?: { force?: boolean }) => {
      if (snapshot.authStatus !== 'authenticated' || !user) return;
      setError(null);

      try {
        if (isTrashView) {
          setTrashLoading(true);
          const trash = await listTrash(100);
          setTrashFolders(trash.folders);
          setTrashFiles(trash.files);
          setTrashLoaded(true);
        } else {
          await syncStore.ensureDirectoryLoaded(folderId, {
            force: options?.force,
          });
        }
      } catch (err) {
        setError(
          err instanceof ApiClientError
            ? err.message
            : 'フォルダ内容の取得に失敗しました'
        );
      } finally {
        if (isTrashView) {
          setTrashLoading(false);
        }
      }
    },
    [snapshot.authStatus, user, isTrashView, syncStore, folderId]
  );

  useEffect(() => {
    if (snapshot.authStatus === 'authenticated' && user) {
      void loadActiveView();
    }
  }, [snapshot.authStatus, user, loadActiveView]);

  async function handleLoadMore() {
    if (!nextCursor || loadingMore || isTrashView) return;
    setLoadingMore(true);
    try {
      await syncStore.loadMoreDirectory(folderId);
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : '追加読み込みに失敗しました'
      );
    } finally {
      setLoadingMore(false);
    }
  }

  function handleCreateOrRenameSubmit(e: React.FormEvent) {
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

  function handleTogglePin(folder: FolderSummary) {
    setError(null);
    const res = syncStore.optimisticToggleFolderPin(folder);
    if (!res.ok) {
      setError(res.error ?? 'ピン留めの変更に失敗しました');
    }
  }

  function handleRestoreFolder(folder: FolderSummary) {
    setError(null);
    setTrashFolders((prev) => prev.filter((f) => f.id !== folder.id));
    syncStore.optimisticRestoreFolder(folder, 'rename');
  }

  function handleRestoreFile(file: FileItem) {
    setError(null);
    setTrashFiles((prev) => prev.filter((f) => f.id !== file.id));
    syncStore.optimisticRestoreFile(file);
  }

  async function handleDownloadFile(fileId: string) {
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
  }

  function handleSearchSelect(item: SearchResultItem) {
    if (item.folderId && item.folderId !== folderId) {
      router.push(`/workspace?folderId=${encodeURIComponent(item.folderId)}`);
    }
    setPreviewTarget({
      file: {
        id: item.id,
        folderId: item.folderId,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        classification: item.classification,
      },
      canDownload: true,
    });
  }

  const canEditCurrentFolder = currentFolder
    ? hasRoleAtLeast(effectiveRole, 'editor')
    : true;
  const canDownloadCurrentFolder = currentFolder
    ? hasRoleAtLeast(effectiveRole, 'viewer')
    : true;
  const canManageCurrentFolderPerms = currentFolder
    ? hasRoleAtLeast(effectiveRole, 'co_owner')
    : false;
  const isPrivilegedAdmin =
    user?.role === 'sys_admin' || user?.role === 'sec_admin';

  // Background catch-up when sorting an incomplete multi-page folder off default name ASC
  useEffect(() => {
    if (isTrashView || !user || snapshot.authStatus !== 'authenticated') return;
    if (!nextCursor || (sortBy === 'name' && sortDir === 'asc')) return;
    const drainKey = `${folderId ?? '__ROOT__'}:${nextCursor}`;
    if (sortDrainErrorKeyRef.current === drainKey) return;
    let cancelled = false;
    void syncStore.loadMoreDirectory(folderId).catch(() => {
      if (!cancelled) {
        sortDrainErrorKeyRef.current = drainKey;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    isTrashView,
    user,
    snapshot.authStatus,
    folderId,
    nextCursor,
    sortBy,
    sortDir,
    syncStore,
  ]);

  const { folders: sortedFolders, files: sortedFiles } = useMemo(
    () =>
      sortWorkspaceFoldersAndFiles({
        folders,
        files,
        sortBy,
        sortDir,
        isTrashView,
      }),
    [folders, files, sortBy, sortDir, isTrashView]
  );

  const rows = useMemo<WorkspaceTableRow[]>(
    () => [
      ...sortedFolders.map((folder) => ({ kind: 'folder' as const, folder })),
      ...sortedFiles.map((file) => ({ kind: 'file' as const, file })),
    ],
    [sortedFolders, sortedFiles]
  );

  const GRID_COLUMNS = 4;
  const gridRows = useMemo(
    () => chunkItemsIntoGridRows(rows, GRID_COLUMNS),
    [rows]
  );

  const virtualItemCount = viewMode === 'grid' ? gridRows.length : rows.length;
  const virtualWindow = useTableVirtualWindow(virtualItemCount, {
    rowHeight: viewMode === 'grid' ? 156 : 52,
    overscan: viewMode === 'grid' ? 4 : 10,
    threshold: viewMode === 'grid' ? 12 : 40,
  });

  const visibleRows = useMemo(
    () =>
      viewMode === 'list'
        ? rows.slice(virtualWindow.startIndex, virtualWindow.endIndex)
        : [],
    [viewMode, rows, virtualWindow.startIndex, virtualWindow.endIndex]
  );

  const visibleGridRows = useMemo(
    () =>
      viewMode === 'grid'
        ? gridRows.slice(virtualWindow.startIndex, virtualWindow.endIndex)
        : [],
    [viewMode, gridRows, virtualWindow.startIndex, virtualWindow.endIndex]
  );

  const scrollLinearRowIntoView = useCallback(
    (linearIdx: number) => {
      const targetIdx =
        viewMode === 'grid' ? Math.floor(linearIdx / GRID_COLUMNS) : linearIdx;
      virtualWindow.scrollRowIntoView(targetIdx);
    },
    [viewMode, virtualWindow]
  );

  const orderedRowKeys = useMemo(() => rows.map(getWorkspaceRowKey), [rows]);

  const focusedRowIndex = useMemo(() => {
    if (!focusedRowKey) return -1;
    return orderedRowKeys.indexOf(focusedRowKey);
  }, [orderedRowKeys, focusedRowKey]);

  const focusedRow =
    focusedRowIndex >= 0 ? rows[focusedRowIndex] ?? null : null;

  const selectedRows = useMemo(
    () =>
      rows.filter(
        (row) => isRowSelectable(row) && selectedKeys.has(getWorkspaceRowKey(row))
      ),
    [rows, selectedKeys]
  );

  const inspectorTarget = useMemo<InspectorTarget | null>(() => {
    if (isTrashView) return null;
    const candidate = focusedRow ?? selectedRows[0] ?? null;
    if (candidate) {
      return candidate.kind === 'folder'
        ? { kind: 'folder', folder: candidate.folder }
        : { kind: 'file', file: candidate.file };
    }
    return currentFolder ? { kind: 'folder', folder: currentFolder } : null;
  }, [isTrashView, focusedRow, selectedRows, currentFolder]);

  const selectableRowKeys = useMemo(
    () => rows.filter(isRowSelectable).map(getWorkspaceRowKey),
    [rows]
  );

  const previewableFiles = useMemo(
    () => sortedFiles.filter((f) => !f.optimistic && f.upload_state !== 'pending'),
    [sortedFiles]
  );

  const previewFileIndex = previewTarget
    ? previewableFiles.findIndex((f) => f.id === previewTarget.file.id)
    : -1;

  const canEditRow = useCallback(
    (row: WorkspaceTableRow): boolean => {
      if (isTrashView) return false;
      if (row.kind === 'folder') {
        return row.folder.effectiveRole
          ? hasRoleAtLeast(row.folder.effectiveRole, 'editor')
          : canEditCurrentFolder;
      }
      return isRowSelectable(row) && canEditCurrentFolder;
    },
    [isTrashView, canEditCurrentFolder]
  );

  const openPreviewForFile = useCallback(
    (file: FileItem) => {
      if (file.optimistic || file.upload_state === 'pending' || isTrashView) return;
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
    [canDownloadCurrentFolder, isTrashView]
  );

  const openRow = useCallback(
    (row: WorkspaceTableRow) => {
      if (isTrashView) return;
      if (row.kind === 'folder') {
        router.push(`/workspace?folderId=${encodeURIComponent(row.folder.id)}`);
        return;
      }
      openPreviewForFile(row.file);
    },
    [isTrashView, router, openPreviewForFile]
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

  /**
   * Google Drive-compatible pointer selection:
   * - plain click: exclusive selection
   * - ⌘/Ctrl+click: toggle
   * - Shift+click: range from the anchor
   */
  const selectRowFromPointer = useCallback(
    (
      event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
      rowKey: string,
      selectable: boolean
    ) => {
      if (!selectable) return;
      setFocusedRowKey(rowKey);
      const resolved = resolvePointerSelection({
        orderedKeys: orderedRowKeys,
        selectedKeys,
        anchorKey: selectionAnchorKey,
        rowKey,
        modifiers: event,
      });
      setSelectedKeys(resolved.selectedKeys);
      setSelectionAnchorKey(resolved.anchorKey);
    },
    [orderedRowKeys, selectedKeys, selectionAnchorKey]
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
    [isTrashView, selectedKeys]
  );

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    setSelectionAnchorKey(null);
    setFocusedRowKey(null);
  }, []);

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
    [isTrashView, canEditRow, syncStore, virtualWindow]
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
              ? syncStore.optimisticRenameFile(file, trimmed, effectiveRole)
              : { ok: false, error: 'ファイルが見つかりません' };
          })();

    if (!res.ok) {
      setError(res.error ?? '名前の変更に失敗しました');
    }
    setInlineRename(null);
  }, [inlineRename, folders, files, syncStore, effectiveRole]);

  const openClassificationPickerFromTarget = useCallback(() => {
    if (isTrashView) return;
    const selectedFiles = selectedRows
      .filter((r): r is { kind: 'file'; file: FileItem } => r.kind === 'file')
      .map((r) => r.file);

    const targetFiles =
      selectedFiles.length > 0
        ? selectedFiles
        : focusedRow?.kind === 'file' && isRowSelectable(focusedRow)
          ? [focusedRow.file]
          : [];

    if (targetFiles.length === 0) {
      syncStore.pushToast({
        kind: 'info',
        message: '機密区分の変更はファイルを選択またはフォーカスして実行してください',
      });
      return;
    }

    if (!canEditCurrentFolder && !isPrivilegedAdmin) {
      syncStore.pushToast({
        kind: 'error',
        message: '機密区分を変更する権限がありません',
      });
      return;
    }

    if (targetFiles.length === 1) {
      setClassificationPicker({ mode: 'single', file: targetFiles[0]! });
    } else {
      setClassificationPicker({ mode: 'bulk', files: targetFiles });
    }
  }, [
    isTrashView,
    selectedRows,
    focusedRow,
    syncStore,
    canEditCurrentFolder,
    isPrivilegedAdmin,
  ]);

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
            firstError = res.error ?? '一部の機密区分を更新できませんでした';
          }
        }
        if (firstError) setError(firstError);
        setSelectedKeys(new Set());
      }
      setClassificationPicker(null);
    },
    [classificationPicker, syncStore, effectiveRole, isPrivilegedAdmin]
  );

  const handleApproveSingleAi = useCallback(
    (file: FileItem): { ok: boolean; error?: string } => {
      if (!canEditCurrentFolder && !isPrivilegedAdmin) {
        const message = 'AI分類提案を承認する権限がありません';
        setError(message);
        return { ok: false, error: message };
      }
      const res = syncStore.optimisticUpdateFileClassification(
        file,
        { acceptSuggestion: true },
        { effectiveRole, isPrivilegedAdmin }
      );
      if (!res.ok) {
        setError(res.error ?? 'AI分類を承認できませんでした');
      }
      return res;
    },
    [canEditCurrentFolder, isPrivilegedAdmin, syncStore, effectiveRole]
  );

  const handleBulkApproveAi = useCallback(() => {
    const candidates = selectedRows
      .filter((r): r is { kind: 'file'; file: FileItem } => r.kind === 'file')
      .map((r) => r.file)
      .filter((f) => f.ai_suggested_label != null);
    if (candidates.length === 0) return;
    if (!canEditCurrentFolder && !isPrivilegedAdmin) {
      setError('AI分類提案を承認する権限がありません');
      return;
    }

    let firstError: string | null = null;
    for (const file of candidates) {
      if (!file.ai_suggested_label) continue;
      const res = syncStore.optimisticUpdateFileClassification(
        file,
        { acceptSuggestion: true },
        { effectiveRole, isPrivilegedAdmin }
      );
      if (!res.ok && !firstError) {
        firstError = res.error ?? '一部のAI分類を承認できませんでした';
      }
    }
    if (firstError) setError(firstError);
    setSelectedKeys(new Set());
  }, [
    selectedRows,
    canEditCurrentFolder,
    isPrivilegedAdmin,
    syncStore,
    effectiveRole,
  ]);

  const openShareFromTarget = useCallback(() => {
    if (isTrashView) return;
    const row = focusedRow ?? selectedRows[0] ?? null;
    if (!row) return;
    if (!canEditRow(row)) {
      syncStore.pushToast({
        kind: 'error',
        message: '共有リンクの作成には編集者以上の権限が必要です',
      });
      return;
    }
    if (row.kind === 'folder') {
      setActiveModal({
        kind: 'share',
        targetType: 'folder',
        targetId: row.folder.id,
        targetName: row.folder.name,
        classification: row.folder.classification,
        canEdit: true,
      });
    } else {
      setActiveModal({
        kind: 'share',
        targetType: 'file',
        targetId: row.file.id,
        targetName: row.file.name,
        classification: row.file.classification,
        canEdit: true,
      });
    }
  }, [isTrashView, focusedRow, selectedRows, canEditRow, syncStore]);

  const trashSelectedOrFocused = useCallback(() => {
    if (isTrashView) return;
    const targets =
      selectedRows.length > 0 ? selectedRows : focusedRow ? [focusedRow] : [];
    if (targets.length === 0) return;

    setError(null);
    let moved = 0;
    for (const row of targets) {
      if (!canEditRow(row)) continue;
      if (row.kind === 'folder') {
        const res = syncStore.optimisticSoftDeleteFolder(row.folder);
        if (res.ok) moved += 1;
        else if (!error) setError(res.error ?? 'フォルダの削除に失敗しました');
      } else {
        const res = syncStore.optimisticSoftDeleteFile(
          row.file,
          folderId,
          effectiveRole
        );
        if (res.ok) moved += 1;
        else if (!error) setError(res.error ?? 'ファイルの削除に失敗しました');
      }
    }
    if (moved === 0) {
      syncStore.pushToast({
        kind: 'error',
        message: '削除権限がないか、処理中のアイテムです',
      });
    }
    if (selectedRows.length > 0) {
      setSelectedKeys(new Set());
    }
  }, [
    isTrashView,
    selectedRows,
    focusedRow,
    canEditRow,
    syncStore,
    folderId,
    effectiveRole,
    error,
  ]);

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

  const resolveRowRole = useCallback(
    (row: WorkspaceTableRow): ResourceRole => {
      if (row.kind === 'folder') {
        return row.folder.effectiveRole ?? effectiveRole;
      }
      return effectiveRole;
    },
    [effectiveRole]
  );

  const isSysAdmin = user?.role === 'sys_admin';

  const getShortcutTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]): WorkspaceTableRow[] => {
      if (explicitTargets && explicitTargets.length > 0) {
        return explicitTargets.filter(isRowSelectable);
      }
      if (selectedRows.length > 0) {
        return selectedRows.filter(isRowSelectable);
      }
      if (focusedRow && isRowSelectable(focusedRow)) {
        return [focusedRow];
      }
      return [];
    },
    [selectedRows, focusedRow]
  );

  const toClipboardItems = useCallback((targets: WorkspaceTableRow[]) => {
    return targets.map((row) =>
      row.kind === 'folder'
        ? {
            type: 'folder' as const,
            id: row.folder.id,
            name: row.folder.name,
            parentId: row.folder.parent_id,
            classification: row.folder.classification,
            version: row.folder.version,
          }
        : {
            type: 'file' as const,
            id: row.file.id,
            name: row.file.name,
            parentId: row.file.folder_id,
            classification: row.file.classification,
            version: row.file.meta_version ?? 1,
          }
    );
  }, []);

  const handleCopyTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView || !user) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      const blocked = targets.some(
        (r) => !isSysAdmin && !hasRoleAtLeast(resolveRowRole(r), 'viewer')
      );
      if (blocked) {
        syncStore.pushToast({
          kind: 'error',
          message: 'Previewer 権限のアイテムはコピーできません (DLP 保護)',
        });
        return;
      }
      clipboardStore.setClipboard(
        'copy',
        toClipboardItems(targets),
        { tenantId: user.tenantId, userId: user.id }
      );
      syncStore.pushToast({
        kind: 'info',
        message: `${targets.length} 件をコピーしました（移動先で ⌘V / Ctrl+V）`,
      });
    },
    [
      isTrashView,
      user,
      getShortcutTargets,
      isSysAdmin,
      resolveRowRole,
      clipboardStore,
      toClipboardItems,
      syncStore,
    ]
  );

  const handleCutTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView || !user) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      const blocked = targets.some(
        (r) => !isSysAdmin && !hasRoleAtLeast(resolveRowRole(r), 'editor')
      );
      if (blocked) {
        syncStore.pushToast({
          kind: 'error',
          message: '切り取り（移動）には Editor 以上の権限が必要です',
        });
        return;
      }
      clipboardStore.setClipboard(
        'cut',
        toClipboardItems(targets),
        { tenantId: user.tenantId, userId: user.id }
      );
      syncStore.pushToast({
        kind: 'info',
        message: `${targets.length} 件を切り取りました（移動先で ⌘V / Ctrl+V）`,
      });
    },
    [
      isTrashView,
      user,
      getShortcutTargets,
      isSysAdmin,
      resolveRowRole,
      clipboardStore,
      toClipboardItems,
      syncStore,
    ]
  );

  const handlePasteClipboard = useCallback(
    (targetParentOverride?: string | null) => {
      if (isTrashView) return;
      const clip = clipboardStore.getState();
      if (!clip || clip.items.length === 0) return;

      const destId =
        targetParentOverride !== undefined ? targetParentOverride : folderId ?? null;
      const refs = clip.items.map((it) => ({ type: it.type, id: it.id }));

      setError(null);
      if (clip.mode === 'cut') {
        const res = syncStore.optimisticMoveItems({
          items: refs,
          targetParentId: destId,
        });
        if (!res.ok) {
          setError(res.error ?? '貼り付け移動に失敗しました');
          syncStore.pushToast({
            kind: 'error',
            message: res.error ?? '貼り付け移動に失敗しました',
          });
          return;
        }
        clipboardStore.completePaste();
        setSelectedKeys(new Set());
        return;
      }

      const res = syncStore.optimisticCopyItems({
        items: refs,
        targetParentId: destId,
        mode: 'copy',
        conflictPolicy: 'rename',
      });
      if (!res.ok) {
        setError(res.error ?? '貼り付けコピーに失敗しました');
        syncStore.pushToast({
          kind: 'error',
          message: res.error ?? '貼り付けコピーに失敗しました',
        });
        return;
      }
      setSelectedKeys(new Set());
    },
    [isTrashView, clipboardStore, folderId, syncStore]
  );

  const handleDuplicateTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      setError(null);
      const res = syncStore.optimisticCopyItems({
        items: targets.map((r) =>
          r.kind === 'folder'
            ? { type: 'folder', id: r.folder.id }
            : { type: 'file', id: r.file.id }
        ),
        targetParentId: folderId ?? null,
        mode: 'duplicate',
      });
      if (!res.ok) {
        setError(res.error ?? '複製に失敗しました');
        syncStore.pushToast({
          kind: 'error',
          message: res.error ?? '複製に失敗しました',
        });
      }
    },
    [isTrashView, getShortcutTargets, syncStore, folderId]
  );

  const handleOpenMoveCopyModal = useCallback(
    (explicitTargets?: WorkspaceTableRow[], modeHint: 'move' | 'copy' = 'move') => {
      if (isTrashView) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) {
        syncStore.pushToast({
          kind: 'info',
          message: '移動・コピーするアイテムを選択またはフォーカスしてください',
        });
        return;
      }
      setMoveCopyModal({
        items: targets.map((r) => toDragWorkspaceItem(r, effectiveRole)),
        modeHint,
      });
    },
    [isTrashView, getShortcutTargets, syncStore, effectiveRole]
  );

  const openCreateFolderModal = useCallback(() => {
    setFolderNameInput('');
    setFolderClassInput(
      currentFolder?.classification === 'confidential'
        ? 'confidential'
        : 'internal'
    );
    setActiveModal({ kind: 'createFolder', parentId: folderId ?? null });
  }, [currentFolder?.classification, folderId]);

  const enqueueBackgroundUpload = useCallback(
    (files: FileList | null, source: 'files' | 'folder') => {
      if (!files || files.length === 0) return;
      if (!currentFolder || !canEditCurrentFolder || !pasteEnqueueFilesRef.current) {
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
    [currentFolder, canEditCurrentFolder, syncStore]
  );

  const handleBackgroundMenuAction = useCallback(
    (action: string) => {
      switch (action) {
        case 'newFolder':
          openCreateFolderModal();
          break;
        case 'uploadFiles':
          backgroundFileInputRef.current?.click();
          break;
        case 'uploadFolder':
          backgroundFolderInputRef.current?.click();
          break;
        case 'paste':
          handlePasteClipboard(folderId ?? null);
          break;
        case 'selectAll':
          setSelectedKeys(new Set(selectableRowKeys));
          setSelectionAnchorKey(selectableRowKeys[0] ?? null);
          break;
        case 'refresh':
          void loadActiveView({ force: true });
          break;
        case 'toggleView':
          handleToggleViewMode();
          break;
      }
    },
    [
      openCreateFolderModal,
      handlePasteClipboard,
      folderId,
      selectableRowKeys,
      loadActiveView,
      handleToggleViewMode,
    ]
  );

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
    [isTrashView]
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

  useEffect(() => {
    const input = backgroundFolderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  const marquee = useMarqueeSelection({
    containerRef: virtualWindow.containerRef,
    surfaceRef: marqueeSurfaceRef,
    orderedRowKeys,
    selectedKeys,
    setSelectedKeys,
    setSelectionAnchorKey,
    enabled: !isTrashView && rows.length > 0 && Boolean(user),
    onBackgroundClick: clearSelection,
  });

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
        if (!currentFolder || !canEditCurrentFolder || !pasteEnqueueFilesRef.current) {
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
          return new File([file], `pasted-${Date.now()}-${idx + 1}.${ext}`, {
            type: file.type || 'image/png',
          });
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
    canEditCurrentFolder,
    clipboardStore,
    syncStore,
    handlePasteClipboard,
  ]);

  useEffect(() => {
    if (!authChecked || !user) return;

    function handleWorkspaceKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;

      const topScope = keyboardScopes.getTopScope();

      if (
        e.key === '?' &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditableTarget(e.target) &&
        (topScope === 'workspace' || topScope === 'preview')
      ) {
        e.preventDefault();
        setShortcutsHelpOpen((prev) => !prev);
        return;
      }

      if (!shouldHandleWorkspaceKey(e, topScope)) {
        return;
      }

      if (
        !isTrashView &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'z'
      ) {
        if (!syncStore.getSnapshot().canUndo) return;
        e.preventDefault();
        void syncStore.undoLatest();
        return;
      }

      if (
        !isTrashView &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'a'
      ) {
        if (selectableRowKeys.length === 0) return;
        e.preventDefault();
        setSelectedKeys(new Set(selectableRowKeys));
        return;
      }

      if (e.key === 'Escape') {
        if (selectedKeys.size > 0) {
          e.preventDefault();
          setSelectedKeys(new Set());
          return;
        }
        if (clipboardStore.getItemCount() > 0) {
          e.preventDefault();
          clipboardStore.clear();
          return;
        }
        if (inspectorOpen) {
          e.preventDefault();
          setInspectorOpen(false);
          return;
        }
      }

      if (isTrashShortcut(e)) {
        if (isTrashView || rows.length === 0) return;
        e.preventDefault();
        trashSelectedOrFocused();
        return;
      }

      if (e.shiftKey && e.key === 'F10' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isTrashView) return;
        const targetRow = focusedRow ?? selectedRows[0] ?? null;
        if (!targetRow) return;
        e.preventDefault();
        const rowKey = getWorkspaceRowKey(targetRow);
        setFocusedRowKey(rowKey);
        const resolved = resolveContextSelection(selectedKeys, rowKey);
        if (resolved.changed) {
          setSelectedKeys(resolved.selectedKeys);
          setSelectionAnchorKey(resolved.anchorKey);
        }
        const targetIdx = orderedRowKeys.indexOf(rowKey);
        const tableContainer = virtualWindow.containerRef.current;
        const rowEl =
          targetIdx >= 0
            ? tableContainer?.querySelector<HTMLElement>(
                `[data-row-index="${targetIdx}"]`
              )
            : null;
        const rect = rowEl?.getBoundingClientRect() ??
          tableContainer?.getBoundingClientRect() ?? { left: 260, top: 220 };
        setContextMenu({
          x: Math.round(rect.left + 80),
          y: Math.round(rect.top + 24),
          row: targetRow,
          trigger:
            rowEl?.querySelector<HTMLElement>('[data-row-name-trigger="true"]') ??
            rowEl ??
            tableContainer ??
            null,
        });
        return;
      }

      if (!isTrashView && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const modKey = e.key.toLowerCase();
        if (modKey === 'c') {
          const targets = getShortcutTargets();
          if (targets.length === 0) return;
          e.preventDefault();
          handleCopyTargets(targets);
          return;
        }
        if (modKey === 'x') {
          const targets = getShortcutTargets();
          if (targets.length === 0) return;
          e.preventDefault();
          handleCutTargets(targets);
          return;
        }
        if (modKey === 'v') {
          // Defer 20ms so OS `paste` event wins cleanly if clipboard carries OS files/images;
          // if browser does not dispatch native `paste` (e.g. Ctrl+V on macOS), paste virtual clipboard.
          const pressedAt = performance.now();
          window.setTimeout(() => {
            if (lastOsPasteAtRef.current >= pressedAt - 5) return;
            if (lastVirtualPasteAtRef.current >= pressedAt - 5) return;
            if (clipboardStore.getItemCount() > 0) {
              lastVirtualPasteAtRef.current = performance.now();
              handlePasteClipboard();
            }
          }, 20);
          return;
        }
        if (modKey === 'd') {
          const targets = getShortcutTargets();
          if (targets.length === 0) return;
          e.preventDefault();
          handleDuplicateTargets(targets);
          return;
        }
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const lower = e.key.toLowerCase();

      const moveFocusTo = (nextIdx: number, extendRange: boolean) => {
        const nextKey = orderedRowKeys[nextIdx];
        if (!nextKey) return;
        if (extendRange && !isTrashView) {
          const anchor = selectionAnchorKey ?? focusedRowKey ?? nextKey;
          if (!selectionAnchorKey) {
            setSelectionAnchorKey(anchor);
          }
          setSelectedKeys(selectKeyRange(orderedRowKeys, anchor, nextKey));
        } else if (!isTrashView) {
          // Google Drive parity: a bare arrow moves focus and selection together.
          setSelectedKeys(new Set([nextKey]));
          setSelectionAnchorKey(nextKey);
        }
        setFocusedRowKey(nextKey);
        scrollLinearRowIntoView(nextIdx);
        virtualWindow.containerRef.current?.focus({ preventScroll: true });
      };

      if (e.key === 'ArrowDown' || lower === 'j') {
        if (rows.length === 0) return;
        e.preventDefault();
        const nextIdx =
          focusedRowIndex < 0 ? 0 : Math.min(rows.length - 1, focusedRowIndex + 1);
        moveFocusTo(nextIdx, e.shiftKey);
        return;
      }

      if (e.key === 'ArrowUp' || lower === 'k') {
        if (rows.length === 0) return;
        e.preventDefault();
        const nextIdx =
          focusedRowIndex < 0 ? 0 : Math.max(0, focusedRowIndex - 1);
        moveFocusTo(nextIdx, e.shiftKey);
        return;
      }

      if (e.key === 'Home') {
        if (rows.length === 0) return;
        e.preventDefault();
        moveFocusTo(0, e.shiftKey);
        return;
      }

      if (e.key === 'End') {
        if (rows.length === 0) return;
        e.preventDefault();
        moveFocusTo(rows.length - 1, e.shiftKey);
        return;
      }

      if (e.key === 'F2' || lower === 'r') {
        if (isTrashView || !focusedRow || focusedRowIndex < 0) return;
        e.preventDefault();
        startInlineRename(focusedRow, focusedRowIndex);
        return;
      }

      if (e.key === 'Backspace' || lower === 'h') {
        if (isTrashView) return;
        if (e.key === 'Backspace' && isInteractiveNonRowTarget(e.target)) return;
        e.preventDefault();
        navigateToParentFolder();
        return;
      }

      if (e.key === 'Enter' || lower === 'l') {
        if (e.key === 'Enter' && isInteractiveNonRowTarget(e.target)) return;
        if (!focusedRow || isTrashView) return;
        e.preventDefault();
        if (focusedRow.kind === 'folder') {
          router.push(
            `/workspace?folderId=${encodeURIComponent(focusedRow.folder.id)}`
          );
        } else {
          openPreviewForFile(focusedRow.file);
        }
        return;
      }

      if (e.key === ' ') {
        if (isInteractiveNonRowTarget(e.target)) return;
        if (isTrashView) return;
        e.preventDefault();
        if (focusedRow?.kind === 'file') {
          openPreviewForFile(focusedRow.file);
        }
        return;
      }

      if (lower === 'x') {
        if (isTrashView || !focusedRow || !isRowSelectable(focusedRow)) return;
        e.preventDefault();
        const key = getWorkspaceRowKey(focusedRow);
        setSelectedKeys((prev) => toggleKeySelection(prev, key));
        setSelectionAnchorKey(key);
        return;
      }

      if (lower === 'm') {
        if (isTrashView) return;
        e.preventDefault();
        handleOpenMoveCopyModal();
        return;
      }

      if (lower === 'd') {
        if (isTrashView || !canDownloadCurrentFolder) return;
        const targetFile =
          focusedRow?.kind === 'file'
            ? focusedRow.file
            : selectedRows.find((r): r is { kind: 'file'; file: FileItem } => r.kind === 'file')
                ?.file;
        if (targetFile && targetFile.upload_state !== 'pending' && !targetFile.optimistic) {
          e.preventDefault();
          void handleDownloadFile(targetFile.id);
        }
        return;
      }

      if (lower === 'i') {
        if (isTrashView) return;
        e.preventDefault();
        setInspectorOpen((prev) => !prev);
        return;
      }

      if (lower === 'v') {
        if (isTrashView) return;
        e.preventDefault();
        handleToggleViewMode();
        return;
      }

      if (lower === 's') {
        if (isTrashView) return;
        e.preventDefault();
        openShareFromTarget();
      }
    }

    window.addEventListener('keydown', handleWorkspaceKeyDown);
    return () => window.removeEventListener('keydown', handleWorkspaceKeyDown);
  }, [
    authChecked,
    user,
    isTrashView,
    syncStore,
    selectableRowKeys,
    selectedKeys,
    inspectorOpen,
    selectionAnchorKey,
    focusedRowKey,
    rows,
    focusedRowIndex,
    orderedRowKeys,
    focusedRow,
    selectedRows,
    virtualWindow,
    scrollLinearRowIntoView,
    router,
    navigateToParentFolder,
    openPreviewForFile,
    startInlineRename,
    openClassificationPickerFromTarget,
    openShareFromTarget,
    trashSelectedOrFocused,
    canDownloadCurrentFolder,
    clipboardStore,
    getShortcutTargets,
    handleCopyTargets,
    handleCutTargets,
    handlePasteClipboard,
    handleDuplicateTargets,
    handleOpenMoveCopyModal,
    handleToggleViewMode,
  ]);

  const handleContextMenuAction = useCallback(
    (
      action: ContextMenuActionId,
      primary: WorkspaceTableRow | null,
      targets: WorkspaceTableRow[],
      pasteDestId: string | null | undefined
    ) => {
      switch (action) {
        case 'open':
          if (!primary) return;
          openRow(primary);
          break;
        case 'openInNewTab':
          if (primary?.kind === 'folder') {
            window.open(
              `/workspace?folderId=${encodeURIComponent(primary.folder.id)}`,
              '_blank',
              'noopener,noreferrer'
            );
          } else if (primary?.kind === 'file') {
            const parentQuery = primary.file.folder_id
              ? `folderId=${encodeURIComponent(primary.file.folder_id)}&`
              : '';
            window.open(
              `/workspace?${parentQuery}preview=${encodeURIComponent(primary.file.id)}`,
              '_blank',
              'noopener,noreferrer'
            );
          }
          break;
        case 'copyLink': {
          if (!primary) return;
          const fileParentQuery =
            primary.kind === 'file' && primary.file.folder_id
              ? `folderId=${encodeURIComponent(primary.file.folder_id)}&`
              : '';
          const url =
            primary.kind === 'folder'
              ? `${window.location.origin}/workspace?folderId=${encodeURIComponent(primary.folder.id)}`
              : `${window.location.origin}/workspace?${fileParentQuery}preview=${encodeURIComponent(primary.file.id)}`;
          void navigator.clipboard
            .writeText(url)
            .then(() =>
              syncStore.pushToast({
                kind: 'info',
                message: '内部リンクをコピーしました',
              })
            )
            .catch(() =>
              syncStore.pushToast({
                kind: 'error',
                message: 'リンクをコピーできませんでした',
              })
            );
          break;
        }
        case 'download':
          if (primary?.kind === 'file') {
            handleDownloadFile(primary.file.id);
          }
          break;
        case 'rename':
          if (primary) {
            const idx = orderedRowKeys.indexOf(getWorkspaceRowKey(primary));
            if (idx >= 0) startInlineRename(primary, idx);
          }
          break;
        case 'copy':
          handleCopyTargets(targets);
          break;
        case 'cut':
          handleCutTargets(targets);
          break;
        case 'paste':
          handlePasteClipboard(pasteDestId);
          break;
        case 'duplicate':
          handleDuplicateTargets(targets);
          break;
        case 'moveCopy':
          handleOpenMoveCopyModal(targets, 'move');
          break;
        case 'classify': {
          const targetFiles = targets
            .filter((r): r is { kind: 'file'; file: FileItem } => r.kind === 'file')
            .map((r) => r.file);
          if (targetFiles.length === 1) {
            setClassificationPicker({ mode: 'single', file: targetFiles[0]! });
          } else if (targetFiles.length > 1) {
            setClassificationPicker({ mode: 'bulk', files: targetFiles });
          }
          break;
        }
        case 'share':
          if (!primary) return;
          setActiveModal({
            kind: 'share',
            targetType: primary.kind,
            targetId: primary.kind === 'folder' ? primary.folder.id : primary.file.id,
            targetName:
              primary.kind === 'folder' ? primary.folder.name : primary.file.name,
            classification:
              primary.kind === 'folder'
                ? primary.folder.classification
                : primary.file.classification,
            canEdit: canEditRow(primary),
          });
          break;
        case 'pin':
          if (primary?.kind === 'folder') {
            handleTogglePin(primary.folder);
          }
          break;
        case 'permissions':
          if (primary) {
            setActiveModal({
              kind: 'permissions',
              targetType: primary.kind,
              targetId: primary.kind === 'folder' ? primary.folder.id : primary.file.id,
              targetName:
                primary.kind === 'folder' ? primary.folder.name : primary.file.name,
              effectiveRole: resolveRowRole(primary),
            });
          }
          break;
        case 'inspector':
          if (primary) {
            setFocusedRowKey(getWorkspaceRowKey(primary));
            setInspectorOpen(true);
          }
          break;
        case 'trash':
          for (const r of targets) {
            if (!canEditRow(r)) continue;
            if (r.kind === 'folder') {
              syncStore.optimisticSoftDeleteFolder(r.folder);
            } else {
              syncStore.optimisticSoftDeleteFile(r.file, folderId, effectiveRole);
            }
          }
          if (selectedRows.length > 0) {
            setSelectedKeys(new Set());
          }
          break;
      }
    },
    [
      router,
      openRow,
      openPreviewForFile,
      handleDownloadFile,
      orderedRowKeys,
      startInlineRename,
      handleCopyTargets,
      handleCutTargets,
      handlePasteClipboard,
      handleDuplicateTargets,
      handleOpenMoveCopyModal,
      canEditRow,
      handleTogglePin,
      resolveRowRole,
      syncStore,
      folderId,
      effectiveRole,
      selectedRows.length,
    ]
  );

  const handleDragDropMove = useCallback(
    (items: DragWorkspaceItem[], targetFolderId: string | null) => {
      setError(null);
      const res = syncStore.optimisticMoveItems({
        items: items.map((it) => ({ type: it.type, id: it.id })),
        targetParentId: targetFolderId,
      });
      if (!res.ok) {
        setError(res.error ?? 'アイテムの移動に失敗しました');
        return;
      }
      setSelectedKeys(new Set());
      setSelectionAnchorKey(null);
    },
    [syncStore]
  );

  const workspaceActions = useMemo<WorkspacePaletteActions>(
    () => ({
      hasTargetItem: Boolean(focusedRow || selectedRows.length > 0),
      canClassifyTarget:
        !isTrashView && (canEditCurrentFolder || isPrivilegedAdmin),
      canShareTarget:
        !isTrashView &&
        Boolean((focusedRow && canEditRow(focusedRow)) || selectedRows[0]),
      canTrashTarget:
        !isTrashView &&
        (selectedRows.length > 0 || (focusedRow !== null && canEditRow(focusedRow))),
      canCopyTarget:
        !isTrashView &&
        getShortcutTargets().some(
          (r) => isSysAdmin || hasRoleAtLeast(resolveRowRole(r), 'viewer')
        ),
      canCutTarget:
        !isTrashView &&
        getShortcutTargets().some(
          (r) => isSysAdmin || hasRoleAtLeast(resolveRowRole(r), 'editor')
        ),
      canPasteClipboard:
        !isTrashView && Boolean(clipboardState && clipboardState.items.length > 0),
      canDuplicateTarget:
        !isTrashView &&
        getShortcutTargets().length > 0 &&
        (isSysAdmin ||
          hasRoleAtLeast(effectiveRole, 'viewer')),
      onCommand: (cmdId) => {
        switch (cmdId) {
          case 'cmd:new-folder':
            setFolderNameInput('');
            setFolderClassInput(
              currentFolder?.classification === 'confidential'
                ? 'confidential'
                : 'internal'
            );
            setActiveModal({ kind: 'createFolder', parentId: folderId ?? null });
            break;
          case 'cmd:move-copy':
            handleOpenMoveCopyModal();
            break;
          case 'cmd:copy':
            handleCopyTargets();
            break;
          case 'cmd:cut':
            handleCutTargets();
            break;
          case 'cmd:paste':
            handlePasteClipboard();
            break;
          case 'cmd:duplicate':
            handleDuplicateTargets();
            break;
          case 'cmd:toggle-inspector':
            setInspectorOpen((prev) => !prev);
            break;
          case 'cmd:toggle-view':
            handleToggleViewMode();
            break;
          case 'cmd:change-classification':
            openClassificationPickerFromTarget();
            break;
          case 'cmd:share':
            openShareFromTarget();
            break;
          case 'cmd:trash':
            trashSelectedOrFocused();
            break;
          case 'cmd:shortcuts':
            setShortcutsHelpOpen(true);
            break;
        }
      },
    }),
    [
      focusedRow,
      selectedRows,
      isTrashView,
      canEditCurrentFolder,
      isPrivilegedAdmin,
      isSysAdmin,
      effectiveRole,
      canEditRow,
      resolveRowRole,
      getShortcutTargets,
      clipboardState,
      currentFolder?.classification,
      folderId,
      openClassificationPickerFromTarget,
      openShareFromTarget,
      trashSelectedOrFocused,
      handleOpenMoveCopyModal,
      handleCopyTargets,
      handleCutTargets,
      handlePasteClipboard,
      handleDuplicateTargets,
      handleToggleViewMode,
    ]
  );

  if (!authChecked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#efeff1] text-sm text-slate-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
        セッションを確認中...
      </div>
    );
  }

  if (!user) {
    return (
      <SignInCard
        title="Files ワークスペースへサインイン"
        description="組織の SSO (OIDC) セッションが必要です。認証後、自動的にワークスペースへ戻ります。"
        returnTo="/workspace"
        onSignedIn={(signedIn) => {
          void syncStore.adoptAuthenticatedUser(signedIn);
        }}
      />
    );
  }

  return (
    <WorkspaceDragProvider
      syncStore={syncStore}
      currentFolderId={isTrashView ? null : folderId}
      isSysAdmin={isSysAdmin}
      onPrefetchFolder={(targetId) => prefetcher.scheduleHoverPrefetch(targetId)}
      onDropMove={handleDragDropMove}
    >
      {(dragCtx) => {
        function handleCardCheckboxClick(
          row: WorkspaceTableRow,
          rowKey: string,
          e: React.MouseEvent<HTMLButtonElement>
        ) {
          if (!isRowSelectable(row) || isTrashView) return;
          setFocusedRowKey(rowKey);
          if (e.shiftKey && selectionAnchorKey) {
            setSelectedKeys(
              selectKeyRange(orderedRowKeys, selectionAnchorKey, rowKey)
            );
          } else {
            setSelectedKeys((prev) => toggleKeySelection(prev, rowKey));
            setSelectionAnchorKey(rowKey);
          }
        }

        function handleCardPointerDown(
          row: WorkspaceTableRow,
          e: React.PointerEvent<HTMLDivElement>
        ) {
          const dragItems = collectDragItemsForRow(
            row,
            selectedRows,
            selectedKeys,
            isTrashView,
            effectiveRole
          );
          if (dragItems.length > 0) {
            dragCtx.startPointerDragCandidate(e, dragItems);
          }
        }

        function renderGridRowCard(row: WorkspaceTableRow, globalIdx: number) {
          const rowKey = getWorkspaceRowKey(row);
          const file = row.kind === 'file' ? row.file : null;
          const folder = row.kind === 'folder' ? row.folder : null;
          const isPendingUpload = Boolean(
            file && (file.upload_state === 'pending' || file.optimistic)
          );
          const isCut = Boolean(
            clipboardState?.mode === 'cut' &&
              clipboardStore.isCutPending(
                row.kind,
                row.kind === 'folder' ? row.folder.id : row.file.id
              )
          );
          const isDropEligible = Boolean(
            folder && !isTrashView && folder.deleted_at == null
          );
          const dropClass =
            folder && dragCtx.isDragging && isDropEligible
              ? getDropTargetClassName(folder.id, dragCtx.hoveredTarget)
              : '';

          return (
            <WorkspaceItemCard
              key={rowKey}
              row={row}
              globalIdx={globalIdx}
              isFocused={focusedRowKey === rowKey}
              isSelected={selectedKeys.has(rowKey)}
              rowSelectable={!isTrashView && isRowSelectable(row)}
              isTrashView={isTrashView}
              isInlineRenaming={inlineRename?.rowKey === rowKey}
              isPendingUpload={isPendingUpload}
              isCut={isCut}
              isContextMenuOpen={
                contextMenu?.row
                  ? getWorkspaceRowKey(contextMenu.row) === rowKey
                  : false
              }
              dropClass={dropClass}
              inlineRename={inlineRename}
              inlineInputRef={inlineInputRef}
              inlineCommittedRef={inlineCommittedRef}
              prefetcher={prefetcher}
              onCheckboxClick={(e) =>
                handleCardCheckboxClick(row, rowKey, e)
              }
              onPointerDown={(e) => handleCardPointerDown(row, e)}
              onSelectRow={selectRowFromPointer}
              onOpenRow={openRow}
              onOpenContextMenu={openRowContextMenu}
              onRestoreFolder={handleRestoreFolder}
              onRestoreFile={handleRestoreFile}
              onSetInlineRename={setInlineRename}
              onCommitInlineRename={commitInlineRename}
              onFocusRow={setFocusedRowKey}
            />
          );
        }

        return (
          <div className="flex min-h-screen bg-[#efeff1] text-[#111214]">
          <a
            href="#workspace-main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[#111214] focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-[#5e6ad2]"
          >
            メインコンテンツへスキップ
          </a>
          <AppShellRail
            user={user}
            activeView={isTrashView ? 'trash' : 'workspace'}
            activeFolderId={isTrashView ? null : folderId}
            onSelectResult={handleSearchSelect}
            onSelectFolder={(targetFolderId) =>
              router.push(`/workspace?folderId=${encodeURIComponent(targetFolderId)}`)
            }
            workspaceActions={workspaceActions}
          />

          <main
            id="workspace-main"
            tabIndex={-1}
            className="mb-2 mr-2 mt-2 min-w-0 flex-1 space-y-4 rounded-2xl border border-[#e7e7ea] bg-[#f9f9fa] px-5 py-4 lg:px-7"
          >
        {!isTrashView && (
          <h1 className="sr-only">{currentFolder?.name ?? 'マイファイル'}</h1>
        )}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {isTrashView ? (
              <div className="flex items-center gap-2">
                <Trash2 className="h-5 w-5 text-slate-600" />
                <h1 className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-[#111214]">ゴミ箱</h1>
              </div>
            ) : (
              <WorkspaceBreadcrumbs
                folderId={folderId ?? null}
                breadcrumbs={breadcrumbs}
              />
            )}

            {!isTrashView &&
              (currentFolder ||
                (nextCursor && (sortBy !== 'name' || sortDir !== 'asc'))) && (
                <div className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-[#6b6f76]">
                  {currentFolder && (
                    <>
                      <ClassificationBadge
                        classification={currentFolder.classification}
                        compact
                      />
                      <span>実効ロール: {effectiveRole}</span>
                    </>
                  )}
                  {nextCursor && (sortBy !== 'name' || sortDir !== 'asc') && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[0.6875rem] font-medium text-amber-700">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>ソート全件同期中...</span>
                    </span>
                  )}
                </div>
              )}
          </div>

          <div className="relative flex w-full flex-wrap items-center gap-1.5">
            <div
              aria-hidden={!isTrashView && selectedRows.length > 0}
              inert={!isTrashView && selectedRows.length > 0}
              className={`flex flex-wrap items-center gap-2 ${
                !isTrashView && selectedRows.length > 0 ? 'invisible' : ''
              }`}
            >
            {!isTrashView && (
              <>
              {canEditCurrentFolder && (
                <button
                  type="button"
                  onClick={() => {
                    setFolderNameInput('');
                    setFolderClassInput(
                      currentFolder?.classification === 'confidential'
                        ? 'confidential'
                        : 'internal'
                    );
                    setActiveModal({
                      kind: 'createFolder',
                      parentId: folderId ?? null,
                    });
                  }}
                  className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
                >
                  <FolderPlus className="h-3.5 w-3.5 text-blue-600" />
                  <span>新規フォルダ</span>
                </button>
              )}

              {currentFolder && canEditCurrentFolder && (
                <>
                  <button
                    type="button"
                    onClick={() => handleTogglePin(currentFolder)}
                    className={`inline-flex items-center gap-1.5 h-7 rounded-md border px-2.5 text-[0.75rem] font-medium transition ${
                      currentFolder.is_pinned === 1
                        ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Star
                      className={`h-3.5 w-3.5 ${
                        currentFolder.is_pinned === 1
                          ? 'fill-amber-400 text-[#6b6f76]'
                          : 'text-slate-500'
                      }`}
                    />
                    <span>
                      {currentFolder.is_pinned === 1 ? 'ピン留め中' : 'ピン留め'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setActiveModal({
                        kind: 'fileRequest',
                        folderId: currentFolder.id,
                        folderName: currentFolder.name,
                        canEdit: canEditCurrentFolder,
                      })
                    }
                    className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
                  >
                    <Inbox className="h-3.5 w-3.5 text-indigo-600" />
                    <span>ファイル収集</span>
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setActiveModal({
                        kind: 'share',
                        targetType: 'folder',
                        targetId: currentFolder.id,
                        targetName: currentFolder.name,
                        classification: currentFolder.classification,
                        canEdit: canEditCurrentFolder,
                      })
                    }
                    className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
                  >
                    <Link2 className="h-3.5 w-3.5 text-blue-600" />
                    <span>フォルダ共有</span>
                  </button>
                </>
              )}

              {currentFolder && canManageCurrentFolderPerms && (
                  <button
                    type="button"
                    onClick={() =>
                      setActiveModal({
                        kind: 'permissions',
                        targetType: 'folder',
                        targetId: currentFolder.id,
                        targetName: currentFolder.name,
                        effectiveRole,
                      })
                    }
                    className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
                  >
                    <Shield className="h-3.5 w-3.5 text-slate-600" />
                    <span>権限管理</span>
                  </button>
                )}
              </>
            )}

            <button
              type="button"
              title="リスト / グリッド表示切替 (v)"
              aria-pressed={viewMode === 'grid'}
              onClick={handleToggleViewMode}
              className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
            >
              {viewMode === 'grid' ? (
                <List className="h-3.5 w-3.5 text-slate-600" />
              ) : (
                <LayoutGrid className="h-3.5 w-3.5 text-slate-600" />
              )}
              <span>{viewMode === 'grid' ? 'リスト' : 'グリッド'}</span>
            </button>

            {!isTrashView && (
              <button
                type="button"
                title="詳細インスペクタ (i)"
                aria-pressed={inspectorOpen}
                onClick={() => setInspectorOpen((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-2xs transition ${
                  inspectorOpen
                    ? 'border-[#bcc3ea] bg-[#eef0fb] text-[#4f5ac2]'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <Info className="h-3.5 w-3.5" />
                <span>詳細</span>
              </button>
            )}

            <button
              type="button"
              title="キーボードショートカット (?)"
              onClick={() => setShortcutsHelpOpen(true)}
              className="inline-flex items-center gap-1.5 h-7 rounded-md border border-[#e1e1e4] bg-white px-2.5 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
            >
              <Keyboard className="h-3.5 w-3.5 text-slate-500" />
              <kbd className="font-mono text-[0.625rem] text-slate-500">?</kbd>
            </button>
            </div>

            {!isTrashView && selectedRows.length > 0 && (
              <div
                role="toolbar"
                aria-label="一括操作"
                className="absolute inset-0 z-20 flex items-center gap-1 overflow-x-auto whitespace-nowrap rounded-md border border-[#dfe2f5] bg-[#eef0fb]/95 px-2 py-1 text-[0.6875rem] text-[#3c3f46]"
              >
                <span className="shrink-0 font-semibold">
                  {selectedRows.length} 件選択中
                </span>
                <BulkActionButton
                  label="コピー"
                  shortcut="⌘C"
                  icon={<Copy className="h-3.5 w-3.5 text-slate-500" />}
                  onClick={() => handleCopyTargets(selectedRows)}
                />
                <BulkActionButton
                  label="切り取り"
                  shortcut="⌘X"
                  icon={<Scissors className="h-3.5 w-3.5 text-slate-500" />}
                  onClick={() => handleCutTargets(selectedRows)}
                />
                <BulkActionButton
                  label="複製"
                  shortcut="⌘D"
                  icon={<Clipboard className="h-3.5 w-3.5 text-slate-500" />}
                  onClick={() => handleDuplicateTargets(selectedRows)}
                />
                <BulkActionButton
                  label="移動 / コピー"
                  shortcut="m"
                  icon={<FolderInput className="h-3.5 w-3.5 text-blue-600" />}
                  onClick={() => handleOpenMoveCopyModal(selectedRows, 'move')}
                />
                {selectedRows.some(
                  (row) => row.kind === 'file' && row.file.ai_suggested_label != null
                ) &&
                  (canEditCurrentFolder || isPrivilegedAdmin) && (
                    <BulkActionButton
                      label="AI提案を一括承認"
                      icon={<Sparkles className="h-3.5 w-3.5" />}
                      variant="primary"
                      onClick={handleBulkApproveAi}
                    />
                  )}
                {selectedRows.some((row) => row.kind === 'file') &&
                  (canEditCurrentFolder || isPrivilegedAdmin) && (
                    <BulkActionButton
                      label="機密変更"
                      shortcut="c"
                      icon={<Tag className="h-3.5 w-3.5 text-slate-500" />}
                      onClick={openClassificationPickerFromTarget}
                    />
                  )}
                <BulkActionButton
                  label="ゴミ箱"
                  variant="danger"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  onClick={trashSelectedOrFocused}
                />
                <button
                  type="button"
                  onClick={() => setSelectedKeys(new Set())}
                  className="shrink-0 rounded-lg px-2 py-1 text-slate-700 hover:bg-indigo-100 hover:text-slate-900"
                >
                  解除
                </button>
              </div>
            )}
          </div>
        </header>

        {snapshot.activeDirectoryNotice && (
          <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{snapshot.activeDirectoryNotice}</span>
            </div>
            <button
              type="button"
              onClick={() => syncStore.clearActiveDirectoryNotice()}
              className="rounded px-2 py-0.5 text-[0.6875rem] font-medium hover:bg-amber-100"
            >
              閉じる
            </button>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!isTrashView && !folderId && pinnedFolders.length > 0 && (
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                ピン留めされたワークスペース
              </h2>
              {snapshot.revalidating && (
                <span className="text-[0.6875rem] text-[#6b6f76]">同期中...</span>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {pinnedFolders.map((pinned) => {
                const pinnedDropClass = dragCtx.isDragging
                  ? getDropTargetClassName(
                      pinned.id,
                      dragCtx.hoveredTarget
                    )
                  : '';
                return (
                  <button
                    key={`pinned:${pinned.id}`}
                    type="button"
                    data-drop-folder-id={pinned.id}
                    data-drop-label={pinned.name}
                    onMouseEnter={() => prefetcher.scheduleHoverPrefetch(pinned.id)}
                    onMouseLeave={() => prefetcher.cancel(pinned.id)}
                    onFocus={() => prefetcher.scheduleCursorPrefetch(pinned.id)}
                    onBlur={() => prefetcher.cancel(pinned.id)}
                    onClick={() =>
                      router.push(`/workspace?folderId=${encodeURIComponent(pinned.id)}`)
                    }
                    className={`flex items-center gap-3 rounded-lg border border-[#e7e7ea] bg-white p-3 text-left transition hover:border-[#d7d7dc] hover:bg-[#f6f6f8] ${pinnedDropClass}`}
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[#f4f4f5] text-[#6b6f76]">
                      <Folder className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[0.8125rem] font-medium text-[#111214]">
                        {pinned.name}
                      </p>
                      <div className="mt-1">
                        <ClassificationBadge
                          classification={pinned.classification}
                          compact
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {!isTrashView && currentFolder && canEditCurrentFolder && (
          <FileDropzoneUploader
            folderId={currentFolder.id}
            onRegisterEnqueueFiles={(fn) => {
              pasteEnqueueFilesRef.current = fn;
            }}
          />
        )}

        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {selectedRows.length > 0
            ? `${selectedRows.length} 件選択中`
            : '選択なし'}
        </div>

        <div
          ref={marqueeSurfaceRef}
          data-marquee-surface="true"
          onPointerDown={marquee.onPointerDown}
          onContextMenu={handleBackgroundContextMenu}
          className="-mx-6 px-6 lg:-mx-8 lg:px-8"
        >
        <section className="overflow-hidden rounded-lg border border-[#e7e7ea] bg-white">
          {isInitialLoading ? (
            <div className="flex h-48 items-center justify-center text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
              読み込み中...
            </div>
          ) : rows.length === 0 ? (
            <div
              className="flex min-h-[240px] flex-col items-center justify-center px-6 py-12 text-center"
              onContextMenu={handleBackgroundContextMenu}
              onClick={handleBackgroundEmptyClick}
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#e7e7ea] bg-[#f9f9fa] text-[#6b6f76]">
                {isTrashView ? (
                  <Trash2 className="h-4 w-4" />
                ) : (
                  <Folder className="h-4 w-4" />
                )}
              </div>
              <p className="mt-3 text-[0.8125rem] font-medium text-[#111214]">
                {isTrashView
                  ? 'ゴミ箱は空です'
                  : folderId
                    ? 'このフォルダは空です'
                    : 'アクセス可能なルートフォルダがありません'}
              </p>
              <p className="mt-1 max-w-sm text-[0.6875rem] leading-relaxed text-[#6b6f76]">
                {isTrashView
                  ? '削除したアイテムはここに表示されます'
                  : folderId
                    ? 'ファイルをドロップするか、上の「ファイルを選択」から追加できます'
                    : '「新規フォルダ」からワークスペースを作成できます'}
              </p>
            </div>
          ) : (
            <div
              ref={(el) => {
                (virtualWindow.containerRef as { current: HTMLDivElement | null }).current =
                  el;
                dragCtx.registerScrollContainer(el);
              }}
              onScroll={virtualWindow.onScroll}
              onContextMenu={handleBackgroundContextMenu}
              role="region"
              aria-label="ファイルとフォルダの一覧"
              tabIndex={0}
              data-workspace-table="true"
              className={`min-h-[420px] overflow-x-auto ${
                virtualWindow.virtualized ? 'max-h-[68vh] overflow-y-auto' : ''
              }`}
            >
              {viewMode === 'grid' ? (
                <div className="p-4">
                  {virtualWindow.topSpacerPx > 0 && (
                    <div
                      aria-hidden="true"
                      style={{ height: `${virtualWindow.topSpacerPx}px` }}
                    />
                  )}
                  {visibleGridRows.map((chunk, chunkIdx) => {
                    const baseIdx = (virtualWindow.startIndex + chunkIdx) * GRID_COLUMNS;
                    return (
                      <div
                        key={`grid-row:${virtualWindow.startIndex + chunkIdx}`}
                        className="mb-3 grid grid-cols-1 gap-3 last:mb-0 sm:grid-cols-2 lg:grid-cols-4"
                      >
                        {chunk.map((row, colIdx) =>
                          renderGridRowCard(row, baseIdx + colIdx)
                        )}
                      </div>
                    );
                  })}
                  {virtualWindow.bottomSpacerPx > 0 && (
                    <div
                      aria-hidden="true"
                      style={{ height: `${virtualWindow.bottomSpacerPx}px` }}
                    />
                  )}
                </div>
              ) : (
                <table
                  role="grid"
                  aria-labelledby="workspace-table-caption"
                  aria-multiselectable="true"
                  aria-rowcount={rows.length + 1}
                  aria-colcount={6}
                  className="w-full text-left text-xs"
                >
                  <caption
                    id="workspace-table-caption"
                    className="sr-only"
                  >
                    ファイルとフォルダの一覧
                  </caption>
                  <thead className="sticky top-0 z-10 border-b border-[#ededf0] bg-[#fbfbfc]/95 text-[0.6875rem] font-medium tracking-normal text-[#6b6f76] backdrop-blur-xs">
                    <tr aria-rowindex={1}>
                      <th scope="col" className="w-10 px-3 py-2">
                        {!isTrashView && selectableRowKeys.length > 0 && (
                          <WorkspaceSelectionCheckbox
                            checked={
                              selectedRows.length > 0 &&
                              selectedRows.length === selectableRowKeys.length
                            }
                            label="すべて選択"
                            onClick={() => {
                              if (
                                selectedRows.length ===
                                selectableRowKeys.length
                              ) {
                                setSelectedKeys(new Set());
                              } else {
                                setSelectedKeys(new Set(selectableRowKeys));
                              }
                            }}
                          />
                        )}
                      </th>
                      {(
                        [
                          { field: 'name', label: '名前' },
                          { field: 'classification', label: '機密分類 / AI' },
                          { field: 'size_bytes', label: 'サイズ' },
                          {
                            field: 'updated_at',
                            label: isTrashView ? '削除日時' : '更新日時',
                          },
                        ] as const
                      ).map(({ field, label }) => {
                        const isActiveSort = sortBy === field;
                        return (
                          <th
                            key={field}
                            scope="col"
                            aria-sort={getAriaSortValue(field, sortBy, sortDir)}
                            className="px-3 py-2"
                          >
                            <button
                              type="button"
                              onClick={() => handleSortHeaderClick(field)}
                              className={`inline-flex min-h-6 items-center gap-1 rounded px-1 py-0.5 transition hover:bg-slate-200/60 hover:text-slate-900 ${
                                isActiveSort ? 'text-slate-900' : 'text-slate-500'
                              }`}
                            >
                              <span>{label}</span>
                              {isActiveSort ? (
                                sortDir === 'asc' ? (
                                  <ArrowUp className="h-3 w-3 text-blue-600" />
                                ) : (
                                  <ArrowDown className="h-3 w-3 text-blue-600" />
                                )
                              ) : (
                                <ArrowUpDown className="h-3 w-3 opacity-40" />
                              )}
                            </button>
                          </th>
                        );
                      })}
                      <th scope="col" className="px-3 py-2 text-right">
                        操作
                      </th>
                    </tr>
                  </thead>
                <tbody className="divide-y divide-[#f0f0f1]">
                  {virtualWindow.topSpacerPx > 0 && (
                    <tr aria-hidden="true">
                      <td
                        colSpan={6}
                        style={{
                          height: `${virtualWindow.topSpacerPx}px`,
                          padding: 0,
                          border: 0,
                        }}
                      />
                    </tr>
                  )}

                  {visibleRows.map((row, sliceIdx) => {
                    const globalIdx = virtualWindow.startIndex + sliceIdx;
                    const rowKey = getWorkspaceRowKey(row);
                    const isFocused = focusedRowKey === rowKey;
                    const isSelected = selectedKeys.has(rowKey);
                    const rowSelectable = !isTrashView && isRowSelectable(row);
                    const isInlineRenaming = inlineRename?.rowKey === rowKey;

                    function handleRowSelectionClick(e: React.MouseEvent) {
                      e.stopPropagation();
                      if (!rowSelectable) return;
                      setFocusedRowKey(rowKey);
                      if (e.shiftKey && selectionAnchorKey) {
                        setSelectedKeys(
                          selectKeyRange(orderedRowKeys, selectionAnchorKey, rowKey)
                        );
                      } else {
                        setSelectedKeys((prev) => toggleKeySelection(prev, rowKey));
                        setSelectionAnchorKey(rowKey);
                      }
                    }

                    if (row.kind === 'folder') {
                      const folder = row.folder;
                      const isCutFolder = Boolean(
                        clipboardState?.mode === 'cut' &&
                          clipboardStore.isCutPending('folder', folder.id)
                      );
                      const isDropEligible =
                        !isTrashView && folder.deleted_at == null;
                      const folderDropClass =
                        dragCtx.isDragging && isDropEligible
                          ? getDropTargetClassName(
                              folder.id,
                              dragCtx.hoveredTarget
                            )
                          : '';

                      return (
                        <tr
                          key={rowKey}
                          data-row-index={globalIdx}
                          aria-rowindex={globalIdx + 2}
                          data-drop-folder-id={isDropEligible ? folder.id : undefined}
                          data-drop-label={isDropEligible ? folder.name : undefined}
                          aria-selected={isSelected}
                          onContextMenu={(e) => {
                            if (isTrashView || isInlineRenaming) return;
                            openRowContextMenu(e, row);
                          }}
                          onPointerDown={(e) => {
                            if (isInlineRenaming) return;
                            const dragItems = collectDragItemsForRow(
                              row,
                              selectedRows,
                              selectedKeys,
                              isTrashView,
                              effectiveRole
                            );
                            if (dragItems.length > 0) {
                              dragCtx.startPointerDragCandidate(e, dragItems);
                            }
                          }}
                          onClick={(e) => {
                            if (isInlineRenaming || isRowControlTarget(e.target)) return;
                            selectRowFromPointer(e, rowKey, rowSelectable);
                          }}
                          onDoubleClick={(e) => {
                            if (isTrashView || isInlineRenaming) return;
                            if (isRowControlTarget(e.target)) return;
                            openRow(row);
                          }}
                          className={`h-11 transition-colors ${
                            folderDropClass
                              ? folderDropClass
                              : isSelected
                                ? 'bg-[#eef0fb]'
                                : isFocused
                                  ? 'bg-[#f4f4f5]'
                                  : 'hover:bg-[#f6f6f8]'
                          } ${isFocused ? 'ring-1 ring-inset ring-[#6d78d5]/45' : ''} ${
                            isCutFolder ? 'opacity-50 outline-1 outline-dashed outline-amber-400' : ''
                          }`}
                        >
                          <td className="w-10 px-3 py-3">
                            {rowSelectable && (
                              <WorkspaceSelectionCheckbox
                                checked={isSelected}
                                label={`${folder.name} を選択`}
                                onClick={handleRowSelectionClick}
                              />
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {isInlineRenaming && inlineRename ? (
                              <div className="flex items-center gap-2.5">
                                <Folder className="h-4 w-4 shrink-0 text-[#6b6f76]" />
                                <input
                                  ref={inlineInputRef}
                                  name="renameValue"
                                  aria-label="フォルダ名を変更"
                                  type="text"
                                  value={inlineRename.value}
                                  onChange={(e) =>
                                    setInlineRename((prev) =>
                                      prev ? { ...prev, value: e.target.value } : null
                                    )
                                  }
                                  onKeyDown={(e) => {
                                    if (isImeComposingEvent(e)) return;
                                    if (e.key === 'Escape') {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      inlineCommittedRef.current = inlineRename.rowKey;
                                      setInlineRename(null);
                                      return;
                                    }
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      commitInlineRename();
                                    }
                                  }}
                                  onBlur={() => commitInlineRename()}
                                  className="w-full max-w-xs rounded border border-blue-500 bg-white px-2 py-1 text-xs font-medium text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                                />
                              </div>
                            ) : (
                              <button
                                type="button"
                                data-row-name-trigger="true"
                                data-workspace-row-trigger="true"
                                aria-haspopup="menu"
                                aria-expanded={
                                  contextMenu?.row
                                    ? getWorkspaceRowKey(contextMenu.row) === rowKey
                                    : false
                                }
                                disabled={isTrashView}
                                title={
                                  isTrashView
                                    ? undefined
                                    : 'クリックで選択、ダブルクリックで開く'
                                }
                                onMouseEnter={() => {
                                  if (!isTrashView) {
                                    prefetcher.scheduleHoverPrefetch(folder.id);
                                  }
                                }}
                                onMouseLeave={() => {
                                  if (!isTrashView) prefetcher.cancel(folder.id);
                                }}
                                onFocus={() => {
                                  setFocusedRowKey(rowKey);
                                  if (!isTrashView) {
                                    prefetcher.scheduleCursorPrefetch(folder.id);
                                  }
                                }}
                                onBlur={() => {
                                  if (!isTrashView) prefetcher.cancel(folder.id);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key !== 'Enter' || isTrashView) return;
                                  e.preventDefault();
                                  openRow(row);
                                }}
                                className="flex items-center gap-2.5 text-[0.8125rem] font-medium text-[#111214] transition hover:text-[#4f5ac2] disabled:hover:text-[#111214]"
                              >
                                <Folder className="h-4 w-4 shrink-0 text-[#6b6f76]" />
                                <span>{folder.name}</span>
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <ClassificationBadge
                              classification={folder.classification}
                              compact
                            />
                          </td>
                          <td className="px-3 py-2 text-[#55565a]">フォルダ</td>
                          <td className="px-3 py-2 text-[#55565a]">
                            {formatDateTime(
                              isTrashView ? folder.deleted_at : folder.updated_at
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {isTrashView ? (
                              <button
                                type="button"
                                onClick={() => handleRestoreFolder(folder)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-100"
                              >
                                <RotateCcw className="h-3 w-3" />
                                <span>復元</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                title="その他の操作"
                                aria-haspopup="menu"
                                aria-label={`${folder.name} のその他の操作`}
                                data-row-action-trigger="true"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openRowContextMenu(e, row);
                                }}
                                className="rounded p-1 text-[#a0a0a7] transition hover:bg-[#f0f0f2] hover:text-[#111214]"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    }

                    const file = row.file;
                    const isPendingUpload =
                      file.upload_state === 'pending' || Boolean(file.optimistic);
                    const isCutFile = Boolean(
                      clipboardState?.mode === 'cut' &&
                        clipboardStore.isCutPending('file', file.id)
                    );
                    return (
                      <tr
                        key={rowKey}
                        data-row-index={globalIdx}
                        aria-rowindex={globalIdx + 2}
                        aria-selected={isSelected}
                        onContextMenu={(e) => {
                          if (isTrashView || isInlineRenaming || isPendingUpload) return;
                          openRowContextMenu(e, row);
                        }}
                        onPointerDown={(e) => {
                          if (isInlineRenaming || isPendingUpload) return;
                          const dragItems = collectDragItemsForRow(
                            row,
                            selectedRows,
                            selectedKeys,
                            isTrashView,
                            effectiveRole
                          );
                          if (dragItems.length > 0) {
                            dragCtx.startPointerDragCandidate(e, dragItems);
                          }
                        }}
                        onClick={(e) => {
                          if (isInlineRenaming || isRowControlTarget(e.target)) return;
                          selectRowFromPointer(e, rowKey, rowSelectable);
                        }}
                        onDoubleClick={(e) => {
                          if (isTrashView || isInlineRenaming || isPendingUpload) return;
                          if (isRowControlTarget(e.target)) return;
                          openRow(row);
                        }}
                        className={`h-11 transition-colors ${
                          isPendingUpload
                            ? 'bg-[#eef0fb]/50 text-[#55565a]'
                            : isSelected
                              ? 'bg-[#eef0fb]'
                              : isFocused
                                ? 'bg-[#f4f4f5]'
                                : 'hover:bg-[#f6f6f8]'
                        } ${isFocused ? 'ring-1 ring-inset ring-[#6d78d5]/45' : ''} ${
                          isCutFile ? 'opacity-50 outline-1 outline-dashed outline-amber-400' : ''
                        }`}
                      >
                        <td className="w-10 px-3 py-3">
                          {rowSelectable && (
                            <WorkspaceSelectionCheckbox
                              checked={isSelected}
                              label={`${file.name} を選択`}
                              onClick={handleRowSelectionClick}
                            />
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {isInlineRenaming && inlineRename ? (
                            <div className="flex items-center gap-2.5">
                              <FileText className="h-4 w-4 shrink-0 text-[#6b6f76]" />
                              <input
                                ref={inlineInputRef}
                                name="renameValue"
                                aria-label="ファイル名を変更"
                                type="text"
                                value={inlineRename.value}
                                onChange={(e) =>
                                  setInlineRename((prev) =>
                                    prev ? { ...prev, value: e.target.value } : null
                                  )
                                }
                                onKeyDown={(e) => {
                                  if (isImeComposingEvent(e)) return;
                                  if (e.key === 'Escape') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    inlineCommittedRef.current = inlineRename.rowKey;
                                    setInlineRename(null);
                                    return;
                                  }
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    commitInlineRename();
                                  }
                                }}
                                onBlur={() => commitInlineRename()}
                                className="w-full max-w-xs rounded border border-blue-500 bg-white px-2 py-1 text-xs font-medium text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              data-row-name-trigger="true"
                              data-workspace-row-trigger="true"
                              aria-haspopup="menu"
                              aria-expanded={
                                contextMenu?.row
                                  ? getWorkspaceRowKey(contextMenu.row) === rowKey
                                  : false
                              }
                              disabled={isTrashView || isPendingUpload}
                              title={
                                isTrashView || isPendingUpload
                                  ? undefined
                                  : 'クリックで選択、ダブルクリックで開く'
                              }
                              onMouseEnter={() => {
                                if (
                                  !isTrashView &&
                                  !isPendingUpload &&
                                  isPdfFile(file.name, file.mime_type)
                                ) {
                                  prefetcher.warmPdfPreviewRuntime();
                                }
                              }}
                              onFocus={() => setFocusedRowKey(rowKey)}
                              onKeyDown={(e) => {
                                if (
                                  e.key !== 'Enter' ||
                                  isTrashView ||
                                  isPendingUpload
                                ) {
                                  return;
                                }
                                e.preventDefault();
                                openRow(row);
                              }}
                              className="flex items-center gap-2.5 text-left text-[0.8125rem] font-medium text-[#111214] transition hover:text-[#4f5ac2] disabled:cursor-default disabled:hover:text-[#111214]"
                            >
                              {isPendingUpload ? (
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
                              ) : (
                                <FileText className="h-4 w-4 shrink-0 text-[#6b6f76]" />
                              )}
                              <span>{file.name}</span>
                              {isPendingUpload ? (
                                <span className="rounded-full bg-blue-100 px-2 py-0.5 font-mono text-[0.625rem] font-medium text-blue-700">
                                  アップロード中 {file.upload_progress ?? 0}%
                                </span>
                              ) : (
                                file.current_version_num > 1 && (
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.625rem] text-slate-500">
                                    v{file.current_version_num}
                                  </span>
                                )
                              )}
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <ClassificationCell
                            file={file}
                            canEdit={
                              !isTrashView &&
                              !isPendingUpload &&
                              (canEditCurrentFolder || isPrivilegedAdmin)
                            }
                            effectiveRole={effectiveRole}
                            isPrivilegedAdmin={isPrivilegedAdmin}
                            onUpdated={(updatedFile) => {
                              if (isTrashView) {
                                setTrashFiles((prev) =>
                                  prev.map((f) =>
                                    f.id === updatedFile.id ? updatedFile : f
                                  )
                                );
                              }
                            }}
                            onError={setError}
                          />
                        </td>
                        <td className="px-3 py-2 font-mono text-[#55565a]">
                          {formatBytes(file.size_bytes)}
                        </td>
                        <td className="px-3 py-2 text-[#55565a]">
                          {formatDateTime(
                            isTrashView ? file.deleted_at : file.updated_at
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {isTrashView ? (
                            <button
                              type="button"
                              onClick={() => handleRestoreFile(file)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[0.6875rem] font-medium text-slate-700 hover:bg-slate-100"
                            >
                              <RotateCcw className="h-3 w-3" />
                              <span>復元</span>
                            </button>
                          ) : isPendingUpload ? (
                            <span className="text-[0.6875rem] text-[#6b6f76]">
                              転送完了後に操作可能
                            </span>
                          ) : (
                            <div className="inline-flex items-center gap-1">
                              {canDownloadCurrentFolder && (
                                <button
                                  type="button"
                                  title="ダウンロード"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDownloadFile(file.id);
                                  }}
                                  className="rounded p-1 text-[#a0a0a7] transition hover:bg-[#f0f0f2] hover:text-[#111214]"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button
                                type="button"
                                title="その他の操作"
                                aria-haspopup="menu"
                                aria-label={`${file.name} のその他の操作`}
                                data-row-action-trigger="true"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openRowContextMenu(e, row);
                                }}
                                className="rounded p-1 text-[#a0a0a7] transition hover:bg-[#f0f0f2] hover:text-[#111214]"
                              >
                                <MoreHorizontal className="h-4 w-4" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}

                  {virtualWindow.bottomSpacerPx > 0 && (
                    <tr aria-hidden="true">
                      <td
                        colSpan={6}
                        style={{
                          height: `${virtualWindow.bottomSpacerPx}px`,
                          padding: 0,
                          border: 0,
                        }}
                      />
                    </tr>
                  )}
                </tbody>
              </table>
              )}
            </div>
          )}

          {nextCursor && (
            <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3 text-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={handleLoadMore}
                className="inline-flex items-center gap-2 h-7 rounded-md border border-[#e1e1e4] bg-white px-3 text-[0.75rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4] disabled:opacity-50"
              >
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>さらに読み込む</span>
              </button>
            </div>
          )}
        </section>
        <div
          aria-hidden="true"
          data-background-surface="true"
          className="min-h-[96px]"
          onClick={handleBackgroundEmptyClick}
          onContextMenu={handleBackgroundContextMenu}
        />
        </div>
      </main>

      <input
        ref={backgroundFileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          enqueueBackgroundUpload(e.target.files, 'files');
          e.target.value = '';
        }}
      />
      <input
        ref={backgroundFolderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          enqueueBackgroundUpload(e.target.files, 'folder');
          e.target.value = '';
        }}
      />

      {marquee.overlay}

      {!isTrashView && inspectorOpen && inspectorTarget && (() => {
        const targetRole =
          inspectorTarget.kind === 'folder'
            ? inspectorTarget.folder.effectiveRole ?? effectiveRole
            : effectiveRole;
        const targetCanEdit =
          inspectorTarget.kind === 'folder'
            ? hasRoleAtLeast(targetRole, 'editor')
            : canEditCurrentFolder;
        const targetCanDownload =
          inspectorTarget.kind === 'folder'
            ? hasRoleAtLeast(targetRole, 'viewer')
            : canDownloadCurrentFolder;
        const targetCanManagePerms =
          inspectorTarget.kind === 'folder'
            ? hasRoleAtLeast(targetRole, 'co_owner')
            : canManageCurrentFolderPerms;

        return (
          <WorkspaceInspectorDrawer
            target={inspectorTarget}
            effectiveRole={targetRole}
            breadcrumbs={breadcrumbs}
            canEdit={targetCanEdit}
            canDownload={targetCanDownload}
            canManagePerms={targetCanManagePerms}
            isPrivilegedAdmin={isPrivilegedAdmin}
            syncStore={syncStore}
            onClose={() => setInspectorOpen(false)}
            onPreview={openPreviewForFile}
            onDownload={handleDownloadFile}
            onOpenClassification={(file) =>
              setClassificationPicker({ mode: 'single', file })
            }
            onOpenShare={(target) => {
              const targetIsFolder = target.kind === 'folder';
              const targetEffectiveRole = targetIsFolder
                ? target.folder.effectiveRole ?? effectiveRole
                : effectiveRole;
              setActiveModal({
                kind: 'share',
                targetType: target.kind,
                targetId: targetIsFolder ? target.folder.id : target.file.id,
                targetName: targetIsFolder ? target.folder.name : target.file.name,
                classification: targetIsFolder
                  ? target.folder.classification
                  : target.file.classification,
                canEdit: hasRoleAtLeast(targetEffectiveRole, 'editor'),
              });
            }}
            onOpenPermissions={(target) => {
              const targetIsFolder = target.kind === 'folder';
              const targetEffectiveRole = targetIsFolder
                ? target.folder.effectiveRole ?? effectiveRole
                : effectiveRole;
              setActiveModal({
                kind: 'permissions',
                targetType: target.kind,
                targetId: targetIsFolder ? target.folder.id : target.file.id,
                targetName: targetIsFolder ? target.folder.name : target.file.name,
                effectiveRole: targetEffectiveRole,
              });
            }}
            onApproveAi={handleApproveSingleAi}
          />
        );
      })()}

      {previewTarget && (
        <SecurePreviewModal
          file={previewTarget.file}
          canDownload={previewTarget.canDownload}
          canNavigatePrev={previewFileIndex > 0}
          canNavigateNext={
            previewFileIndex >= 0 &&
            previewFileIndex < previewableFiles.length - 1
          }
          onNavigateFile={handleNavigatePreview}
          onClose={() => setPreviewTarget(null)}
        />
      )}

      {classificationPicker && (
        <ClassificationPickerModal
          targetLabel={
            classificationPicker.mode === 'single'
              ? classificationPicker.file.name
              : `${classificationPicker.files.length} 件のファイルを一括変更`
          }
          currentClassification={
            classificationPicker.mode === 'single'
              ? classificationPicker.file.classification
              : null
          }
          aiSuggestedLabel={
            classificationPicker.mode === 'single'
              ? classificationPicker.file.ai_suggested_label
              : null
          }
          onSelect={handleApplyPickedClassification}
          onClose={() => setClassificationPicker(null)}
        />
      )}

      {shortcutsHelpOpen && (
        <ShortcutsHelpModal onClose={() => setShortcutsHelpOpen(false)} />
      )}

      {contextMenu && !isTrashView && (() => {
        const targets = resolveTargetRows(contextMenu.row, selectedRows);
        const clip = clipboardState;
        const capabilities = buildContextMenuCapabilities({
          targets,
          primaryRow: contextMenu.row,
          currentFolderId: folderId ?? null,
          folderRole: effectiveRole,
          isPrivilegedAdmin,
          isSysAdmin,
          hasClipboardItems: Boolean(clip && clip.items.length > 0),
          clipboardHasFiles: Boolean(clip?.items.some((i) => i.type === 'file')),
          resolveRowRole,
        });
        const pasteDestId =
          !capabilities.isMulti && contextMenu.row?.kind === 'folder'
            ? contextMenu.row.folder.id
            : undefined;
        return (
          <WorkspaceContextMenu
            anchor={{ x: contextMenu.x, y: contextMenu.y }}
            targets={targets}
            primaryRow={contextMenu.row}
            capabilities={capabilities}
            clipboardCount={clip?.items.length ?? 0}
            returnFocus={contextMenu.trigger}
            onAction={(action) =>
              handleContextMenuAction(action, contextMenu.row, targets, pasteDestId)
            }
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

      {backgroundMenu && !isTrashView && (
        <WorkspaceBackgroundMenu
          anchor={{ x: backgroundMenu.x, y: backgroundMenu.y }}
          canCreate={canEditCurrentFolder || isPrivilegedAdmin}
          canUpload={Boolean(currentFolder) && canEditCurrentFolder}
          canUploadFolder={Boolean(currentFolder) && canEditCurrentFolder}
          canPaste={Boolean(
            clipboardState &&
              clipboardState.items.length > 0 &&
              (canEditCurrentFolder || isPrivilegedAdmin)
          )}
          clipboardCount={clipboardState?.items.length ?? 0}
          viewMode={viewMode}
          returnFocus={backgroundMenu.trigger}
          onAction={handleBackgroundMenuAction}
          onClose={() => setBackgroundMenu(null)}
        />
      )}

      {moveCopyModal && user && (
        <MoveCopyTreeModal
          items={moveCopyModal.items}
          modeHint={moveCopyModal.modeHint}
          currentFolderId={folderId ?? null}
          user={user}
          isSysAdmin={isSysAdmin}
          syncStore={syncStore}
          onClose={() => setMoveCopyModal(null)}
          onSuccess={() => {
            setSelectedKeys(new Set());
            setSelectionAnchorKey(null);
          }}
        />
      )}

      {!isTrashView && clipboardState && clipboardState.items.length > 0 && (
        <div
          role="region"
          aria-label="仮想クリップボード"
          className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-[#2a2a2e] bg-[#111214]/95 px-3 py-1.5 text-[0.6875rem] text-white shadow-2xl"
        >
          <span className="flex items-center gap-1.5 font-medium">
            {clipboardState.mode === 'cut' ? (
              <Scissors className="h-3.5 w-3.5 text-[#f1e1bf]" />
            ) : (
              <Copy className="h-3.5 w-3.5 text-[#bcc3ea]" />
            )}
            <span>
              {clipboardState.mode === 'cut' ? '切り取り中' : 'コピー中'}:{' '}
              {clipboardState.items.length} 件
            </span>
          </span>
          <button
            type="button"
            onClick={() => handlePasteClipboard()}
            className="inline-flex h-6 items-center gap-1.5 rounded bg-[#5e6ad2] px-2.5 text-[0.6875rem] font-medium text-white transition hover:bg-[#4f5ac2]"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>ここへ貼り付け (⌘V)</span>
          </button>
          <button
            type="button"
            onClick={() => clipboardStore.clear()}
            className="rounded px-2 py-1 text-[#b4b4bb] transition hover:bg-white/10 hover:text-white"
          >
            解除
          </button>
        </div>
      )}

      {activeModal?.kind === 'permissions' && (
        <PermissionsModal
          targetType={activeModal.targetType}
          targetId={activeModal.targetId}
          targetName={activeModal.targetName}
          effectiveRole={activeModal.effectiveRole}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal?.kind === 'share' && (
        <SharePopover
          targetType={activeModal.targetType}
          targetId={activeModal.targetId}
          targetName={activeModal.targetName}
          classification={activeModal.classification}
          canEdit={activeModal.canEdit}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal?.kind === 'fileRequest' && (
        <CreateFileRequestModal
          folderId={activeModal.folderId}
          folderName={activeModal.folderName}
          canEdit={activeModal.canEdit}
          onClose={() => setActiveModal(null)}
        />
      )}

      {(activeModal?.kind === 'createFolder' ||
        activeModal?.kind === 'renameFolder' ||
        activeModal?.kind === 'renameFile') && (
        <ModalShell
          label={
            activeModal.kind === 'createFolder'
              ? '新規フォルダを作成'
              : activeModal.kind === 'renameFolder'
                ? 'フォルダ名を変更'
                : 'ファイル名を変更'
          }
          onClose={() => setActiveModal(null)}
          className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl"
        >
          <form onSubmit={handleCreateOrRenameSubmit} className="space-y-4">
            <h2 className="text-sm font-semibold text-slate-900">
              {activeModal.kind === 'createFolder'
                ? '新規フォルダを作成'
                : activeModal.kind === 'renameFolder'
                  ? 'フォルダ名を変更'
                  : 'ファイル名を変更'}
            </h2>

            <label className="block text-xs">
              <span className="font-medium text-slate-700">
                {activeModal.kind === 'renameFile' ? 'ファイル名' : 'フォルダ名'}
              </span>
              <input
                id="workspace-modal-name"
                name="name"
                data-autofocus
                required
                autoFocus
                type="text"
                value={folderNameInput}
                onChange={(e) => setFolderNameInput(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
              />
            </label>

            {activeModal.kind === 'createFolder' && (
              <label className="block text-xs">
                <span className="font-medium text-slate-700">機密分類ラベル</span>
                <select
                  id="workspace-modal-classification"
                  name="classification"
                  value={folderClassInput}
                  onChange={(e) =>
                    setFolderClassInput(e.target.value as ClassificationLabel)
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-900"
                >
                  <option value="confidential">Confidential (極秘)</option>
                  <option value="internal">Internal (社内限定)</option>
                  <option value="public">Public (社外公開可)</option>
                  <option value="unset">Unset (未分類)</option>
                </select>
              </label>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="rounded-lg border border-slate-200 px-3.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                type="submit"
                disabled={modalSubmitting}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {modalSubmitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>保存</span>
              </button>
            </div>
          </form>
        </ModalShell>
      )}

      {snapshot.toasts.length > 0 && (
        <div
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
        >
          {snapshot.toasts.map((toast) => (
            <div
              key={toast.id}
              className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[0.6875rem] shadow-lg ${
                toast.kind === 'error'
                  ? 'border-[#5a2a2e] bg-[#2a1416]/95 text-[#fdf0f1]'
                  : toast.kind === 'warning'
                    ? 'border-[#5a4a2a] bg-[#2a2314]/95 text-[#fdf6e9]'
                    : 'border-[#2a2a2e] bg-[#111214]/95 text-[#f9f9fa]'
              }`}
            >
              <span className="min-w-0 flex-1 leading-relaxed">{toast.message}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                {toast.canUndo && snapshot.canUndo && (
                  <button
                    type="button"
                    onClick={() => void syncStore.undoLatest()}
                    className="inline-flex items-center gap-1 rounded-md bg-white/15 px-2.5 py-1 font-medium text-white hover:bg-white/25"
                  >
                    <Undo2 className="h-3 w-3" />
                    <span>{toast.undoLabel ?? '元に戻す'} (⌘Z)</span>
                  </button>
                )}
                <button
                  type="button"
                  aria-label="通知を閉じる"
                  onClick={() => syncStore.dismissToast(toast.id)}
                  className="flex h-6 w-6 items-center justify-center rounded text-white/70 hover:bg-white/10 hover:text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
        </div>
        );
      }}
    </WorkspaceDragProvider>
  );
}
