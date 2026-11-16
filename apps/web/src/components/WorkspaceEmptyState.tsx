'use client';

import { Folder, SearchX, Trash2 } from 'lucide-react';

export function WorkspaceEmptyState({
  isTrashView,
  folderId,
  pathOnly = false,
  uploadOnly = false,
  trashFilterActive = false,
  rootCreationRestricted = false,
  onClearTrashFilters,
  onContextMenu,
  onClick,
}: {
  isTrashView: boolean;
  folderId: string | null;
  pathOnly?: boolean;
  uploadOnly?: boolean;
  trashFilterActive?: boolean;
  rootCreationRestricted?: boolean;
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
            : pathOnly
              ? '移動可能な子孫フォルダがありません'
              : uploadOnly
                ? 'Uploader 権限のためファイルは非表示です'
                : folderId
                  ? 'このフォルダは空です'
                  : 'アクセス可能なルートフォルダがありません'}
      </p>
      <p className="mt-1 max-w-sm text-[0.6875rem] leading-relaxed text-[#6b6f76]">
        {filteredTrashEmpty
          ? '検索語やフィルタを変更するか、条件をクリアしてください'
          : isTrashView
            ? '削除したアイテムはここに表示されます'
            : pathOnly
              ? 'この階層はアクセス可能な共有フォルダへ移動するためのパス表示です。ファイルのアップロード・編集はできません。'
              : uploadOnly
                ? 'アップロード専用のため、既存ファイルの一覧・プレビュー・ダウンロードは表示されません。上のアップロード欄から新しいファイルを追加できます。'
                : rootCreationRestricted
                  ? '現在 Closed 構成のため、ルート直下の作成・移動は sys_admin のみ可能です。既存ルートフォルダ内では引き続き作成できます。'
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
