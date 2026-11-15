'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  loadWorkspaceViewPrefs,
  nextSortDirection,
  saveWorkspaceViewPrefs,
  type WorkspaceSortDirection,
  type WorkspaceSortField,
  type WorkspaceViewMode,
} from '@/lib/workspace-sort-and-view';
import type { AuthUser } from '@/types/files';

export function useWorkspaceViewPrefs(user: AuthUser | null) {
  const [sortBy, setSortBy] = useState<WorkspaceSortField>('name');
  const [sortDir, setSortDir] = useState<WorkspaceSortDirection>('asc');
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>('list');
  const prefsUserKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user) {
      prefsUserKeyRef.current = null;
      return;
    }
    const userKey = `${user.tenantId}:${user.id}`;
    if (prefsUserKeyRef.current === userKey) return;

    prefsUserKeyRef.current = userKey;
    const prefs = loadWorkspaceViewPrefs(user.tenantId, user.id);
    setSortBy(prefs.sortBy);
    setSortDir(prefs.sortDir);
    setViewMode(prefs.viewMode);
  }, [user]);

  const handleSortHeaderClick = useCallback(
    (field: WorkspaceSortField) => {
      const next = nextSortDirection(sortBy, sortDir, field);
      setSortBy(next.sortBy);
      setSortDir(next.sortDir);
      if (user) {
        saveWorkspaceViewPrefs(user.tenantId, user.id, {
          sortBy: next.sortBy,
          sortDir: next.sortDir,
          viewMode,
        });
      }
    },
    [sortBy, sortDir, user, viewMode]
  );

  const handleToggleViewMode = useCallback(() => {
    setViewMode((prev) => {
      const next: WorkspaceViewMode = prev === 'list' ? 'grid' : 'list';
      if (user) {
        saveWorkspaceViewPrefs(user.tenantId, user.id, {
          sortBy,
          sortDir,
          viewMode: next,
        });
      }
      return next;
    });
  }, [user, sortBy, sortDir]);

  return {
    sortBy,
    sortDir,
    viewMode,
    setSortBy,
    setSortDir,
    setViewMode,
    handleSortHeaderClick,
    handleToggleViewMode,
  };
}
