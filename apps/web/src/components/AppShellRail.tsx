'use client';

import {
  ChevronRight,
  Command,
  FileText,
  Folder,
  FolderOpen,
  LogOut,
  Search,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppShellFolderTree } from '@/components/AppShellFolderTree';
import { ClassificationBadge } from '@/components/ClassificationBadge';
import { ModalShell } from '@/components/ModalShell';
import {
  getDropTargetClassName,
  useWorkspaceDrag,
} from '@/components/WorkspaceDragPortal';
import { ROOT_DROP_ID } from '@/lib/drag-drop-controller';
import {
  logoutSession,
  searchWorkspaceFiles,
} from '@/lib/files-api';
import { formatBytes, formatDateTime } from '@/lib/formatters';
import {
  buildPaletteCommands,
  isImeComposingEvent,
  keyboardScopes,
  mergePaletteEntries,
  type PaletteCommand,
  type PaletteEntry,
} from '@/lib/keyboard-shortcuts';
import {
  getWorkspaceSyncStore,
  useWorkspaceSyncSnapshot,
} from '@/lib/sync-store';
import type { AuthUser, SearchResultItem } from '@/types/files';

export interface WorkspacePaletteActions {
  hasTargetItem: boolean;
  canClassifyTarget: boolean;
  canShareTarget: boolean;
  canTrashTarget: boolean;
  canCopyTarget?: boolean;
  canCutTarget?: boolean;
  canPasteClipboard?: boolean;
  canDuplicateTarget?: boolean;
  onCommand: (
    commandId:
      | 'cmd:new-folder'
      | 'cmd:move-copy'
      | 'cmd:copy'
      | 'cmd:cut'
      | 'cmd:paste'
      | 'cmd:duplicate'
      | 'cmd:toggle-inspector'
      | 'cmd:toggle-view'
      | 'cmd:change-classification'
      | 'cmd:share'
      | 'cmd:trash'
      | 'cmd:shortcuts'
  ) => void;
}

