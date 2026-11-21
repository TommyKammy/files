import { ApiClientError, createFolder, listFolderChildren } from '@/lib/files-api';
import type { FolderSummary } from '@/types/files';

export interface UploadFileEntry {
  file: File;
  /** Relative path including file name, e.g. "docs/2026/report.pdf" or "report.pdf". */
  relativePath: string;
  /** Parent folder relative path, e.g. "docs/2026" or "" for the target root folder. */
  folderPath: string;
}

export interface ExtractedUploadTree {
  files: UploadFileEntry[];
  folderPaths: string[];
}

export interface FileSystemDirectoryReaderLike {
  readEntries(
    successCallback: (entries: FileSystemEntryLike[]) => void,
    errorCallback?: (err: unknown) => void
  ): void;
}

export interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?: (
    successCallback: (file: File) => void,
    errorCallback?: (err: unknown) => void
  ) => void;
  createReader?: () => FileSystemDirectoryReaderLike;
}

function normalizeRelativeSegments(rawPath: string): string[] {
  return rawPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * Reads all entries from a FileSystemDirectoryReader in a loop until an empty array
 * is returned (Chrome returns at most 100 entries per readEntries call).
 */
export async function readAllDirectoryEntries(
  reader: FileSystemDirectoryReaderLike
): Promise<FileSystemEntryLike[]> {
  const allEntries: FileSystemEntryLike[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) {
      break;
    }
    allEntries.push(...batch);
  }
  return allEntries;
}

async function readFileFromEntry(entry: FileSystemEntryLike): Promise<File> {
  if (!entry.file) {
    throw new Error(`FileSystemEntry "${entry.name}" does not support file()`);
  }
  const readFile = entry.file.bind(entry);
  return new Promise<File>((resolve, reject) => {
    readFile(resolve, reject);
  });
}

async function traverseEntry(
  entry: FileSystemEntryLike,
  parentFolderPath: string,
  files: UploadFileEntry[],
  folderPathSet: Set<string>
): Promise<void> {
  if (entry.isFile) {
    const file = await readFileFromEntry(entry);
    const relativePath = parentFolderPath
      ? `${parentFolderPath}/${file.name}`
      : file.name;
    files.push({
      file,
      relativePath,
      folderPath: parentFolderPath,
    });
    return;
  }

  if (entry.isDirectory) {
    const nextFolderPath = parentFolderPath
      ? `${parentFolderPath}/${entry.name}`
      : entry.name;
    folderPathSet.add(nextFolderPath);

    if (!entry.createReader) {
      return;
    }
    const reader = entry.createReader();
    const children = await readAllDirectoryEntries(reader);
    for (const child of children) {
      await traverseEntry(child, nextFolderPath, files, folderPathSet);
    }
  }
}

/**
 * Recursively traverses FileSystemEntry items (from DataTransferItem.webkitGetAsEntry)
 * and extracts files with their folder-relative paths.
 */
export async function extractUploadEntriesFromEntries(
  entries: readonly FileSystemEntryLike[]
): Promise<ExtractedUploadTree> {
  const files: UploadFileEntry[] = [];
  const folderPathSet = new Set<string>();

  for (const entry of entries) {
    await traverseEntry(entry, '', files, folderPathSet);
  }

  return {
    files,
    folderPaths: collectOrderedFolderPaths(Array.from(folderPathSet)),
  };
}

/**
 * Extracts UploadFileEntry items from a FileList or File[] (including `<input webkitdirectory>`).
 */
export function extractUploadEntriesFromFileList(
  fileList: FileList | readonly File[]
): ExtractedUploadTree {
  const files: UploadFileEntry[] = [];
  const folderPathSet = new Set<string>();

  for (const file of Array.from(fileList)) {
    const rawRel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const segments = normalizeRelativeSegments(rawRel);
    if (segments.length >= 2) {
      const folderPath = segments.slice(0, -1).join('/');
      const relativePath = segments.join('/');
      folderPathSet.add(folderPath);
      files.push({
        file,
        relativePath,
        folderPath,
      });
    } else {
      files.push({
        file,
        relativePath: file.name,
        folderPath: '',
      });
    }
  }

  return {
    files,
    folderPaths: collectOrderedFolderPaths(Array.from(folderPathSet)),
  };
}

/**
 * Synchronously captures FileSystemEntry references from DataTransfer.items (before
 * the browser clears DataTransfer after the drop event yields), then traverses them.
 * Falls back to `dataTransfer.files` when `webkitGetAsEntry` is unavailable.
 */
export function extractUploadEntriesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<ExtractedUploadTree> {
  const entries: FileSystemEntryLike[] = [];
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    for (const item of Array.from(dataTransfer.items)) {
      if (item.kind !== 'file') continue;
      const getAsEntry = (
        item as DataTransferItem & {
          webkitGetAsEntry?: () => FileSystemEntryLike | null;
        }
      ).webkitGetAsEntry;
      if (typeof getAsEntry === 'function') {
        const entry = getAsEntry.call(item);
        if (entry) {
          entries.push(entry);
        }
      }
    }
  }

  if (entries.length > 0) {
    return extractUploadEntriesFromEntries(entries);
  }

  return Promise.resolve(extractUploadEntriesFromFileList(dataTransfer.files));
}

