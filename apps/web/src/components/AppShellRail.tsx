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
      <aside className="flex w-60 shrink-0 flex-col justify-between bg-[#131B2E] text-slate-200 border-r border-slate-800/80">
        <div>
          <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-800/80">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold text-white shadow-sm">
              F
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight text-white">
                Files
              </div>
              <div className="text-[11px] text-slate-400">
                Enterprise Governance
              </div>
            </div>
          </div>

          <div className="p-3">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="flex w-full items-center justify-between rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-xs text-slate-300 hover:border-slate-600 hover:text-white transition"
            >
              <span className="flex items-center gap-2">
                <Search className="h-3.5 w-3.5 text-slate-400" />
                <span>横断検索...</span>
              </span>
              <kbd className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                ⌘K
              </kbd>
            </button>
          </div>

          <nav className="px-3 space-y-1">
            <Link
              href="/workspace"
              data-drop-folder-id={ROOT_DROP_ID}
              data-drop-label="マイファイル"
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                dragCtx?.isDragging
                  ? `${getDropTargetClassName(
                      null,
                      dragCtx.hoveredTarget,
                      dragCtx.springTargetId
                    ) || (resolvedView === 'workspace'
                      ? 'bg-blue-600/20 text-white border border-blue-500/30'
                      : 'text-slate-300 hover:bg-slate-800/70 hover:text-white')}`
                  : resolvedView === 'workspace'
                    ? 'bg-blue-600/20 text-white border border-blue-500/30'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
              }`}
            >
              <FolderOpen className="h-4 w-4 text-blue-400" />
              <span>マイファイル</span>
            </Link>

            <Link
              href="/workspace?view=trash"
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                resolvedView === 'trash'
                  ? 'bg-blue-600/20 text-white border border-blue-500/30'
                  : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
              }`}
            >
              <Trash2 className="h-4 w-4 text-slate-400" />
              <span>ゴミ箱</span>
            </Link>

            {isAdmin && (
              <Link
                href="/admin"
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  resolvedView === 'admin'
                    ? 'bg-blue-600/20 text-white border border-blue-500/30'
                    : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
                }`}
              >
                <ShieldAlert className="h-4 w-4 text-amber-400" />
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

        <div className="border-t border-slate-800/80 p-3">
          {user ? (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-slate-900/60 px-3 py-2.5">
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-white">
                  {user.displayName}
                </div>
                <div className="truncate text-[11px] text-slate-400">
                  {user.email}
                </div>
                <div className="mt-1 inline-block rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-300">
                  {user.role}
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                title="サインアウト"
                className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="text-xs text-slate-400 px-2 py-1">未認証</div>
          )}
        </div>
      </aside>

      {searchOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/60 pt-20 px-4 backdrop-blur-xs"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="w-full max-w-2xl overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
              <Search className="h-4 w-4 shrink-0 text-slate-400" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="ファイル名・コマンド検索 (> コマンド, is:confidential, is:unset)"
                className="w-full bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none"
              />
              {searching && (
                <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-600">
                  FTS5検索中...
                </span>
              )}
              <button
                type="button"
                onClick={() => setSearchOpen(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-xs">
              <span className="text-slate-500">クイック入力:</span>
              <button
                type="button"
                onClick={() => {
                  setQuery('> ');
                  inputRef.current?.focus();
                }}
                className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 font-mono text-[11px] text-indigo-700 hover:border-indigo-400"
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
                  className="rounded-full border border-slate-200 bg-white px-2.5 py-0.5 font-mono text-[11px] text-slate-700 hover:border-blue-400 hover:text-blue-700"
                >
                  {chip}
                </button>
              ))}
            </div>

            <div
              ref={listRef}
              className="max-h-96 overflow-y-auto divide-y divide-slate-100"
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
                  const baseRowClass = `flex w-full items-center justify-between gap-4 px-4 py-2.5 text-left transition ${
                    isActive ? 'bg-blue-50/90' : 'hover:bg-slate-50'
                  }`;

                  if (entry.kind === 'command') {
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        data-palette-index={idx}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => handleExecuteEntry(entry)}
                        className={baseRowClass}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-slate-900 text-white">
                            <Sparkles className="h-3.5 w-3.5" />
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-slate-900">
                              {entry.command.label}
                            </div>
                            <div className="truncate text-xs text-slate-500">
                              {entry.command.description}
                            </div>
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {entry.command.shortcutHint && (
                            <kbd className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600">
                              {entry.command.shortcutHint}
                            </kbd>
                          )}
                          <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
                        </div>
                      </button>
                    );
                  }

                  if (entry.kind === 'local-folder') {
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        data-palette-index={idx}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => handleExecuteEntry(entry)}
                        className={baseRowClass}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <Folder className="h-4 w-4 shrink-0 text-amber-500" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm font-medium text-slate-900">
                                {entry.folder.name}
                              </span>
                              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                キャッシュ即応
                              </span>
                            </div>
                            <div className="truncate text-xs text-slate-500">
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
                      data-palette-index={idx}
                      onMouseEnter={() => setActiveIndex(idx)}
                      onClick={() => handleExecuteEntry(entry)}
                      className={baseRowClass}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-slate-900">
                              {item.name}
                            </span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                entry.source === 'local'
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              {entry.source === 'local' ? 'キャッシュ即応' : 'FTS5'}
                            </span>
                          </div>
                          <div className="truncate text-xs text-slate-500">
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

            <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 text-[11px] text-slate-500">
              <span>↑/↓ で移動 • Enter で実行 • Esc で閉じる</span>
              <span className="font-mono">0ms ローカル + FTS5</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