export function AppShellRail({
  user,
  activeView,
  activeFolderId = null,
  onSelectResult,
  onSelectFolder,
  workspaceActions,
}: {
  user: AuthUser | null;
  activeView?: 'workspace' | 'trash' | 'admin';
  activeFolderId?: string | null;
  onSelectResult?: (item: SearchResultItem) => void;
  onSelectFolder?: (folderId: string) => void;
  workspaceActions?: WorkspacePaletteActions;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const syncStore = getWorkspaceSyncStore();
  const snapshot = useWorkspaceSyncSnapshot();
  const dragCtx = useWorkspaceDrag();

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scopeTokenRef = useRef<string | null>(null);

  const resolvedView =
    activeView ?? (pathname.startsWith('/admin') ? 'admin' : 'workspace');
  const isAdmin = user?.role === 'sys_admin' || user?.role === 'sec_admin';

  useEffect(() => {
    if (!searchOpen) return;
    const token = keyboardScopes.pushScope('palette');
    scopeTokenRef.current = token;
    setActiveIndex(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      window.clearTimeout(t);
      keyboardScopes.popScope(token);
      if (scopeTokenRef.current === token) {
        scopeTokenRef.current = null;
      }
    };
  }, [searchOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (isImeComposingEvent(e)) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
        return;
      }
      if (
        e.key === 'Escape' &&
        searchOpen &&
        (!scopeTokenRef.current || keyboardScopes.isTopToken(scopeTokenRef.current))
      ) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const trimmed = query.trim();
    if (!trimmed || trimmed.startsWith('>')) {
      setRemoteResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      searchWorkspaceFiles(trimmed, 20)
        .then((res) => {
          if (!cancelled) setRemoteResults(res.results);
        })
        .catch(() => {
          if (!cancelled) setRemoteResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, searchOpen]);

  const commands = useMemo(
    () =>
      buildPaletteCommands({
        isAdmin,
        isWorkspace: resolvedView === 'workspace' && Boolean(workspaceActions),
        hasTargetItem: Boolean(workspaceActions?.hasTargetItem),
        canClassifyTarget: Boolean(workspaceActions?.canClassifyTarget),
        canShareTarget: Boolean(workspaceActions?.canShareTarget),
        canTrashTarget: Boolean(workspaceActions?.canTrashTarget),
        canCopyTarget: Boolean(workspaceActions?.canCopyTarget),
        canCutTarget: Boolean(workspaceActions?.canCutTarget),
        canPasteClipboard: Boolean(workspaceActions?.canPasteClipboard),
        canDuplicateTarget: Boolean(workspaceActions?.canDuplicateTarget),
      }),
    [isAdmin, resolvedView, workspaceActions]
  );

  const localHits = useMemo(() => {
    if (!searchOpen) return { folders: [], files: [] };
    return syncStore.searchCachedWorkspaceItems(query, 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStore, searchOpen, query, snapshot.revision]);

  const entries = useMemo<PaletteEntry[]>(() => {
    if (!searchOpen) return [];
    return mergePaletteEntries({
      query,
      commands,
      localFolders: localHits.folders,
      localFiles: localHits.files,
      remoteResults,
    });
  }, [searchOpen, query, commands, localHits, remoteResults]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, searchOpen]);

  useEffect(() => {
    if (entries.length === 0) {
      setActiveIndex(0);
    } else if (activeIndex >= entries.length) {
      setActiveIndex(entries.length - 1);
    }
  }, [entries.length, activeIndex]);

  useEffect(() => {
    if (!searchOpen || !listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(
      `[data-palette-index="${activeIndex}"]`
    );
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, searchOpen]);

  async function handleLogout() {
    await logoutSession();
    router.push('/');
    router.refresh();
  }

  function handlePickResult(item: SearchResultItem) {
    setSearchOpen(false);
    if (onSelectResult) {
      onSelectResult(item);
      return;
    }
    if (item.folderId) {
      router.push(`/workspace?folderId=${encodeURIComponent(item.folderId)}`);
    } else {
      router.push('/workspace');
    }
  }

  function handleExecuteCommand(command: PaletteCommand) {
    switch (command.id) {
      case 'filter:confidential':
        setQuery('is:confidential ');
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
      case 'filter:internal':
        setQuery('is:internal ');
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
      case 'filter:unset':
        setQuery('is:unset ');
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
      case 'nav:workspace':
        setSearchOpen(false);
        router.push('/workspace');
        return;
      case 'nav:trash':
        setSearchOpen(false);
        router.push('/workspace?view=trash');
        return;
      case 'nav:admin':
        setSearchOpen(false);
        router.push('/admin');
        return;
      case 'action:logout':
        setSearchOpen(false);
        void handleLogout();
        return;
      case 'cmd:new-folder':
      case 'cmd:move-copy':
      case 'cmd:copy':
      case 'cmd:cut':
      case 'cmd:paste':
      case 'cmd:duplicate':
      case 'cmd:toggle-inspector':
      case 'cmd:toggle-view':
      case 'cmd:change-classification':
      case 'cmd:share':
      case 'cmd:trash':
      case 'cmd:shortcuts':
        setSearchOpen(false);
        workspaceActions?.onCommand(command.id);
        return;
    }
  }

  function handleExecuteEntry(entry: PaletteEntry | undefined) {
    if (!entry) return;
    if (entry.kind === 'command') {
      handleExecuteCommand(entry.command);
      return;
    }
    if (entry.kind === 'local-folder') {
      setSearchOpen(false);
      if (onSelectFolder) {
        onSelectFolder(entry.folder.id);
      } else {
        router.push(`/workspace?folderId=${encodeURIComponent(entry.folder.id)}`);
      }
      return;
    }
    handlePickResult(entry.item);
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (isImeComposingEvent(e)) return;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) {
      if (entries.length > 0) {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % entries.length);
      }
      return;
    }
    if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p')) {
      if (entries.length > 0) {
        e.preventDefault();
        setActiveIndex((prev) => (prev - 1 + entries.length) % entries.length);
      }
      return;
    }
    if (e.key === 'Enter') {
      if (entries[activeIndex]) {
        e.preventDefault();
        handleExecuteEntry(entries[activeIndex]);
      }
    }
  }

  return (
    <>
      <aside className="sticky top-0 flex h-screen w-[245px] shrink-0 self-start flex-col justify-between bg-[#efeff1] text-[#111214]">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 px-3 pb-2 pt-4">
            <div className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-[#5e6ad2] text-[0.6875rem] font-semibold text-white">
              F
            </div>
            <div className="min-w-0">
              <div className="truncate text-[0.8125rem] font-semibold tracking-[-0.01em] text-[#111214]">
                Files
              </div>
              <div className="truncate text-[0.6875rem] text-[#3c3f46]">
                Enterprise Governance
              </div>
            </div>
          </div>

          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="flex h-7 w-full items-center justify-between rounded-md px-2 text-[0.8125rem] text-[#111214] transition hover:bg-[#e4e4e6] hover:text-[#111214]"
            >
              <span className="flex items-center gap-2">
                <Search className="h-4 w-4 text-[#676b72]" />
                <span>横断検索...</span>
              </span>
              <kbd className="rounded border border-[#d7d7dc] bg-[#f9f9fa] px-1 py-0.5 font-mono text-[0.625rem] text-[#3c3f46]">
                ⌘K
              </kbd>
            </button>
          </div>

          <nav aria-label="メインナビゲーション" className="space-y-0.5 px-2">
            <Link
              href="/workspace"
              data-drop-folder-id={ROOT_DROP_ID}
              data-drop-label="マイファイル"
              className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                dragCtx?.isDragging
                  ? `${getDropTargetClassName(
                      null,
                      dragCtx.hoveredTarget
                    ) || (resolvedView === 'workspace'
                      ? 'bg-[#e2e2e6] text-[#111214]'
                      : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]')}`
                  : resolvedView === 'workspace'
                    ? 'bg-[#e2e2e6] text-[#111214]'
                    : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
              }`}
            >
              <FolderOpen className="h-4 w-4 text-[#676b72]" />
              <span>マイファイル</span>
            </Link>

            <Link
              href="/workspace?view=trash"
              className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                resolvedView === 'trash'
                  ? 'bg-[#e2e2e6] text-[#111214]'
                  : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
              }`}
            >
              <Trash2 className="h-4 w-4 text-[#676b72]" />
              <span>ゴミ箱</span>
            </Link>

            {isAdmin && (
              <Link
                href="/admin"
                className={`flex h-7 items-center gap-2 rounded-md px-2 text-[0.8125rem] font-medium transition ${
                  resolvedView === 'admin'
                    ? 'bg-[#e2e2e6] text-[#111214]'
                    : 'text-[#111214] hover:bg-[#e6e6e8] hover:text-[#111214]'
                }`}
              >
                <ShieldAlert className="h-4 w-4 text-[#676b72]" />
                <span>ガバナンス</span>
              </Link>
            )}
          </nav>

          {user && (resolvedView === 'workspace' || resolvedView === 'trash') && (
            <AppShellFolderTree
              syncStore={syncStore}
              activeFolderId={activeFolderId}
              revision={snapshot.revision}
              onSelectFolder={onSelectFolder}
            />
          )}
        </div>

        <div className="p-2 pb-8">
          {user ? (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-[#e6e6e8]">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#5e6ad2] text-[0.625rem] font-semibold text-white">
                {user.displayName.slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[0.75rem] font-medium text-[#111214]">
                  {user.displayName}
                </div>
                <div className="truncate text-[0.6875rem] text-[#3c3f46]">
                  {user.email}
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                title="サインアウト"
                className="flex h-6 w-6 items-center justify-center rounded text-[#676b72] transition hover:bg-[#dcdcdf] hover:text-[#111214]"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="px-2 py-1 text-[0.75rem] text-[#3c3f46]">未認証</div>
          )}
        </div>
      </aside>

      {searchOpen && (
        <ModalShell
          label="横断検索"
          onClose={() => setSearchOpen(false)}
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
                aria-expanded={searchOpen}
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
                onClick={() => setSearchOpen(false)}
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
                            {item.folderName ?? 'Root'} • {formatBytes(item.sizeBytes)} •{' '}
                            {formatDateTime(item.updatedAt)}
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
      )}
    </>
  );
}
