'use client';

import {
  ChevronRight,
  Command,
  FileText,
  Folder,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ModalShell } from '@/components/ModalShell';
import { useCommandPalette } from '@/lib/use-command-palette';
import { logoutSession, searchWorkspaceFiles } from '@/lib/files-api';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import {
  buildPaletteCommands,
  isImeComposingEvent,
  keyboardScopes,
  mergePaletteEntries,
  type PaletteCommand,
  type PaletteEntry,
} from '@/lib/keyboard-shortcuts';
import type { WorkspacePaletteActions } from '@/lib/palette-actions';
import {
  getWorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import type { AuthUser, SearchResultItem } from '@/types/files';

export function CommandPalette({
  open,
  user,
  activeView,
  workspaceActions,
  onSelectResult,
  onSelectFolder,
  onClose,
}: {
  open: boolean;
  user: AuthUser | null;
  activeView: 'workspace' | 'trash' | 'admin';
  workspaceActions?: WorkspacePaletteActions;
  onSelectResult?: (item: SearchResultItem) => void;
  onSelectFolder?: (folderId: string) => void;
  onClose: () => void;
}) {
  const {
    inputRef,
    listRef,
    query,
    setQuery,
    searching,
    activeIndex,
    setActiveIndex,
    entries,
    handleInputKeyDown,
    handleExecuteEntry,
  } = useCommandPalette({
    open,
    user,
    activeView,
    workspaceActions,
    onSelectResult,
    onSelectFolder,
    onClose,
  });

  if (!open) return null;

  return (
    <ModalShell
      label="横断検索"
      onClose={onClose}
      align="top"
      backdrop="light"
      blur={false}
      className="w-full max-w-2xl overflow-hidden rounded-xl border border-[#e7e7ea] bg-white shadow-2xl"
    >
      <div className="flex items-center gap-3 border-b border-[#f0f0f1] px-4 py-3">
        <Search className="h-4 w-4 shrink-0 text-[#676b72]" />
        <input
          ref={inputRef}
          id="workspace-search-input"
          name="workspaceSearch"
          role="combobox"
          aria-label="ワークスペースを検索"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls="workspace-search-listbox"
          aria-activedescendant={
            entries[activeIndex]
              ? `workspace-search-option-${activeIndex}`
              : undefined
          }
          autoComplete="off"
          spellCheck={false}
          data-autofocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleInputKeyDown}
          placeholder="ファイル名・コマンド検索 (> コマンド, is:confidential, is:unset)"
          className="w-full rounded bg-transparent text-[0.8125rem] text-[#111214] placeholder:text-[#676b72] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#5e6ad2]/45"
        />
        {searching && (
          <span className="shrink-0 rounded bg-[#eef0fb] px-2 py-0.5 text-[0.625rem] font-medium text-[#5e6ad2]">
            FTS5検索中...
          </span>
        )}
        <button
          type="button"
          aria-label="検索を閉じる"
          onClick={onClose}
          className="rounded p-1 text-[#676b72] transition hover:bg-[#f2f2f4] hover:text-[#111214]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-[#f0f0f1] bg-[#f9f9fa] px-4 py-2 text-[0.6875rem]">
        <span className="text-[#676b72]">クイック入力:</span>
        <button
          type="button"
          onClick={() => {
            setQuery('> ');
            inputRef.current?.focus();
          }}
          className="inline-flex min-h-6 items-center gap-1 rounded-md border border-[#dfe2f5] bg-[#eef0fb] px-2 py-0.5 font-mono text-[0.6875rem] text-[#4f5ac2] transition hover:border-[#bcc3ea]"
        >
          <Command className="h-3 w-3" />
          <span>&gt; コマンド</span>
        </button>
        {['is:confidential', 'is:internal', 'is:unset'].map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => {
              setQuery(`${chip} `);
              inputRef.current?.focus();
            }}
            className="min-h-6 rounded-md border border-[#e7e7ea] bg-white px-2 py-0.5 font-mono text-[0.6875rem] text-[#55565a] transition hover:border-[#bcc3ea] hover:text-[#4f5ac2]"
          >
            {chip}
          </button>
        ))}
      </div>

      <div
        ref={listRef}
        id="workspace-search-listbox"
        role="listbox"
        aria-label="検索結果"
        className="max-h-96 overflow-y-auto divide-y divide-[#f0f0f1]"
      >
        {entries.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            {searching
              ? 'ローカルキャッシュに一致なし・FTS5 インデックスを検索中...'
              : query.trim()
                ? '該当するファイルまたはコマンドはありません'
                : 'コマンドまたはファイル名を入力してください'}
          </div>
        ) : (
          entries.map((entry, idx) => {
            const isActive = idx === activeIndex;
            const baseRowClass = `flex w-full items-center justify-between gap-4 px-3 py-2 text-left transition ${
              isActive ? 'bg-[#eef0fb]' : 'hover:bg-[#f4f4f5]'
            }`;

            if (entry.kind === 'command') {
              return (
                <button
                  key={entry.key}
                  type="button"
                  id={`workspace-search-option-${idx}`}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={-1}
                  data-palette-index={idx}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handleExecuteEntry(entry)}
                  className={baseRowClass}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#f4f4f5] text-[#55565a]">
                      <Sparkles className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0">
                      <div className="truncate text-[0.8125rem] font-medium text-[#111214]">
                        {entry.command.label}
                      </div>
                      <div className="truncate text-[0.6875rem] text-[#3c3f46]">
                        {entry.command.description}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {entry.command.shortcutHint && (
                      <kbd className="rounded border border-[#e7e7ea] bg-white px-1.5 py-0.5 font-mono text-[0.625rem] text-[#55565a]">
                        {entry.command.shortcutHint}
                      </kbd>
                    )}
                    <ChevronRight className="h-3.5 w-3.5 text-[#b4b4bb]" />
                  </div>
                </button>
              );
            }

            if (entry.kind === 'local-folder') {
              return (
                <button
                  key={entry.key}
                  type="button"
                  id={`workspace-search-option-${idx}`}
                  role="option"
                  aria-selected={isActive}
                  tabIndex={-1}
                  data-palette-index={idx}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handleExecuteEntry(entry)}
                  className={baseRowClass}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[0.8125rem] font-medium text-[#111214]">
                          {entry.folder.name}
                        </span>
                        <span className="rounded bg-[#eef7f1] px-1 py-0.5 text-[0.625rem] font-medium text-[#2f7a52]">
                          キャッシュ即応
                        </span>
                      </div>
                      <div className="truncate text-[0.6875rem] text-[#3c3f46]">
                        {entry.pathHint} • フォルダ
                      </div>
                    </div>
                  </div>
                  <ClassificationBadge
                    classification={entry.folder.classification}
                    compact
                  />
                </button>
              );
            }

            const item = entry.item;
            return (
              <button
                key={entry.key}
                type="button"
                id={`workspace-search-option-${idx}`}
                role="option"
                aria-selected={isActive}
                tabIndex={-1}
                data-palette-index={idx}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => handleExecuteEntry(entry)}
                className={baseRowClass}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <FileText className="h-4 w-4 shrink-0 text-[#676b72]" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[0.8125rem] font-medium text-[#111214]">
                        {item.name}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[0.625rem] font-medium ${
                          entry.source === 'local'
                            ? 'bg-[#eef7f1] text-[#2f7a52]'
                            : 'bg-[#f4f4f5] text-[#55565a]'
                        }`}
                      >
                        {entry.source === 'local' ? 'キャッシュ即応' : 'FTS5'}
                      </span>
                    </div>
                    <div className="truncate text-[0.6875rem] text-[#3c3f46]">
                      {item.folderName ?? 'Root'} • {formatBytes(item.sizeBytes)}{' '}
                      • {formatDateTime(item.updatedAt)}
                    </div>
                  </div>
                </div>
                <ClassificationBadge
                  classification={item.classification}
                  compact
                />
              </button>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 text-[0.6875rem] text-slate-500">
        <span>↑/↓ で移動 • Enter で実行 • Esc で閉じる</span>
        <span className="font-mono">0ms ローカル + FTS5</span>
      </div>
    </ModalShell>
  );
}
