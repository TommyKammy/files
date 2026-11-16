'use client';

import { Folder, SearchX, Trash2 } from 'lucide-react';

export function WorkspaceEmptyState({
  isTrashView,
  folderId,
  trashFilterActive = false,
  onClearTrashFilters,
  onContextMenu,
  onClick,
}: {
  isTrashView: boolean;
  folderId: string | null;
  trashFilterActive?: boolean;
  onClearTrashFilters?: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onClick: (event: React.MouseEvent) => void;
}) {
  const filteredTrashEmpty = isTrashView && trashFilterActive;

  return (
    <div
      className="flex min-h-[240px] flex-col items-center justify-center px-6 py-12 text-center"
      onContextMenu={onContextMenu}
      onClick={onClick}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#e7e7ea] bg-[#f9f9fa] text-[#6b6f76]">
        {filteredTrashEmpty ? (
          <SearchX className="h-4 w-4" />
        ) : isTrashView ? (
          <Trash2 className="h-4 w-4" />
        ) : (
          <Folder className="h-4 w-4" />
        )}
      </div>
      <p className="mt-3 text-[0.8125rem] font-medium text-[#111214]">
        {filteredTrashEmpty
          ? '条件に一致するアイテムがありません'
          : isTrashView
            ? 'ゴミ箱は空です'
            : folderId
              ? 'このフォルダは空です'
              : 'アクセス可能なルートフォルダがありません'}
      </p>
      <p className="mt-1 max-w-sm text-[0.6875rem] leading-relaxed text-[#6b6f76]">
        {filteredTrashEmpty
          ? '検索語やフィルタを変更するか、条件をクリアしてください'
          : isTrashView
            ? '削除したアイテムはここに表示されます'
            : folderId
              ? 'ファイルをドロップするか、上の「ファイルを選択」から追加できます'
              : '「新規フォルダ」からワークスペースを作成できます'}
      </p>
      {filteredTrashEmpty && onClearTrashFilters && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClearTrashFilters();
          }}
          className="mt-3 inline-flex h-7 items-center rounded-md border border-[#d9d9de] bg-white px-2.5 text-[0.6875rem] font-medium text-[#3c3f46] transition hover:bg-[#f2f2f4]"
        >
          条件をクリア
        </button>
      )}
    </div>
  );
}
