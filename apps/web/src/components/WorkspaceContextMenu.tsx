'use client';

import {
  Activity,
  Clipboard,
  ClipboardPaste,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  FolderInput,
  History,
  Info,
  Link2,
  Lock,
  Pin,
  Scissors,
  Shield,
  Star,
  Tag,
  Trash2,
  Unlock,
} from 'lucide-react';
import { useMemo } from 'react';
import {
  MenuSurface,
  type MenuEntry,
} from '@/components/MenuSurface';
import type {
  ContextMenuCapabilities,
  ContextRowTarget,
} from '@/lib/workspace-actions';

export type ContextMenuActionId =
  | 'open'
  | 'openInNewTab'
  | 'wopiOpen'
  | 'copyLink'
  | 'download'
  | 'rename'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'duplicate'
  | 'moveCopy'
  | 'classify'
  | 'share'
  | 'pin'
  | 'permissions'
  | 'inspector'
  | 'versionHistory'
  | 'toggleLock'
  | 'toggleFavorite'
  | 'trash';

export function WorkspaceContextMenu({
  anchor,
  targets,
  primaryRow,
  capabilities,
  clipboardCount,
  isTargetLocked = false,
  isTargetFavorited = false,
  returnFocus = null,
  onToggleLock,
  onToggleFavorite,
  onAction,
  onClose,
}: {
  anchor: { x: number; y: number };
  targets: ContextRowTarget[];
  primaryRow: ContextRowTarget | null;
  capabilities: ContextMenuCapabilities;
  clipboardCount: number;
  isTargetLocked?: boolean;
  isTargetFavorited?: boolean;
  returnFocus?: HTMLElement | null;
  onToggleLock?: (row: ContextRowTarget) => void;
  onToggleFavorite?: (row: ContextRowTarget) => void;
  onAction: (action: ContextMenuActionId) => void;
  onClose: () => void;
}) {
  const isPinnedFolder =
    primaryRow?.kind === 'folder' && primaryRow.folder.is_pinned === 1;

  const entries = useMemo<Array<MenuEntry<ContextMenuActionId>>>(() => {
    const pasteTargetName =
      !capabilities.isMulti && primaryRow?.kind === 'folder'
        ? `「${primaryRow.folder.name}」へ貼り付け`
        : 'ここへ貼り付け';

    const list: Array<MenuEntry<ContextMenuActionId>> = [];

    if (!capabilities.isMulti && primaryRow) {
      const openChildren: Array<MenuEntry<ContextMenuActionId>> = [
        {
          id: 'open',
          label:
            primaryRow.kind === 'folder' ? 'フォルダを開く' : 'プレビューを開く',
          shortcut: 'Enter',
          icon: <Eye className="h-3.5 w-3.5" />,
          enabled: capabilities.canOpen,
        },
      ];
      openChildren.push({
        id: 'openInNewTab',
        label: '新しいタブで開く',
        icon: <ExternalLink className="h-3.5 w-3.5" />,
        enabled: capabilities.canOpen,
      });
      if (primaryRow.kind === 'file') {
        openChildren.push({
          id: 'wopiOpen',
          label: capabilities.canWopiOpen
            ? 'ブラウザで編集 / 同時編集'
            : '安全プレビューで開く',
          icon: <Edit3 className="h-3.5 w-3.5" />,
          enabled: capabilities.canWopiOpen,
        });
      }
      list.push({
        id: 'open',
        label: '開く',
        icon: <Eye className="h-3.5 w-3.5" />,
        enabled: openChildren.some((child) => child.enabled),
        children: openChildren,
      });
      if (primaryRow.kind === 'file') {
        list.push({
          id: 'download',
          label: 'ダウンロード',
          shortcut: 'd',
          icon: <Download className="h-3.5 w-3.5" />,
          enabled: capabilities.canDownload,
        });
      }
      list.push({
        id: 'rename',
        label: '名前の変更',
        shortcut: 'F2',
        icon: <Edit3 className="h-3.5 w-3.5" />,
        enabled: capabilities.canRename,
      });
    }

    list.push(
      {
        id: 'copy',
        label: capabilities.isMulti ? `${targets.length} 件をコピー` : 'コピー',
        shortcut: '⌘C',
        icon: <Copy className="h-3.5 w-3.5" />,
        enabled: capabilities.canCopy,
        dividerBefore: list.length > 0,
      },
      {
        id: 'cut',
        label: capabilities.isMulti ? `${targets.length} 件を切り取り` : '切り取り',
        shortcut: '⌘X',
        icon: <Scissors className="h-3.5 w-3.5" />,
        enabled: capabilities.canCut,
      }
    );

    if (clipboardCount > 0) {
      list.push({
        id: 'paste',
        label: `${pasteTargetName} (${clipboardCount} 件)`,
        shortcut: '⌘V',
        icon: <ClipboardPaste className="h-3.5 w-3.5" />,
        enabled: capabilities.canPaste,
      });
    }

    if (capabilities.isMulti) {
      list.push(
        {
          id: 'duplicate',
          label: `${targets.length} 件を複製`,
          shortcut: '⌘D',
          icon: <Clipboard className="h-3.5 w-3.5" />,
          enabled: capabilities.canDuplicate,
        },
        {
          id: 'moveCopy',
          label: '移動 / コピー先を選択...',
          shortcut: 'm',
          icon: <FolderInput className="h-3.5 w-3.5" />,
          enabled: capabilities.canMoveCopy,
        }
      );
    }

    list.push({
      id: 'classify',
      label: capabilities.isMulti ? '機密区分を一括変更' : '機密区分を変更',
      shortcut: 'c',
      icon: <Tag className="h-3.5 w-3.5" />,
      enabled: capabilities.canClassify,
      dividerBefore: true,
    });

    if (!capabilities.isMulti && primaryRow) {
      const shareChildren: Array<MenuEntry<ContextMenuActionId>> = [
        {
          id: 'share',
          label: '共有リンク設定',
          shortcut: 's',
          icon: <Link2 className="h-3.5 w-3.5" />,
          enabled: capabilities.canShare,
        },
        {
          id: 'copyLink',
          label: 'リンクをコピー',
          icon: <ExternalLink className="h-3.5 w-3.5" />,
          enabled: capabilities.canCopyLink,
        },
        {
          id: 'permissions',
          label:
            capabilities.canInvitePermissions &&
            !capabilities.canManagePermissions
              ? 'メンバー招待'
              : '権限管理',
          icon: <Shield className="h-3.5 w-3.5" />,
          enabled: capabilities.canPermissions,
        },
      ];
      list.push({
        id: 'share',
        label: '共有',
        icon: <Link2 className="h-3.5 w-3.5" />,
        enabled: shareChildren.some((child) => child.enabled),
        children: shareChildren,
      });

      const organizeChildren: Array<MenuEntry<ContextMenuActionId>> = [
        {
          id: 'moveCopy',
          label: '移動 / コピー先を選択...',
          shortcut: 'm',
          icon: <FolderInput className="h-3.5 w-3.5" />,
          enabled: capabilities.canMoveCopy,
        },
        {
          id: 'duplicate',
          label: '複製',
          shortcut: '⌘D',
          icon: <Clipboard className="h-3.5 w-3.5" />,
          enabled: capabilities.canDuplicate,
        },
      ];
      if (primaryRow.kind === 'folder') {
        organizeChildren.push({
          id: 'pin',
          label: isPinnedFolder ? 'ピン留めを解除' : 'クイックアクセスにピン留め',
          icon: <Pin className="h-3.5 w-3.5" />,
          enabled: capabilities.canPin,
        });
      }
      if (onToggleFavorite) {
        organizeChildren.push({
          id: 'toggleFavorite',
          label: isTargetFavorited ? 'お気に入りから解除' : 'お気に入りに追加',
          icon: (
            <Star
              className={`h-3.5 w-3.5 ${isTargetFavorited ? 'fill-[#f59e0b] text-[#f59e0b]' : ''}`}
            />
          ),
          enabled: true,
        });
      }
      list.push({
        id: 'moveCopy',
        label: '整理',
        icon: <FolderInput className="h-3.5 w-3.5" />,
        enabled: organizeChildren.some((child) => child.enabled),
        children: organizeChildren,
      });

      list.push({
        id: 'inspector',
        label: '詳細',
        icon: <Info className="h-3.5 w-3.5" />,
        enabled: capabilities.canInspector,
        children: [
          {
            id: 'inspector',
            label: '詳細インスペクタ',
            shortcut: 'i',
            icon: <Info className="h-3.5 w-3.5" />,
            enabled: capabilities.canInspector,
          },
          {
            id: 'versionHistory',
            label: '版履歴',
            icon: <History className="h-3.5 w-3.5" />,
            enabled: capabilities.canVersionHistory,
          },
          {
            id: 'inspector',
            label: 'アクティビティ（準備中）',
            icon: <Activity className="h-3.5 w-3.5" />,
            enabled: false,
          },
          {
            id: 'toggleLock',
            label: isTargetLocked ? 'ロック解除' : 'ロック',
            icon: isTargetLocked ? (
              <Unlock className="h-3.5 w-3.5" />
            ) : (
              <Lock className="h-3.5 w-3.5" />
            ),
            enabled:
              primaryRow.kind === 'file' &&
              (capabilities.canLock ?? capabilities.canRename),
          },
        ],
      });
    }

    list.push({
      id: 'trash',
      label: capabilities.isMulti
        ? `${targets.length} 件をゴミ箱へ移動`
        : 'ゴミ箱へ移動',
      shortcut: 'Del',
      icon: <Trash2 className="h-3.5 w-3.5" />,
      enabled: capabilities.canTrash,
      danger: true,
      dividerBefore: true,
    });

    return list;
  }, [
    capabilities,
    primaryRow,
    targets.length,
    clipboardCount,
    isPinnedFolder,
    isTargetLocked,
    isTargetFavorited,
    onToggleFavorite,
  ]);

  return (
    <MenuSurface
      anchor={anchor}
      entries={entries}
      ariaLabel="コンテキストメニュー"
      header={
        capabilities.isMulti
          ? `${targets.length} 件を選択中`
          : primaryRow?.kind === 'folder'
            ? primaryRow.folder.name
            : primaryRow?.file.name ?? 'ワークスペース'
      }
      width={252}
      height={410}
      widthClass="w-60"
      submenuWidthClass="w-56"
      returnFocus={returnFocus}
      onAction={(action) => {
        if (action === 'toggleLock') {
          if (onToggleLock && primaryRow) {
            onToggleLock(primaryRow);
          } else {
            onAction('inspector');
          }
          return;
        }
        if (action === 'toggleFavorite') {
          if (onToggleFavorite && primaryRow) {
            onToggleFavorite(primaryRow);
          } else {
            onAction('toggleFavorite');
          }
          return;
        }
        onAction(action);
      }}
      onClose={onClose}
    />
  );
}
