'use client';

import {
  ExternalLink,
  FolderInput,
  FolderOpen,
  Info,
  Link2,
  Pin,
  Shield,
  Trash2,
} from 'lucide-react';
import { useMemo } from 'react';
import {
  MenuSurface,
  type MenuEntry,
} from '@/components/MenuSurface';
import type { FolderSummary } from '@/types/files';

export type FolderTreeMenuAction =
  | 'open'
  | 'openInNewTab'
  | 'share'
  | 'copyLink'
  | 'permissions'
  | 'move'
  | 'pin'
  | 'info'
  | 'trash';

export function FolderTreeContextMenu({
  anchor,
  folder,
  canShare,
  canCopyLink,
  canManagePermissions,
  canMove,
  canPin,
  canTrash,
  returnFocus = null,
  onAction,
  onClose,
}: {
  anchor: { x: number; y: number };
  folder: FolderSummary;
  canShare: boolean;
  canCopyLink: boolean;
  canManagePermissions: boolean;
  canMove: boolean;
  canPin: boolean;
  canTrash: boolean;
  returnFocus?: HTMLElement | null;
  onAction: (action: FolderTreeMenuAction) => void;
  onClose: () => void;
}) {
  const entries = useMemo<Array<MenuEntry<FolderTreeMenuAction>>>(() => {
    const openChildren: Array<MenuEntry<FolderTreeMenuAction>> = [
      {
        id: 'open',
        label: 'フォルダを開く',
        shortcut: 'Enter',
        icon: <FolderOpen className="h-3.5 w-3.5" />,
        enabled: true,
      },
      {
        id: 'openInNewTab',
        label: '新しいタブで開く',
        icon: <ExternalLink className="h-3.5 w-3.5" />,
        enabled: true,
      },
    ];

    const shareChildren: Array<MenuEntry<FolderTreeMenuAction>> = [
      {
        id: 'share',
        label: '共有リンク設定',
        shortcut: 's',
        icon: <Link2 className="h-3.5 w-3.5" />,
        enabled: canShare,
      },
      {
        id: 'copyLink',
        label: 'リンクをコピー',
        icon: <Link2 className="h-3.5 w-3.5" />,
        enabled: canCopyLink,
      },
      {
        id: 'permissions',
        label: '権限管理',
        icon: <Shield className="h-3.5 w-3.5" />,
        enabled: canManagePermissions,
      },
    ];

    const organizeChildren: Array<MenuEntry<FolderTreeMenuAction>> = [
      {
        id: 'move',
        label: '移動 / コピー先を選択...',
        shortcut: 'm',
        icon: <FolderInput className="h-3.5 w-3.5" />,
        enabled: canMove,
      },
      {
        id: 'pin',
        label:
          folder.is_pinned === 1
            ? 'クイックアクセスから外す'
            : 'クイックアクセスに追加',
        icon: <Pin className="h-3.5 w-3.5" />,
        enabled: canPin,
      },
    ];

    return [
      {
        id: 'open',
        label: '開く',
        icon: <FolderOpen className="h-3.5 w-3.5" />,
        enabled: true,
        children: openChildren,
      },
      {
        id: 'share',
        label: '共有',
        icon: <Link2 className="h-3.5 w-3.5" />,
        enabled: shareChildren.some((child) => child.enabled),
        children: shareChildren,
      },
      {
        id: 'move',
        label: '整理',
        icon: <FolderInput className="h-3.5 w-3.5" />,
        enabled: organizeChildren.some((child) => child.enabled),
        children: organizeChildren,
      },
      {
        id: 'info',
        label: 'フォルダ情報',
        shortcut: 'i',
        icon: <Info className="h-3.5 w-3.5" />,
        enabled: true,
        dividerBefore: true,
      },
      {
        id: 'trash',
        label: 'ゴミ箱へ移動',
        shortcut: 'Del',
        icon: <Trash2 className="h-3.5 w-3.5" />,
        enabled: canTrash,
        danger: true,
        dividerBefore: true,
      },
    ];
  }, [
    canShare,
    canCopyLink,
    canManagePermissions,
    canMove,
    canPin,
    canTrash,
    folder.is_pinned,
  ]);

  return (
    <MenuSurface
      anchor={anchor}
      entries={entries}
      ariaLabel="フォルダメニュー"
      header={folder.name}
      width={248}
      height={300}
      widthClass="w-60"
      submenuWidthClass="w-56"
      returnFocus={returnFocus}
      onAction={onAction}
      onClose={onClose}
    />
  );
}
