'use client';

import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  Edit3,
  Eye,
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
import { MoveCopyTreeModal } from '@/components/MoveCopyTreeModal';
import { PermissionsModal } from '@/components/PermissionsModal';
import {
  type PreviewTargetFile,
  SecurePreviewModal,
} from '@/components/SecurePreviewModal';
import { SharePopover } from '@/components/SharePopover';
import { SignInCard } from '@/components/SignInCard';
import {
  type ContextMenuActionId,
  WorkspaceContextMenu,
} from '@/components/WorkspaceContextMenu';
import {
  type InspectorTarget,
  WorkspaceInspectorDrawer,
} from '@/components/WorkspaceInspectorDrawer';
import {
  ClassificationPickerModal,
  ShortcutsHelpModal,
} from '@/components/WorkspaceKeyboardOverlays';
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
import { useTableVirtualWindow } from '@/lib/use-virtual-window';
import {
  getWorkspaceClipboardStore,
  useWorkspaceClipboard,
} from '@/lib/workspace-clipboard';
import {
  buildContextMenuCapabilities,
  resolveTargetRows,
} from '@/lib/workspace-actions';
import {
  chunkItemsIntoGridRows,
  getAriaSortValue,
  loadWorkspaceViewPrefs,
  nextSortDirection,
  saveWorkspaceViewPrefs,
  sortWorkspaceFoldersAndFiles,
  type WorkspaceSortDirection,
  type WorkspaceSortField,
  type WorkspaceViewMode,
} from '@/lib/workspace-sort-and-view';
import type {
  ClassificationLabel,
  FileItem,
  FolderSummary,
  ResourceRole,
  SearchResultItem,
} from '@/types/files';

type WorkspaceTableRow =
  | { kind: 'folder'; folder: FolderSummary }
  | { kind: 'file'; file: FileItem };

type InlineRenameState = {
  rowKey: string;
  kind: 'folder' | 'file';
  id: string;
  originalName: string;
  value: string;
};

type ClassificationPickerState =
  | { mode: 'single'; file: FileItem }
  | { mode: 'bulk'; files: FileItem[] };

function getWorkspaceRowKey(row: WorkspaceTableRow): string {
  return row.kind === 'folder'
    ? `folder:${row.folder.id}`
    : `file:${row.file.id}`;
}

