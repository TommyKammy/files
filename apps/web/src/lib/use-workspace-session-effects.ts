'use client';

import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PreviewTargetFile } from '@/components/SecurePreviewModal';
import type { ActiveModal } from '@/components/WorkspaceManagementModals';
import type { ClassificationPickerState } from '@/components/WorkspaceUtilityOverlays';
import type { DragWorkspaceItem } from '@/lib/drag-drop-controller';
import type { IntentPrefetcher } from '@/lib/intent-prefetch';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import type { WorkspaceClipboardStore } from '@/lib/workspace-clipboard';
import type { InlineRenameState } from '@/lib/workspace-table-row';
import {
  DEFAULT_WORKSPACE_COLUMN_VISIBILITY,
  loadWorkspaceColumnVisibility,
  saveWorkspaceColumnVisibility,
  type WorkspaceColumnVisibility,
  type WorkspaceOptionalColumnId,
} from '@/lib/workspace-table-columns';
import type { AuthUser } from '@/types/files';

/**
 * Coordinates workspace session side effects: PDF preview runtime warm-up,
 * column visibility persistence, clipboard scope isolation, and fail-closed
 * security revocation subscriptions.
 */
export function useWorkspaceSessionEffects({
  authStatus,
  user,
  prefetcher,
  syncStore,
  clipboardStore,
  setInspectorOpen,
  setContextMenu,
  setBackgroundMenu,
  setMoveCopyModal,
  setPreviewTarget,
  setActiveModal,
  setInlineRename,
  setClassificationPicker,
  setShortcutsHelpOpen,
  setSelectedKeys,
  setError,
}: {
  authStatus: string;
  user: AuthUser | null;
  prefetcher: IntentPrefetcher;
  syncStore: WorkspaceSyncStore;
  clipboardStore: WorkspaceClipboardStore;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  setContextMenu: Dispatch<SetStateAction<any>>;
  setBackgroundMenu: Dispatch<SetStateAction<any>>;
  setMoveCopyModal: Dispatch<
    SetStateAction<{
      items: DragWorkspaceItem[];
      modeHint: 'move' | 'copy';
    } | null>
  >;
  setPreviewTarget: Dispatch<
    SetStateAction<{ file: PreviewTargetFile; canDownload: boolean } | null>
  >;
  setActiveModal: Dispatch<SetStateAction<ActiveModal | null>>;
  setInlineRename: Dispatch<SetStateAction<InlineRenameState | null>>;
  setClassificationPicker: Dispatch<
    SetStateAction<ClassificationPickerState | null>
  >;
  setShortcutsHelpOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setError: (error: string | null) => void;
}) {
  const [columnVisibility, setColumnVisibility] =
    useState<WorkspaceColumnVisibility>(DEFAULT_WORKSPACE_COLUMN_VISIBILITY);

  useEffect(() => {
    setColumnVisibility(loadWorkspaceColumnVisibility());
  }, []);

  function handleToggleColumn(columnId: WorkspaceOptionalColumnId) {
    setColumnVisibility((prev) => {
      const next = { ...prev, [columnId]: !prev[columnId] };
      saveWorkspaceColumnVisibility(next);
      return next;
    });
  }

  // Idle-time warm-up ONLY of static pdfjs-dist runtime chunk (NEVER calls /content-url)
  useEffect(() => {
    if (authStatus !== 'authenticated' || !user) return;
    const w = window as Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number }
      ) => number;
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
  }, [authStatus, user, prefetcher]);

  useEffect(() => {
    clipboardStore.setScope(
      user ? { tenantId: user.tenantId, id: user.id } : null
    );
  }, [clipboardStore, user]);

  // Fail-closed handler for instant SCIM suspension, permission revocation, and share revocation
  useEffect(() => {
    return syncStore.subscribeSecurityRevocations((event) => {
      if (
        event.kind === 'user.suspended' ||
        event.kind === 'session.revoked' ||
        event.kind === 'tenant.sessions_revoked'
      ) {
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
          event.kind === 'user.suspended'
            ? 'アカウント停止またはセッション失効のためワークスペースキャッシュを消去しました。'
            : '管理者による強制サインアウトのためワークスペースキャッシュを消去しました。'
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
  }, [
    syncStore,
    clipboardStore,
    setInspectorOpen,
    setContextMenu,
    setBackgroundMenu,
    setMoveCopyModal,
    setPreviewTarget,
    setActiveModal,
    setInlineRename,
    setClassificationPicker,
    setShortcutsHelpOpen,
    setSelectedKeys,
    setError,
  ]);

  return {
    columnVisibility,
    handleToggleColumn,
  };
}
