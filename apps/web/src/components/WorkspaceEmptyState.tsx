'use client';

import { Folder, Trash2 } from 'lucide-react';

export function WorkspaceEmptyState({
  isTrashView,
  folderId,
  onContextMenu,
  onClick,
}: {
  isTrashView: boolean;
  folderId: string | null;
  onContextMenu: (event: React.MouseEvent) => void;
  onClick: (event: React.MouseEvent) => void;
}) {
  return (
    <div
      className="flex min-h-[240px] flex-col items-center justify-center px-6 py-12 text-center"
      onContextMenu={onContextMenu}
      onClick={onClick}
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
  );
}