function isRowSelectable(row: WorkspaceTableRow): boolean {
  if (row.kind === 'folder') return true;
  return row.file.upload_state !== 'pending' && !row.file.optimistic;
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
  } | null>(null);
  const [moveCopyModal, setMoveCopyModal] = useState<{
    items: DragWorkspaceItem[];
    modeHint: 'move' | 'copy';
  } | null>(null);
  const [sortBy, setSortBy] = useState<WorkspaceSortField>('name');
  const [sortDir, setSortDir] = useState<WorkspaceSortDirection>('asc');
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>('list');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const prefsUserKeyRef = useRef<string | null>(null);
  const sortDrainErrorKeyRef = useRef<string | null>(null);
  const pasteEnqueueFilesRef = useRef<((files: FileList | File[]) => void) | null>(
    null
  );
  const lastOsPasteAtRef = useRef(0);
  const lastVirtualPasteAtRef = useRef(0);

  useEffect(() => {
    clipboardStore.setScope(
      user ? { tenantId: user.tenantId, id: user.id } : null
    );
    if (!user) {
      prefsUserKeyRef.current = null;
      return;
    }
    const userKey = `${user.tenantId}:${user.id}`;
    if (prefsUserKeyRef.current !== userKey) {
      prefsUserKeyRef.current = userKey;
      const prefs = loadWorkspaceViewPrefs(user.tenantId, user.id);
      setSortBy(prefs.sortBy);
      setSortDir(prefs.sortDir);
      setViewMode(prefs.viewMode);
    }
  }, [clipboardStore, user]);

  useEffect(() => {
    return syncStore.subscribeSecurityRevocations((event) => {
      if (event.kind === 'user.suspended') {
        clipboardStore.purge();
        setInspectorOpen(false);
        setContextMenu(null);
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

  function handleDeleteFolder(folder: FolderSummary) {
    setError(null);
    const res = syncStore.optimisticSoftDeleteFolder(folder);
    if (!res.ok) {
      setError(res.error ?? 'フォルダの削除に失敗しました');
      return;
    }
    if (currentFolder?.id === folder.id) {
      router.push(
        folder.parent_id
          ? `/workspace?folderId=${encodeURIComponent(folder.parent_id)}`
          : '/workspace'
      );
    }
  }

  function handleDeleteFile(file: FileItem) {
    setError(null);
    if (isTrashView) return;
    const res = syncStore.optimisticSoftDeleteFile(file, folderId, effectiveRole);
    if (!res.ok) {
      setError(res.error ?? 'ファイルの削除に失敗しました');
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

  const handleSortHeaderClick = useCallback(
    (field: WorkspaceSortField) => {
      const next = nextSortDirection(sortBy, sortDir, field);
      setSortBy(next.sortBy);
      setSortDir(next.sortDir);
      if (user) {
        saveWorkspaceViewPrefs(user.tenantId, user.id, {
          sortBy: next.sortBy,
          sortDir: next.sortDir,
          viewMode,
        });
      }
    },
    [sortBy, sortDir, user, viewMode]
  );

  const handleToggleViewMode = useCallback(() => {
    setViewMode((prev) => {
      const next: WorkspaceViewMode = prev === 'list' ? 'grid' : 'list';
      if (user) {
        saveWorkspaceViewPrefs(user.tenantId, user.id, {
          sortBy,
          sortDir,
          viewMode: next,
        });
      }
      return next;
    });
  }, [user, sortBy, sortDir]);

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
    selectedKeys.size,
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
          if (primary.kind === 'folder') {
            router.push(`/workspace?folderId=${encodeURIComponent(primary.folder.id)}`);
          } else {
            openPreviewForFile(primary.file);
          }
          break;
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
      <div className="flex min-h-screen items-center justify-center bg-[#F8FAFC] text-sm text-slate-500">
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
      onSpringOpenFolder={(targetId) =>
        router.push(`/workspace?folderId=${encodeURIComponent(targetId)}`)
      }
      onDropMove={handleDragDropMove}
    >
      {(dragCtx) => {
        function renderGridRowCard(row: WorkspaceTableRow, globalIdx: number) {
          const rowKey = getWorkspaceRowKey(row);
          const isFocused = focusedRowKey === rowKey;
          const isSelected = selectedKeys.has(rowKey);
          const rowSelectable = !isTrashView && isRowSelectable(row);
          const isInlineRenaming = inlineRename?.rowKey === rowKey;
          const isFolder = row.kind === 'folder';
          const folder = isFolder ? row.folder : null;
          const file = !isFolder ? row.file : null;
          const isPendingUpload = Boolean(
            file && (file.upload_state === 'pending' || file.optimistic)
          );
          const isCut = Boolean(
            clipboardState?.mode === 'cut' &&
              clipboardStore.isCutPending(row.kind, isFolder ? folder!.id : file!.id)
          );
          const isDropEligible = Boolean(
            folder && !isTrashView && folder.deleted_at == null
          );
          const dropClass =
            folder && dragCtx.isDragging && isDropEligible
              ? getDropTargetClassName(
                  folder.id,
                  dragCtx.hoveredTarget,
                  dragCtx.springTargetId
                )
              : '';

          function handleCardCheckboxClick(e: React.MouseEvent) {
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

          return (
            <div
              key={rowKey}
              data-row-index={globalIdx}
              data-drop-folder-id={isDropEligible && folder ? folder.id : undefined}
              data-drop-label={isDropEligible && folder ? folder.name : undefined}
              onContextMenu={(e) => {
                if (isTrashView || isInlineRenaming || isPendingUpload) return;
                e.preventDefault();
                setFocusedRowKey(rowKey);
                setContextMenu({ x: e.clientX, y: e.clientY, row });
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
                if (isInlineRenaming) return;
                setFocusedRowKey(rowKey);
                if (e.shiftKey && rowSelectable) {
                  setSelectedKeys(
                    selectKeyRange(
                      orderedRowKeys,
                      selectionAnchorKey ?? rowKey,
                      rowKey
                    )
                  );
                  if (!selectionAnchorKey) {
                    setSelectionAnchorKey(rowKey);
                  }
                }
              }}
              className={`flex h-[144px] flex-col justify-between rounded-xl border p-3 transition-colors ${
                dropClass
                  ? dropClass
                  : isPendingUpload
                    ? 'border-blue-200 bg-blue-50/40'
                    : isSelected
                      ? 'border-indigo-300 bg-indigo-50/70'
                      : isFocused
                        ? 'border-blue-400 bg-blue-50/60'
                        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60'
              } ${isCut ? 'opacity-50 outline-1 outline-dashed outline-amber-400' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {rowSelectable && (
                    <button
                      type="button"
                      role="checkbox"
                      aria-label={`${isFolder ? folder!.name : file!.name} を選択`}
                      aria-checked={isSelected}
                      data-workspace-row-trigger="true"
                      onClick={handleCardCheckboxClick}
                      className={`flex h-4 w-4 items-center justify-center rounded border transition ${
                        isSelected
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : 'border-slate-300 bg-white text-transparent hover:border-blue-400'
                      }`}
                    >
                      <Check className="h-3 w-3" />
                    </button>
                  )}
                  {isFolder ? (
                    <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                  ) : isPendingUpload ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-blue-500" />
                  )}
                  {!isFolder && file && isPendingUpload && (
                    <span className="rounded-full bg-blue-100 px-1.5 py-0.5 font-mono text-[10px] text-blue-700">
                      {file.upload_progress ?? 0}%
                    </span>
                  )}
                  {!isFolder && file && !isPendingUpload && file.current_version_num > 1 && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                      v{file.current_version_num}
                    </span>
                  )}
                </div>

                {isTrashView ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (folder) handleRestoreFolder(folder);
                      else if (file) handleRestoreFile(file);
                    }}
                    className="inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 hover:bg-slate-100"
                  >
                    <RotateCcw className="h-2.5 w-2.5" />
                    <span>復元</span>
                  </button>
                ) : !isPendingUpload ? (
                  <button
                    type="button"
                    title="詳細インスペクタ"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFocusedRowKey(rowKey);
                      setInspectorOpen(true);
                    }}
                    className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
                  >
                    <Info className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>

              <div className="min-w-0">
                {isInlineRenaming && inlineRename ? (
                  <input
                    ref={inlineInputRef}
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
                    className="w-full rounded border border-blue-500 bg-white px-2 py-1 text-xs font-medium text-slate-900 focus:outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    data-workspace-row-trigger="true"
                    disabled={isTrashView || isPendingUpload}
                    onMouseEnter={() => {
                      if (isTrashView || isPendingUpload) return;
                      if (folder) prefetcher.scheduleHoverPrefetch(folder.id);
                      else if (file && isPdfFile(file.name, file.mime_type)) {
                        prefetcher.warmPdfPreviewRuntime();
                      }
                    }}
                    onMouseLeave={() => {
                      if (!isTrashView && folder) prefetcher.cancel(folder.id);
                    }}
                    onFocus={() => {
                      setFocusedRowKey(rowKey);
                      if (!isTrashView && folder) {
                        prefetcher.scheduleCursorPrefetch(folder.id);
                      }
                    }}
                    onBlur={() => {
                      if (!isTrashView && folder) prefetcher.cancel(folder.id);
                    }}
                    onClick={(e) => {
                      if (e.shiftKey || isPendingUpload) return;
                      if (folder) {
                        router.push(
                          `/workspace?folderId=${encodeURIComponent(folder.id)}`
                        );
                      } else if (file) {
                        openPreviewForFile(file);
                      }
                    }}
                    className="w-full text-left text-xs font-semibold text-slate-900 hover:text-blue-600 disabled:cursor-default disabled:hover:text-slate-900"
                  >
                    <span className="line-clamp-2 break-all">
                      {folder ? folder.name : file!.name}
                    </span>
                  </button>
                )}
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <div className="flex items-center gap-1 min-w-0">
                  <ClassificationBadge
                    classification={folder ? folder.classification : file!.classification}
                    compact
                  />
                  {file?.ai_suggested_label && (
                    <span
                      title="AI 分類提案あり"
                      className="inline-flex items-center rounded bg-indigo-50 px-1 py-0.5 text-[10px] font-medium text-indigo-700"
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                    </span>
                  )}
                </div>
                <span className="shrink-0 font-mono text-[10px] text-slate-400">
                  {folder
                    ? formatDateTime(isTrashView ? folder.deleted_at : folder.updated_at)
                    : formatBytes(file!.size_bytes)}
                </span>
              </div>
            </div>
          );
        }

        return (
          <div className="flex min-h-screen bg-[#F8FAFC] text-slate-900">
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

          <main className="flex-1 min-w-0 px-6 py-6 lg:px-8 space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 space-y-1">
            {isTrashView ? (
              <div className="flex items-center gap-2">
                <Trash2 className="h-5 w-5 text-slate-600" />
                <h1 className="text-lg font-semibold text-slate-900">ゴミ箱</h1>
              </div>
            ) : (
              <nav className="flex flex-wrap items-center gap-1 text-sm">
                <button
                  type="button"
                  data-drop-folder-id={ROOT_DROP_ID}
                  data-drop-label="マイファイル"
                  onClick={() => router.push('/workspace')}
                  className={`rounded px-1.5 py-0.5 font-medium hover:bg-slate-200/70 transition ${
                    !folderId ? 'text-slate-900' : 'text-slate-500'
                  } ${
                    dragCtx.isDragging
                      ? getDropTargetClassName(
                          null,
                          dragCtx.hoveredTarget,
                          dragCtx.springTargetId
                        )
                      : ''
                  }`}
                >
                  マイファイル
                </button>
                {breadcrumbs.map((crumb, idx) => (
                  <span key={crumb.id} className="flex items-center gap-1">
                    <ChevronRight className="h-4 w-4 text-slate-400" />
                    <button
                      type="button"
                      data-drop-folder-id={crumb.id}
                      data-drop-label={crumb.name}
                      onClick={() =>
                        router.push(
                          `/workspace?folderId=${encodeURIComponent(crumb.id)}`
                        )
                      }
                      className={`rounded px-1.5 py-0.5 font-medium hover:bg-slate-200/70 transition ${
                        idx === breadcrumbs.length - 1
                          ? 'text-slate-900'
                          : 'text-slate-500'
                      } ${
                        dragCtx.isDragging
                          ? getDropTargetClassName(
                              crumb.id,
                              dragCtx.hoveredTarget,
                              dragCtx.springTargetId
                            )
                          : ''
                      }`}
                    >
                      {crumb.name}
                    </button>
                  </span>
                ))}
              </nav>
            )}

            {!isTrashView &&
              (currentFolder ||
                (nextCursor && (sortBy !== 'name' || sortDir !== 'asc'))) && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
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
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span>ソート全件同期中...</span>
                    </span>
                  )}
                </div>
              )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
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
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50"
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
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium shadow-2xs transition ${
                      currentFolder.is_pinned === 1
                        ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <Star
                      className={`h-3.5 w-3.5 ${
                        currentFolder.is_pinned === 1
                          ? 'fill-amber-400 text-amber-500'
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
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50"
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
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50"
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
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50"
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 shadow-2xs hover:bg-slate-50 hover:text-slate-900"
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
                    ? 'border-blue-300 bg-blue-50 text-blue-700'
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 shadow-2xs hover:bg-slate-50 hover:text-slate-900"
            >
              <Keyboard className="h-3.5 w-3.5 text-slate-500" />
              <kbd className="font-mono text-[10px] text-slate-500">?</kbd>
            </button>
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
              className="rounded px-2 py-0.5 text-[11px] font-medium hover:bg-amber-100"
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
                <span className="text-[11px] text-slate-400">同期中...</span>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {pinnedFolders.map((pinned) => {
                const isSpringPinned = dragCtx.springTargetId === pinned.id;
                const pinnedDropClass = dragCtx.isDragging
                  ? getDropTargetClassName(
                      pinned.id,
                      dragCtx.hoveredTarget,
                      dragCtx.springTargetId
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
                    className={`flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3.5 text-left shadow-2xs transition hover:border-blue-300 hover:bg-blue-50/30 ${pinnedDropClass}`}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600">
                      {isSpringPinned ? (
                        <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
                      ) : (
                        <Folder className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-900">
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

        {!isTrashView && selectedRows.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-indigo-200 bg-indigo-50/80 px-4 py-2 text-xs text-indigo-950">
            <span className="font-semibold">
              {selectedRows.length} 件選択中
            </span>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => handleCopyTargets(selectedRows)}
                className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
              >
                <Copy className="h-3.5 w-3.5 text-slate-500" />
                <span>コピー (⌘C)</span>
              </button>
              <button
                type="button"
                onClick={() => handleCutTargets(selectedRows)}
                className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
              >
                <Scissors className="h-3.5 w-3.5 text-slate-500" />
                <span>切り取り (⌘X)</span>
              </button>
              <button
                type="button"
                onClick={() => handleDuplicateTargets(selectedRows)}
                className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
              >
                <Clipboard className="h-3.5 w-3.5 text-slate-500" />
                <span>複製 (⌘D)</span>
              </button>
              <button
                type="button"
                onClick={() => handleOpenMoveCopyModal(selectedRows, 'move')}
                className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
              >
                <FolderInput className="h-3.5 w-3.5 text-blue-600" />
                <span>移動 / コピー (m)</span>
              </button>
              {selectedRows.some(
                (r) => r.kind === 'file' && r.file.ai_suggested_label != null
              ) &&
                (canEditCurrentFolder || isPrivilegedAdmin) && (
                  <button
                    type="button"
                    onClick={handleBulkApproveAi}
                    className="inline-flex items-center gap-1 rounded-lg border border-indigo-300 bg-indigo-600 px-2.5 py-1 font-medium text-white hover:bg-indigo-700"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>AI提案を一括承認</span>
                  </button>
                )}
              {selectedRows.some((r) => r.kind === 'file') &&
                (canEditCurrentFolder || isPrivilegedAdmin) && (
                  <button
                    type="button"
                    onClick={openClassificationPickerFromTarget}
                    className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Tag className="h-3.5 w-3.5 text-slate-500" />
                    <span>機密変更 (c)</span>
                  </button>
                )}
              <button
                type="button"
                onClick={trashSelectedOrFocused}
                className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-2.5 py-1 font-medium text-red-600 hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>ゴミ箱</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedKeys(new Set())}
                className="rounded-lg px-2 py-1 text-slate-500 hover:bg-indigo-100 hover:text-slate-800"
              >
                解除
              </button>
            </div>
          </div>
        )}

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xs">
          {isInitialLoading ? (
            <div className="flex h-48 items-center justify-center text-sm text-slate-500">
              <Loader2 className="mr-2 h-4 w-4 animate-spin text-blue-600" />
              読み込み中...
            </div>
          ) : rows.length === 0 ? (
            <div className="px-6 py-14 text-center text-sm text-slate-500">
              {isTrashView
                ? 'ゴミ箱は空です'
                : folderId
                  ? 'このフォルダにはまだアイテムがありません'
                  : 'アクセス可能なルートフォルダはありません（「新規フォルダ」から作成できます）'}
            </div>
          ) : (
            <div
              ref={(el) => {
                (virtualWindow.containerRef as { current: HTMLDivElement | null }).current =
                  el;
                dragCtx.registerScrollContainer(el);
              }}
              onScroll={virtualWindow.onScroll}
              tabIndex={-1}
              data-workspace-table="true"
              className={`overflow-x-auto focus:outline-none ${
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
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/95 text-[11px] font-semibold uppercase tracking-wide text-slate-500 backdrop-blur-xs">
                    <tr>
                      <th className="w-10 px-3 py-3">
                        {!isTrashView && selectableRowKeys.length > 0 && (
                          <button
                            type="button"
                            role="checkbox"
                            aria-label="すべて選択"
                            aria-checked={
                              selectedRows.length > 0 &&
                              selectedRows.length === selectableRowKeys.length
                            }
                            data-workspace-row-trigger="true"
                            onClick={() => {
                              if (selectedRows.length === selectableRowKeys.length) {
                                setSelectedKeys(new Set());
                              } else {
                                setSelectedKeys(new Set(selectableRowKeys));
                              }
                            }}
                            className={`flex h-4 w-4 items-center justify-center rounded border transition ${
                              selectedRows.length > 0 &&
                              selectedRows.length === selectableRowKeys.length
                                ? 'border-blue-600 bg-blue-600 text-white'
                                : 'border-slate-300 bg-white text-transparent hover:border-blue-400'
                            }`}
                          >
                            <Check className="h-3 w-3" />
                          </button>
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
                            aria-sort={getAriaSortValue(field, sortBy, sortDir)}
                            className="px-4 py-3"
                          >
                            <button
                              type="button"
                              onClick={() => handleSortHeaderClick(field)}
                              className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition hover:bg-slate-200/60 hover:text-slate-900 ${
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
                      <th className="px-4 py-3 text-right">操作</th>
                    </tr>
                  </thead>
                <tbody className="divide-y divide-slate-100">
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
                      const rowCanEdit = folder.effectiveRole
                        ? hasRoleAtLeast(folder.effectiveRole, 'editor')
                        : canEditCurrentFolder;
                      const rowPermsRole = folder.effectiveRole ?? effectiveRole;
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
                              dragCtx.hoveredTarget,
                              dragCtx.springTargetId
                            )
                          : '';

                      return (
                        <tr
                          key={rowKey}
                          data-row-index={globalIdx}
                          data-drop-folder-id={isDropEligible ? folder.id : undefined}
                          data-drop-label={isDropEligible ? folder.name : undefined}
                          onContextMenu={(e) => {
                            if (isTrashView || isInlineRenaming) return;
                            e.preventDefault();
                            setFocusedRowKey(rowKey);
                            setContextMenu({ x: e.clientX, y: e.clientY, row });
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
                            if (isInlineRenaming) return;
                            setFocusedRowKey(rowKey);
                            if (e.shiftKey && rowSelectable) {
                              setSelectedKeys(
                                selectKeyRange(
                                  orderedRowKeys,
                                  selectionAnchorKey ?? rowKey,
                                  rowKey
                                )
                              );
                              if (!selectionAnchorKey) {
                                setSelectionAnchorKey(rowKey);
                              }
                            }
                          }}
                          className={`h-[52px] transition-colors ${
                            folderDropClass
                              ? folderDropClass
                              : isSelected
                                ? 'bg-indigo-50/70'
                                : isFocused
                                  ? 'bg-blue-50/70'
                                  : 'hover:bg-slate-50/70'
                          } ${isFocused ? 'ring-1 ring-inset ring-blue-400/70' : ''} ${
                            isCutFolder ? 'opacity-50 outline-1 outline-dashed outline-amber-400' : ''
                          }`}
                        >
                          <td className="w-10 px-3 py-3">
                            {rowSelectable && (
                              <button
                                type="button"
                                role="checkbox"
                                aria-label={`${folder.name} を選択`}
                                aria-checked={isSelected}
                                data-workspace-row-trigger="true"
                                onClick={handleRowSelectionClick}
                                className={`flex h-4 w-4 items-center justify-center rounded border transition ${
                                  isSelected
                                    ? 'border-blue-600 bg-blue-600 text-white'
                                    : 'border-slate-300 bg-white text-transparent hover:border-blue-400'
                                }`}
                              >
                                <Check className="h-3 w-3" />
                              </button>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {isInlineRenaming && inlineRename ? (
                              <div className="flex items-center gap-2.5">
                                <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                                <input
                                  ref={inlineInputRef}
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
                                  className="w-full max-w-xs rounded border border-blue-500 bg-white px-2 py-1 text-xs font-medium text-slate-900 focus:outline-none"
                                />
                              </div>
                            ) : (
                              <button
                                type="button"
                                data-workspace-row-trigger="true"
                                disabled={isTrashView}
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
                                onClick={(e) => {
                                  if (e.shiftKey) return;
                                  router.push(
                                    `/workspace?folderId=${encodeURIComponent(folder.id)}`
                                  );
                                }}
                                className="flex items-center gap-2.5 font-medium text-slate-900 hover:text-blue-600 disabled:hover:text-slate-900"
                              >
                                <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                                <span>{folder.name}</span>
                              </button>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <ClassificationBadge
                              classification={folder.classification}
                              compact
                            />
                          </td>
                          <td className="px-4 py-3 text-slate-400">フォルダ</td>
                          <td className="px-4 py-3 text-slate-500">
                            {formatDateTime(
                              isTrashView ? folder.deleted_at : folder.updated_at
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {isTrashView ? (
                              <button
                                type="button"
                                onClick={() => handleRestoreFolder(folder)}
                                className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                              >
                                <RotateCcw className="h-3 w-3" />
                                <span>復元</span>
                              </button>
                            ) : (
                              <div className="inline-flex items-center gap-1">
                                {hasRoleAtLeast(rowPermsRole, 'co_owner') && (
                                  <button
                                    type="button"
                                    title="権限"
                                    onClick={() =>
                                      setActiveModal({
                                        kind: 'permissions',
                                        targetType: 'folder',
                                        targetId: folder.id,
                                        targetName: folder.name,
                                        effectiveRole: rowPermsRole,
                                      })
                                    }
                                    className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                  >
                                    <Shield className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                {rowCanEdit && (
                                  <>
                                    <button
                                      type="button"
                                      title="共有リンク"
                                      onClick={() =>
                                        setActiveModal({
                                          kind: 'share',
                                          targetType: 'folder',
                                          targetId: folder.id,
                                          targetName: folder.name,
                                          classification: folder.classification,
                                          canEdit: rowCanEdit,
                                        })
                                      }
                                      className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
                                    >
                                      <Link2 className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      title={
                                        folder.is_pinned === 1
                                          ? 'ピン留め解除'
                                          : 'ピン留め'
                                      }
                                      onClick={() => handleTogglePin(folder)}
                                      className={`rounded p-1.5 hover:bg-slate-100 ${
                                        folder.is_pinned === 1
                                          ? 'text-amber-500'
                                          : 'text-slate-400 hover:text-amber-500'
                                      }`}
                                    >
                                      <Star
                                        className={`h-3.5 w-3.5 ${
                                          folder.is_pinned === 1
                                            ? 'fill-amber-400'
                                            : ''
                                        }`}
                                      />
                                    </button>
                                    <button
                                      type="button"
                                      title="名前を変更 (r)"
                                      onClick={() => startInlineRename(row, globalIdx)}
                                      className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                    >
                                      <Edit3 className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      title="ゴミ箱へ移動"
                                      onClick={() => handleDeleteFolder(folder)}
                                      className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </>
                                )}
                              </div>
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
                        onContextMenu={(e) => {
                          if (isTrashView || isInlineRenaming || isPendingUpload) return;
                          e.preventDefault();
                          setFocusedRowKey(rowKey);
                          setContextMenu({ x: e.clientX, y: e.clientY, row });
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
                          if (isInlineRenaming) return;
                          setFocusedRowKey(rowKey);
                          if (e.shiftKey && rowSelectable) {
                            setSelectedKeys(
                              selectKeyRange(
                                orderedRowKeys,
                                selectionAnchorKey ?? rowKey,
                                rowKey
                              )
                            );
                            if (!selectionAnchorKey) {
                              setSelectionAnchorKey(rowKey);
                            }
                          }
                        }}
                        className={`h-[52px] transition-colors ${
                          isPendingUpload
                            ? 'bg-blue-50/30 text-slate-600'
                            : isSelected
                              ? 'bg-indigo-50/70'
                              : isFocused
                                ? 'bg-blue-50/70'
                                : 'hover:bg-slate-50/70'
                        } ${isFocused ? 'ring-1 ring-inset ring-blue-400/70' : ''} ${
                          isCutFile ? 'opacity-50 outline-1 outline-dashed outline-amber-400' : ''
                        }`}
                      >
                        <td className="w-10 px-3 py-3">
                          {rowSelectable && (
                            <button
                              type="button"
                              role="checkbox"
                              aria-label={`${file.name} を選択`}
                              aria-checked={isSelected}
                              data-workspace-row-trigger="true"
                              onClick={handleRowSelectionClick}
                              className={`flex h-4 w-4 items-center justify-center rounded border transition ${
                                isSelected
                                  ? 'border-blue-600 bg-blue-600 text-white'
                                  : 'border-slate-300 bg-white text-transparent hover:border-blue-400'
                              }`}
                            >
                              <Check className="h-3 w-3" />
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {isInlineRenaming && inlineRename ? (
                            <div className="flex items-center gap-2.5">
                              <FileText className="h-4 w-4 shrink-0 text-blue-500" />
                              <input
                                ref={inlineInputRef}
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
                                className="w-full max-w-xs rounded border border-blue-500 bg-white px-2 py-1 text-xs font-medium text-slate-900 focus:outline-none"
                              />
                            </div>
                          ) : (
                            <button
                              type="button"
                              data-workspace-row-trigger="true"
                              disabled={isTrashView || isPendingUpload}
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
                              onClick={(e) => {
                                if (e.shiftKey || isPendingUpload) return;
                                openPreviewForFile(file);
                              }}
                              className="flex items-center gap-2.5 text-left font-medium text-slate-900 hover:text-blue-600 disabled:cursor-default disabled:hover:text-slate-900"
                            >
                              {isPendingUpload ? (
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600" />
                              ) : (
                                <FileText className="h-4 w-4 shrink-0 text-blue-500" />
                              )}
                              <span>{file.name}</span>
                              {isPendingUpload ? (
                                <span className="rounded-full bg-blue-100 px-2 py-0.5 font-mono text-[10px] font-medium text-blue-700">
                                  アップロード中 {file.upload_progress ?? 0}%
                                </span>
                              ) : (
                                file.current_version_num > 1 && (
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                                    v{file.current_version_num}
                                  </span>
                                )
                              )}
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3">
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
                        <td className="px-4 py-3 font-mono text-slate-600">
                          {formatBytes(file.size_bytes)}
                        </td>
                        <td className="px-4 py-3 text-slate-500">
                          {formatDateTime(
                            isTrashView ? file.deleted_at : file.updated_at
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {isTrashView ? (
                            <button
                              type="button"
                              onClick={() => handleRestoreFile(file)}
                              className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
                            >
                              <RotateCcw className="h-3 w-3" />
                              <span>復元</span>
                            </button>
                          ) : isPendingUpload ? (
                            <span className="text-[11px] text-slate-400">
                              転送完了後に操作可能
                            </span>
                          ) : (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                title="プレビュー"
                                onClick={() =>
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
                                  })
                                }
                                className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
                              >
                                <Eye className="h-3.5 w-3.5" />
                              </button>

                              {canDownloadCurrentFolder && (
                                <button
                                  type="button"
                                  title="ダウンロード"
                                  onClick={() => handleDownloadFile(file.id)}
                                  className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                >
                                  <Download className="h-3.5 w-3.5" />
                                </button>
                              )}

                              {canManageCurrentFolderPerms && (
                                <button
                                  type="button"
                                  title="ファイル権限"
                                  onClick={() =>
                                    setActiveModal({
                                      kind: 'permissions',
                                      targetType: 'file',
                                      targetId: file.id,
                                      targetName: file.name,
                                      effectiveRole,
                                    })
                                  }
                                  className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                >
                                  <Shield className="h-3.5 w-3.5" />
                                </button>
                              )}

                              {canEditCurrentFolder && (
                                <>
                                  <button
                                    type="button"
                                    title="共有リンク"
                                    onClick={() =>
                                      setActiveModal({
                                        kind: 'share',
                                        targetType: 'file',
                                        targetId: file.id,
                                        targetName: file.name,
                                        classification: file.classification,
                                        canEdit: canEditCurrentFolder,
                                      })
                                    }
                                    className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-blue-600"
                                  >
                                    <Link2 className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    title="名前を変更 (r)"
                                    onClick={() => startInlineRename(row, globalIdx)}
                                    className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                                  >
                                    <Edit3 className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    title="ゴミ箱へ移動"
                                    onClick={() => handleDeleteFile(file)}
                                    className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </>
                              )}
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
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                <span>さらに読み込む</span>
              </button>
            </div>
          )}
        </section>
      </main>

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
            onAction={(action) =>
              handleContextMenuAction(action, contextMenu.row, targets, pasteDestId)
            }
            onClose={() => setContextMenu(null)}
          />
        );
      })()}

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
          className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-slate-700 bg-slate-900/95 px-4 py-2 text-xs text-white shadow-2xl backdrop-blur-xs"
        >
          <span className="flex items-center gap-1.5 font-medium">
            {clipboardState.mode === 'cut' ? (
              <Scissors className="h-3.5 w-3.5 text-amber-400" />
            ) : (
              <Copy className="h-3.5 w-3.5 text-blue-400" />
            )}
            <span>
              {clipboardState.mode === 'cut' ? '切り取り中' : 'コピー中'}:{' '}
              {clipboardState.items.length} 件
            </span>
          </span>
          <button
            type="button"
            onClick={() => handlePasteClipboard()}
            className="inline-flex items-center gap-1.5 rounded-full bg-blue-600 px-3 py-1 font-semibold text-white hover:bg-blue-500"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            <span>ここへ貼り付け (⌘V)</span>
          </button>
          <button
            type="button"
            onClick={() => clipboardStore.clear()}
            className="rounded-full px-2.5 py-1 text-slate-300 hover:bg-white/10 hover:text-white"
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs"
          onClick={() => setActiveModal(null)}
        >
          <form
            onSubmit={handleCreateOrRenameSubmit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl space-y-4"
          >
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
                required
                autoFocus
                type="text"
                value={folderNameInput}
                onChange={(e) => setFolderNameInput(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
              />
            </label>

            {activeModal.kind === 'createFolder' && (
              <label className="block text-xs">
                <span className="font-medium text-slate-700">機密分類ラベル</span>
                <select
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
        </div>
      )}

      {snapshot.toasts.length > 0 && (
        <div
          aria-live="polite"
          className="fixed bottom-5 right-5 z-50 flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0"
        >
          {snapshot.toasts.map((toast) => (
            <div
              key={toast.id}
              className={`flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-xs shadow-lg backdrop-blur-xs ${
                toast.kind === 'error'
                  ? 'border-red-200 bg-red-950/95 text-red-50'
                  : toast.kind === 'warning'
                    ? 'border-amber-300 bg-amber-950/95 text-amber-50'
                    : 'border-slate-700 bg-slate-900/95 text-slate-100'
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
                  className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
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
