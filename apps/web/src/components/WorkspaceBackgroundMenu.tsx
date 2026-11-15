'use client';

import {
  Check,
  ClipboardPaste,
  FolderPlus,
  FolderUp,
  LayoutGrid,
  List,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { useMemo } from 'react';
import {
  MenuSurface,
  type MenuEntry,
} from '@/components/MenuSurface';

type BackgroundMenuActionId =
  | 'newFolder'
  | 'uploadFiles'
  | 'uploadFolder'
  | 'paste'
  | 'selectAll'
  | 'refresh'
  | 'toggleView';

export function WorkspaceBackgroundMenu({
  anchor,
  canCreate,
  canUpload,
  canUploadFolder,
  canPaste,
  clipboardCount,
  viewMode,
  returnFocus = null,
  onAction,
  onClose,
}: {
  anchor: { x: number; y: number };
  canCreate: boolean;
  canUpload: boolean;
  canUploadFolder: boolean;
  canPaste: boolean;
  clipboardCount: number;
  viewMode: 'list' | 'grid';
  returnFocus?: HTMLElement | null;
  onAction: (action: BackgroundMenuActionId) => void;
  onClose: () => void;
}) {
  const entries = useMemo<Array<MenuEntry<BackgroundMenuActionId>>>(() => {
    return [
      {
        id: 'newFolder',
        label: '新しいフォルダ',
        icon: <FolderPlus className="h-3.5 w-3.5" />,
        enabled: canCreate,
      },
      {
        id: 'uploadFiles',
        label: 'ファイルのアップロード',
        icon: <Upload className="h-3.5 w-3.5" />,
        enabled: canUpload,
      },
      {
        id: 'uploadFolder',
        label: 'フォルダのアップロード',
        icon: <FolderUp className="h-3.5 w-3.5" />,
        enabled: canUploadFolder,
      },
      {
        id: 'paste',
        label:
          clipboardCount > 0
            ? `ここへ貼り付け (${clipboardCount} 件)`
            : 'ここへ貼り付け',
        icon: <ClipboardPaste className="h-3.5 w-3.5" />,
        enabled: canPaste,
        dividerBefore: true,
      },
      {
        id: 'selectAll',
        label: 'すべて選択',
        icon: <Check className="h-3.5 w-3.5" />,
        enabled: true,
        dividerBefore: true,
      },
      {
        id: 'refresh',
        label: '表示を更新',
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        enabled: true,
      },
      {
        id: 'toggleView',
        label:
          viewMode === 'grid'
            ? 'リスト表示に切り替え'
            : 'グリッド表示に切り替え',
        icon:
          viewMode === 'grid' ? (
            <List className="h-3.5 w-3.5" />
          ) : (
            <LayoutGrid className="h-3.5 w-3.5" />
          ),
        enabled: true,
      },
    ];
  }, [
    canCreate,
    canUpload,
    canUploadFolder,
    canPaste,
    clipboardCount,
    viewMode,
  ]);

  return (
    <MenuSurface
      anchor={anchor}
      entries={entries}
      ariaLabel="フォルダメニュー"
      header="このフォルダ"
      width={248}
      height={320}
      widthClass="w-64"
      submenuWidthClass="w-56"
      tone="blue"
      returnFocus={returnFocus}
      onAction={onAction}
      onClose={onClose}
    />
  );
}