/**
 * Expands all ancestor folder prefixes, deduplicates them, and sorts them
 * strictly parent-before-child.
 */
export function collectOrderedFolderPaths(
  folderPaths: readonly string[]
): string[] {
  const unique = new Set<string>();
  for (const rawPath of folderPaths) {
    const segments = normalizeRelativeSegments(rawPath);
    for (let i = 1; i <= segments.length; i += 1) {
      unique.add(segments.slice(0, i).join('/'));
    }
  }

  return Array.from(unique).sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) {
      return depthA - depthB;
    }
    return a.localeCompare(b);
  });
}

export interface EnsureFolderTreeOptions {
  rootFolderId: string;
  folderPaths: readonly string[];
  createFolderFn?: typeof createFolder;
  listFolderChildrenFn?: typeof listFolderChildren;
  knownFolders?: readonly Pick<FolderSummary, 'id' | 'parent_id' | 'name'>[];
}

function findFolderIdInMap(
  childMap: Map<string, string> | undefined,
  folderName: string
): string | undefined {
  if (!childMap) return undefined;
  const exact = childMap.get(folderName);
  if (exact) return exact;
  const lower = folderName.toLowerCase();
  for (const [name, id] of childMap.entries()) {
    if (name.toLowerCase() === lower) {
      return id;
    }
  }
  return undefined;
}

/**
 * Ensures all nested subfolders exist under `rootFolderId` in parent-before-child order.
 * Deduplicates sibling creation by relative path and handles 409 NAME_CONFLICT by
 * fetching and caching existing child folder IDs.
 */
export async function ensureFolderTree(
  options: EnsureFolderTreeOptions
): Promise<Map<string, string>> {
  const {
    rootFolderId,
    folderPaths,
    createFolderFn = createFolder,
    listFolderChildrenFn = listFolderChildren,
    knownFolders = [],
  } = options;

  const folderIdByPath = new Map<string, string>([['', rootFolderId]]);
  const childrenByParentId = new Map<string, Map<string, string>>();
  const fetchedParents = new Set<string>();

  for (const folder of knownFolders) {
    if (!folder.parent_id) continue;
    let childMap = childrenByParentId.get(folder.parent_id);
    if (!childMap) {
      childMap = new Map<string, string>();
      childrenByParentId.set(folder.parent_id, childMap);
    }
    childMap.set(folder.name, folder.id);
  }

  async function loadChildrenForParent(parentId: string): Promise<Map<string, string>> {
    let childMap = childrenByParentId.get(parentId);
    if (!childMap) {
      childMap = new Map<string, string>();
      childrenByParentId.set(parentId, childMap);
    }
    if (fetchedParents.has(parentId)) {
      return childMap;
    }

    let cursor: string | null | undefined = null;
    do {
      const page = await listFolderChildrenFn(parentId, cursor, 200, {
        includeBreadcrumbs: false,
      });
      for (const child of page.folders) {
        childMap.set(child.name, child.id);
      }
      cursor = page.nextCursor;
    } while (cursor);

    fetchedParents.add(parentId);
    return childMap;
  }

  const orderedPaths = collectOrderedFolderPaths(folderPaths);
  for (const relPath of orderedPaths) {
    if (folderIdByPath.has(relPath)) {
      continue;
    }

    const lastSlash = relPath.lastIndexOf('/');
    const parentRelPath = lastSlash === -1 ? '' : relPath.slice(0, lastSlash);
    const folderName = lastSlash === -1 ? relPath : relPath.slice(lastSlash + 1);
    const parentId = folderIdByPath.get(parentRelPath);
    if (!parentId) {
      throw new Error(`Missing parent folder ID for "${relPath}"`);
    }

    const cachedId = findFolderIdInMap(
      childrenByParentId.get(parentId),
      folderName
    );
    if (cachedId) {
      folderIdByPath.set(relPath, cachedId);
      continue;
    }

    try {
      const created = await createFolderFn({
        parentId,
        name: folderName,
      });
      let childMap = childrenByParentId.get(parentId);
      if (!childMap) {
        childMap = new Map<string, string>();
        childrenByParentId.set(parentId, childMap);
      }
      childMap.set(created.folder.name, created.folder.id);
      folderIdByPath.set(relPath, created.folder.id);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        const childMap = await loadChildrenForParent(parentId);
        const existingId = findFolderIdInMap(childMap, folderName);
        if (existingId) {
          folderIdByPath.set(relPath, existingId);
          continue;
        }
      }
      throw err;
    }
  }

  return folderIdByPath;
}
