'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { logoutSession, searchWorkspaceFiles } from '@/lib/files-api';
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

export function useCommandPalette({
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
  activeView: 'workspace' | 'trash' | 'admin' | 'shared';
  workspaceActions?: WorkspacePaletteActions;
  onSelectResult?: (item: SearchResultItem) => void;
  onSelectFolder?: (folderId: string) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const syncStore = getWorkspaceSyncStore();
  const snapshot = useWorkspaceSyncSnapshot();
  const [query, setQuery] = useState('');
  const [remoteResults, setRemoteResults] = useState<SearchResultItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scopeTokenRef = useRef<string | null>(null);

  const isAdmin =
    user?.role === 'sys_admin' || user?.role === 'sec_admin';

  useEffect(() => {
    if (!open) return;
    const token = keyboardScopes.pushScope('palette');
    scopeTokenRef.current = token;
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => {
      window.clearTimeout(timer);
      keyboardScopes.popScope(token);
      if (scopeTokenRef.current === token) scopeTokenRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
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
  }, [open, query]);

  const commands = useMemo(
    () =>
      buildPaletteCommands({
        isAdmin,
        isWorkspace:
          activeView === 'workspace' && Boolean(workspaceActions),
        hasTargetItem: Boolean(workspaceActions?.hasTargetItem),
        canCreateFolder: Boolean(workspaceActions?.canCreateFolder),
        canInspectTarget: Boolean(workspaceActions?.canInspectTarget),
        canMoveCopyTarget: Boolean(workspaceActions?.canMoveCopyTarget),
        canClassifyTarget: Boolean(workspaceActions?.canClassifyTarget),
        canShareTarget: Boolean(workspaceActions?.canShareTarget),
        canTrashTarget: Boolean(workspaceActions?.canTrashTarget),
        canCopyTarget: Boolean(workspaceActions?.canCopyTarget),
        canCutTarget: Boolean(workspaceActions?.canCutTarget),
        canPasteClipboard: Boolean(
          workspaceActions?.canPasteClipboard
        ),
        canDuplicateTarget: Boolean(
          workspaceActions?.canDuplicateTarget
        ),
      }),
    [activeView, isAdmin, workspaceActions]
  );

  const localHits = useMemo(() => {
    if (!open) return { folders: [], files: [] };
    return syncStore.searchCachedWorkspaceItems(query, 20);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncStore, open, query, snapshot.revision]);

  const entries = useMemo<PaletteEntry[]>(() => {
    if (!open) return [];
    return mergePaletteEntries({
      query,
      commands,
      localFolders: localHits.folders,
      localFiles: localHits.files,
      remoteResults,
    });
  }, [open, query, commands, localHits, remoteResults]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (entries.length === 0) {
      setActiveIndex(0);
    } else if (activeIndex >= entries.length) {
      setActiveIndex(entries.length - 1);
    }
  }, [entries.length, activeIndex]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.querySelector<HTMLElement>(
      `[data-palette-index="${activeIndex}"]`
    );
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  async function handleLogout() {
    await logoutSession();
    router.push('/');
    router.refresh();
  }

  function handlePickResult(item: SearchResultItem) {
    onClose();
    if (onSelectResult) {
      onSelectResult(item);
      return;
    }
    if (item.folderId) {
      router.push(
        `/workspace?folderId=${encodeURIComponent(item.folderId)}`
      );
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
        onClose();
        router.push('/workspace');
        return;
      case 'nav:trash':
        onClose();
        router.push('/workspace?view=trash');
        return;
      case 'nav:admin':
        onClose();
        router.push('/admin');
        return;
      case 'action:logout':
        onClose();
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
        onClose();
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
      onClose();
      if (onSelectFolder) {
        onSelectFolder(entry.folder.id);
      } else {
        router.push(
          `/workspace?folderId=${encodeURIComponent(entry.folder.id)}`
        );
      }
      return;
    }
    handlePickResult(entry.item);
  }

  function handleInputKeyDown(
    e: React.KeyboardEvent<HTMLInputElement>
  ) {
    if (isImeComposingEvent(e)) return;
    if (
      e.key === 'ArrowDown' ||
      (e.ctrlKey && e.key.toLowerCase() === 'n')
    ) {
      if (entries.length > 0) {
        e.preventDefault();
        setActiveIndex((prev) => (prev + 1) % entries.length);
      }
      return;
    }
    if (
      e.key === 'ArrowUp' ||
      (e.ctrlKey && e.key.toLowerCase() === 'p')
    ) {
      if (entries.length > 0) {
        e.preventDefault();
        setActiveIndex(
          (prev) => (prev - 1 + entries.length) % entries.length
        );
      }
      return;
    }
    if (e.key === 'Enter' && entries[activeIndex]) {
      e.preventDefault();
      handleExecuteEntry(entries[activeIndex]);
    }
  }

  return {
    inputRef,
    listRef,
    query,
    setQuery,
    searching,
    activeIndex,
    entries,
    setActiveIndex,
    handleInputKeyDown,
    handleExecuteEntry,
  };
}
