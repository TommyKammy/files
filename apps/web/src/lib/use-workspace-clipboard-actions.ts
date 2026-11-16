'use client';

import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { DragWorkspaceItem } from '@/lib/drag-drop-controller';
import { canAccess } from '@/lib/capabilities';
import type { WorkspaceClipboardStore } from '@/lib/workspace-clipboard';
import type { WorkspaceSyncStore } from '@/lib/sync-store';
import {
  toDragWorkspaceItem,
  type WorkspaceTableRow,
} from '@/lib/workspace-table-row';
import type { AuthUser, ResourceRole } from '@/types/files';

export function useWorkspaceClipboardActions({
  syncStore,
  clipboardStore,
  user,
  isTrashView,
  folderId,
  effectiveRole,
  getShortcutTargets,
  resolveRowRole,
  isSysAdmin,
  setError,
  setSelectedKeys,
  setSelectionAnchorKey,
  setMoveCopyModal,
}: {
  syncStore: WorkspaceSyncStore;
  clipboardStore: WorkspaceClipboardStore;
  user: AuthUser | null;
  isTrashView: boolean;
  folderId: string | null;
  effectiveRole: ResourceRole;
  getShortcutTargets: (
    explicitTargets?: WorkspaceTableRow[]
  ) => WorkspaceTableRow[];
  resolveRowRole: (row: WorkspaceTableRow) => ResourceRole;
  isSysAdmin: boolean;
  setError: (message: string | null) => void;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  setSelectionAnchorKey: (key: string | null) => void;
  setMoveCopyModal: Dispatch<
    SetStateAction<{
      items: DragWorkspaceItem[];
      modeHint: 'move' | 'copy';
    } | null>
  >;
}) {
  const toClipboardItems = useCallback(
    (targets: WorkspaceTableRow[]) =>
      targets.map((row) =>
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
      ),
    []
  );

  const handleCopyTargets = useCallback(
    (explicitTargets?: WorkspaceTableRow[]) => {
      if (isTrashView || !user) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) return;
      const blocked = targets.some(
        (r) =>
          !isSysAdmin &&
          !canAccess(
            {
              capabilities:
                r.kind === 'folder' ? r.folder.capabilities : undefined,
              effectiveRole: resolveRowRole(r),
            },
            'item.download'
          )
      );
      if (blocked) {
        syncStore.pushToast({
          kind: 'error',
          message: 'Previewer 権限のアイテムはコピーできません (DLP 保護)',
        });
        return;
      }
      clipboardStore.setClipboard('copy', toClipboardItems(targets), {
        tenantId: user.tenantId,
        userId: user.id,
      });
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
        (r) =>
          !isSysAdmin &&
          !canAccess(
            {
              capabilities:
                r.kind === 'folder' ? r.folder.capabilities : undefined,
              effectiveRole: resolveRowRole(r),
            },
            r.kind === 'folder' ? 'folder.move' : 'item.move'
          )
      );
      if (blocked) {
        syncStore.pushToast({
          kind: 'error',
          message: '切り取り（移動）には Editor 以上の権限が必要です',
        });
        return;
      }
      clipboardStore.setClipboard('cut', toClipboardItems(targets), {
        tenantId: user.tenantId,
        userId: user.id,
      });
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
        targetParentOverride !== undefined
          ? targetParentOverride
          : folderId;
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
    [
      isTrashView,
      clipboardStore,
      folderId,
      syncStore,
      setError,
      setSelectedKeys,
    ]
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
        targetParentId: folderId,
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
    [isTrashView, getShortcutTargets, syncStore, folderId, setError]
  );

  const handleOpenMoveCopyModal = useCallback(
    (
      explicitTargets?: WorkspaceTableRow[],
      modeHint: 'move' | 'copy' = 'move'
    ) => {
      if (isTrashView) return;
      const targets = getShortcutTargets(explicitTargets);
      if (targets.length === 0) {
        syncStore.pushToast({
          kind: 'info',
          message:
            '移動・コピーするアイテムを選択またはフォーカスしてください',
        });
        return;
      }
      const canMoveOrCopy = targets.every((row) => {
        const access = {
          capabilities:
            row.kind === 'folder' ? row.folder.capabilities : undefined,
          effectiveRole: resolveRowRole(row),
        };
        return (
          isSysAdmin ||
          canAccess(access, 'item.download') ||
          canAccess(
            access,
            row.kind === 'folder' ? 'folder.move' : 'item.move'
          )
        );
      });
      if (!canMoveOrCopy) {
        syncStore.pushToast({
          kind: 'error',
          message: 'このロールでは移動・コピーを実行できません',
        });
        return;
      }
      setMoveCopyModal({
        items: targets.map((r) => toDragWorkspaceItem(r, effectiveRole)),
        modeHint,
      });
    },
    [
      isTrashView,
      getShortcutTargets,
      syncStore,
      effectiveRole,
      isSysAdmin,
      resolveRowRole,
      setMoveCopyModal,
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
    [syncStore, setError, setSelectedKeys, setSelectionAnchorKey]
  );

  return {
    handleCopyTargets,
    handleCutTargets,
    handlePasteClipboard,
    handleDuplicateTargets,
    handleOpenMoveCopyModal,
    handleDragDropMove,
  };
}
