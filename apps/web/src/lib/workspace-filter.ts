import type {
  ClassificationLabel,
  FileItem,
  FolderSummary,
} from '@/types/files';

export type WorkspaceQuickFilterItemType = 'all' | 'folder' | 'file';

export interface WorkspaceQuickFilter {
  query: string;
  itemType: WorkspaceQuickFilterItemType;
  classification: 'all' | ClassificationLabel;
}

export const DEFAULT_WORKSPACE_QUICK_FILTER: WorkspaceQuickFilter = {
  query: '',
  itemType: 'all',
  classification: 'all',
};

export function isWorkspaceFilterActive(filter: WorkspaceQuickFilter): boolean {
  return (
    filter.query.trim().length > 0 ||
    filter.itemType !== 'all' ||
    filter.classification !== 'all'
  );
}

export function filterWorkspaceItems(params: {
  folders: FolderSummary[];
  files: FileItem[];
  filter: WorkspaceQuickFilter;
}): { folders: FolderSummary[]; files: FileItem[] } {
  const { folders, files, filter } = params;
  if (!isWorkspaceFilterActive(filter)) {
    return { folders, files };
  }

  const normalizedQuery = filter.query.trim().toLowerCase();
  const matchesQuery = (name: string) =>
    normalizedQuery.length === 0 || name.toLowerCase().includes(normalizedQuery);
  const matchesClassification = (cls: ClassificationLabel) =>
    filter.classification === 'all' || cls === filter.classification;

  const filteredFolders =
    filter.itemType === 'file'
      ? []
      : folders.filter(
          (folder) =>
            matchesQuery(folder.name) &&
            matchesClassification(folder.classification)
        );

  const filteredFiles =
    filter.itemType === 'folder'
      ? []
      : files.filter(
          (file) =>
            matchesQuery(file.name) &&
            matchesClassification(file.classification)
        );

  return {
    folders: filteredFolders,
    files: filteredFiles,
  };
}
