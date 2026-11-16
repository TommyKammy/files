import type { DestinationRow } from '@/components/DestinationRowButton';
import type { RecentDestinationEntry } from '@/lib/workspace-actions';
import type { FolderSummary, ResourceRole } from '@/types/files';

export interface DestinationRowSource {
  searchCachedWorkspaceItems(
    query: string,
    limit: number
  ): {
    folders: Array<{ folder: FolderSummary; pathHint: string }>;
  };
  getDirectoryView(folderId: string | null): {
    folder: FolderSummary | null;
    effectiveRole: ResourceRole;
    folders: FolderSummary[];
  };
}

export function buildDestinationRows({
  query,
  recentList,
  expandedIds,
  source,
}: {
  query: string;
  recentList: RecentDestinationEntry[];
  expandedIds: Set<string>;
  source: DestinationRowSource;
}): DestinationRow[] {
  const rows: DestinationRow[] = [];
  const trimmedQuery = query.trim().toLowerCase();

  if (trimmedQuery) {
    const matches = source.searchCachedWorkspaceItems(trimmedQuery, 40).folders;
    rows.push({
      rowKey: 'tree:__ROOT__',
      section: 'tree',
      folderId: null,
      name: 'マイファイル (ルート)',
      depth: 0,
      classification: 'unset',
      effectiveRole: 'editor',
      isExpanded: false,
      canExpand: false,
    });
    for (const entry of matches) {
      rows.push({
        rowKey: `tree:${entry.folder.id}`,
        section: 'tree',
        folderId: entry.folder.id,
        name: `${entry.folder.name} (${entry.pathHint})`,
        depth: 1,
        classification: entry.folder.classification,
        effectiveRole: entry.folder.effectiveRole ?? 'viewer',
        isExpanded: false,
        canExpand: false,
      });
    }
    return rows;
  }

  // Recent destinations section
  for (const recent of recentList) {
    if (recent.id === null) {
      rows.push({
        rowKey: 'recent:__ROOT__',
        section: 'recent',
        folderId: null,
        name: 'マイファイル (ルート)',
        depth: 0,
        classification: 'unset',
        effectiveRole: 'editor',
        isExpanded: false,
        canExpand: false,
      });
    } else {
      const cached = source.getDirectoryView(recent.id);
      if (!cached.folder || cached.folder.deleted_at != null) continue;
      rows.push({
        rowKey: `recent:${recent.id}`,
        section: 'recent',
        folderId: recent.id,
        name: cached.folder.name,
        depth: 0,
        classification: cached.folder.classification,
        effectiveRole: cached.effectiveRole,
        isExpanded: false,
        canExpand: false,
      });
    }
  }

  // Root node
  rows.push({
    rowKey: 'tree:__ROOT__',
    section: 'tree',
    folderId: null,
    name: 'マイファイル (ルート)',
    depth: 0,
    classification: 'unset',
    effectiveRole: 'editor',
    isExpanded: true,
    canExpand: false,
  });

  const walk = (
    parentId: string | null,
    depth: number,
    visited: Set<string>
  ) => {
    if (depth > 6) return;
    const view = source.getDirectoryView(parentId);
    const sorted = [...view.folders].sort((a, b) =>
      a.name.localeCompare(b.name, 'ja')
    );
    for (const folder of sorted) {
      if (visited.has(folder.id)) continue;
      visited.add(folder.id);
      const isExp = expandedIds.has(folder.id);
      rows.push({
        rowKey: `tree:${folder.id}`,
        section: 'tree',
        folderId: folder.id,
        name: folder.name,
        depth,
        classification: folder.classification,
        effectiveRole:
          folder.effectiveRole ??
          source.getDirectoryView(folder.id).effectiveRole,
        isExpanded: isExp,
        canExpand: true,
      });
      if (isExp) {
        walk(folder.id, depth + 1, visited);
      }
    }
  };

  walk(null, 1, new Set());
  return rows;
}
