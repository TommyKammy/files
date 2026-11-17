import type {
  AccessMode,
  AuthUser,
  BreadcrumbItem,
  Capability,
  FileItem,
  FolderSummary,
  OutboxMutationRecord,
  ResourceRole,
  TenantPolicyRow,
} from '@/types/files';

export const SYNC_IDB_PREFIX = 'files_sync_ws_v1:';
const SCOPE_HINT_KEY = 'files_sync_scope_v1';

export const WORKING_SET_MAX_DIRECTORIES = 40;
export const WORKING_SET_MAX_FILES = 3000;
export const WORKING_SET_MAX_FOLDERS = 1500;

export interface SyncScopeHint {
  tenantId: string;
  userId: string;
  email: string;
  displayName: string;
  role: AuthUser['role'];
}

export interface PersistedMetaRecord {
  key: 'state';
  user: AuthUser;
  policy: TenantPolicyRow | null;
  syncSeq: number;
  purgedBeforeSeq: number;
  rootFolderIds: string[];
  rootNextCursor: string | null;
  pinnedFolderIds: string[];
  updatedAt: number;
}

export interface PersistedDirectoryRecord {
  dirKey: string; // '__ROOT__' | folderId
  folderId: string | null;
  effectiveRole: ResourceRole;
  /** Server-provided capabilities for the current folder. */
  capabilities?: Capability[];
  /** `path` forbids listing files and all mutation capabilities. */
  accessMode?: AccessMode | null;
  folderIds: string[];
  fileIds: string[];
  nextCursor: string | null;
  breadcrumbs: BreadcrumbItem[];
  lastAccessedAt: number;
  revalidatedAt: number;
  stale?: boolean;
}

export interface WorkingSetSnapshot {
  meta: PersistedMetaRecord;
  folders: FolderSummary[];
  files: FileItem[];
  directories: PersistedDirectoryRecord[];
}

export interface WorkingSetPruneInput {
  directories: Map<string, PersistedDirectoryRecord>;
  foldersById: Map<string, FolderSummary>;
  filesById: Map<string, FileItem>;
  rootFolderIds: string[];
  pinnedFolderIds: string[];
  /** Pending outbox mutations whose target entities must not be evicted. */
  outboxItems?: OutboxMutationRecord[];
  activeDirKey?: string;
  maxDirectories?: number;
}

export function getSyncDbName(tenantId: string, userId: string): string {
  return `${SYNC_IDB_PREFIX}${tenantId}:${userId}`;
}

export function readSyncScopeHint(): SyncScopeHint | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SCOPE_HINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SyncScopeHint>;
    if (!parsed.tenantId || !parsed.userId || !parsed.email || !parsed.role) {
      return null;
    }
    return {
      tenantId: parsed.tenantId,
      userId: parsed.userId,
      email: parsed.email,
      displayName: parsed.displayName ?? parsed.email,
      role: parsed.role,
    };
  } catch {
    return null;
  }
}

export function writeSyncScopeHint(user: AuthUser | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!user) {
      window.sessionStorage.removeItem(SCOPE_HINT_KEY);
      return;
    }
    const hint: SyncScopeHint = {
      tenantId: user.tenantId,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };
    window.sessionStorage.setItem(SCOPE_HINT_KEY, JSON.stringify(hint));
  } catch {
    // ignore private mode storage quota errors
  }
}

/**
 * Pure LRU eviction for working-set caches: bounds directory count to `maxDirectories`,
 * preserves root/active/pinned folders, and sweeps unreferenced folder/file entities.
 */
export function pruneWorkingSetInMemory(input: WorkingSetPruneInput): {
  evictedDirKeys: string[];
  evictedFolderIds: string[];
  evictedFileIds: string[];
} {
  const maxDirs = Math.max(4, input.maxDirectories ?? WORKING_SET_MAX_DIRECTORIES);
  const pinnedSet = new Set(input.pinnedFolderIds);
  const evictedDirKeys: string[] = [];

  if (input.directories.size > maxDirs) {
    const candidates: PersistedDirectoryRecord[] = [];
    for (const dir of input.directories.values()) {
      if (
        dir.dirKey === '__ROOT__' ||
        dir.dirKey === input.activeDirKey ||
        pinnedSet.has(dir.dirKey)
      ) {
        continue;
      }
      candidates.push(dir);
    }

    candidates.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    const excess = input.directories.size - maxDirs;
    for (let i = 0; i < excess && i < candidates.length; i++) {
      const target = candidates[i];
      input.directories.delete(target.dirKey);
      evictedDirKeys.push(target.dirKey);
    }
  }

  const referencedFolders = new Set<string>([
    ...input.rootFolderIds,
    ...input.pinnedFolderIds,
  ]);
  const referencedFiles = new Set<string>();
  const pendingFolderIds = new Set<string>();

  // Keep folders with pending mutations alive even when their directory is
  // not otherwise referenced (e.g. unpinning from Quick Access while the PATCH
  // is still in flight).
  for (const item of input.outboxItems ?? []) {
    if (item.entityType === 'folder') {
      referencedFolders.add(item.entityId);
      pendingFolderIds.add(item.entityId);
    }
  }

  for (const dir of input.directories.values()) {
    if (dir.folderId) referencedFolders.add(dir.folderId);
    for (const fId of dir.folderIds) referencedFolders.add(fId);
    for (const flId of dir.fileIds) referencedFiles.add(flId);
    for (const crumb of dir.breadcrumbs) referencedFolders.add(crumb.id);
  }

  const evictedFolderIds: string[] = [];
  for (const folderId of input.foldersById.keys()) {
    if (!referencedFolders.has(folderId)) {
      input.foldersById.delete(folderId);
      evictedFolderIds.push(folderId);
    }
  }
  if (input.foldersById.size > WORKING_SET_MAX_FOLDERS) {
    const sorted = Array.from(input.foldersById.values()).sort((a, b) =>
      a.updated_at.localeCompare(b.updated_at)
    );
    const dropCount = input.foldersById.size - WORKING_SET_MAX_FOLDERS;
    for (let i = 0; i < dropCount; i++) {
      const id = sorted[i].id;
      if (
        !pinnedSet.has(id) &&
        id !== input.activeDirKey &&
        !pendingFolderIds.has(id)
      ) {
        input.foldersById.delete(id);
        evictedFolderIds.push(id);
      }
    }
  }

  const evictedFileIds: string[] = [];
  for (const fileId of input.filesById.keys()) {
    if (!referencedFiles.has(fileId)) {
      input.filesById.delete(fileId);
      evictedFileIds.push(fileId);
    }
  }
  if (input.filesById.size > WORKING_SET_MAX_FILES) {
    const activeFiles = new Set(
      input.activeDirKey ? input.directories.get(input.activeDirKey)?.fileIds ?? [] : []
    );
    const sorted = Array.from(input.filesById.values()).sort((a, b) =>
      a.updated_at.localeCompare(b.updated_at)
    );
    const dropCount = input.filesById.size - WORKING_SET_MAX_FILES;
    for (let i = 0; i < dropCount; i++) {
      const id = sorted[i].id;
      if (!activeFiles.has(id)) {
        input.filesById.delete(id);
        evictedFileIds.push(id);
      }
    }
  }

  return { evictedDirKeys, evictedFolderIds, evictedFileIds };
}

export interface SyncPersistenceAdapter {
  loadScope(tenantId: string, userId: string): Promise<WorkingSetSnapshot | null>;
  saveSnapshot(tenantId: string, userId: string, snapshot: WorkingSetSnapshot): Promise<void>;
  loadOutbox?(tenantId: string, userId: string): Promise<OutboxMutationRecord[]>;
  saveOutbox?(tenantId: string, userId: string, items: OutboxMutationRecord[]): Promise<void>;
  purgeScope(tenantId: string, userId: string): Promise<void>;
  purgeAllScopes(exceptDbName?: string): Promise<void>;
}

const STORE_META = 'meta';
const STORE_FOLDERS = 'folders';
const STORE_FILES = 'files';
const STORE_DIRECTORIES = 'directories';
const STORE_OUTBOX = 'outbox';

function openScopeDb(tenantId: string, userId: string): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  const dbName = getSyncDbName(tenantId, userId);

  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(dbName, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
          db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_DIRECTORIES)) {
          db.createObjectStore(STORE_DIRECTORIES, { keyPath: 'dirKey' });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function idbRequestPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteIndexedDbByName(dbName: string): Promise<void> {
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.deleteDatabase(dbName);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

export class IndexedDbSyncPersistence implements SyncPersistenceAdapter {
  private readonly openDbs = new Map<string, IDBDatabase>();

  private async getDb(tenantId: string, userId: string): Promise<IDBDatabase | null> {
    const dbName = getSyncDbName(tenantId, userId);
    const existing = this.openDbs.get(dbName);
    if (existing) return existing;
    const opened = await openScopeDb(tenantId, userId);
    if (opened) {
      opened.onversionchange = () => {
        opened.close();
        this.openDbs.delete(dbName);
      };
      this.openDbs.set(dbName, opened);
    }
    return opened;
  }

  async loadScope(tenantId: string, userId: string): Promise<WorkingSetSnapshot | null> {
    const db = await this.getDb(tenantId, userId);
    if (!db) return null;

    try {
      const tx = db.transaction(
        [STORE_META, STORE_FOLDERS, STORE_FILES, STORE_DIRECTORIES],
        'readonly'
      );
      const [meta, folders, files, directories] = await Promise.all([
        idbRequestPromise(tx.objectStore(STORE_META).get('state') as IDBRequest<PersistedMetaRecord | undefined>),
        idbRequestPromise(tx.objectStore(STORE_FOLDERS).getAll() as IDBRequest<FolderSummary[]>),
        idbRequestPromise(tx.objectStore(STORE_FILES).getAll() as IDBRequest<FileItem[]>),
        idbRequestPromise(
          tx.objectStore(STORE_DIRECTORIES).getAll() as IDBRequest<PersistedDirectoryRecord[]>
        ),
      ]);

      if (!meta || meta.user.tenantId !== tenantId || meta.user.id !== userId) {
        return null;
      }

      return {
        meta,
        folders,
        files,
        directories,
      };
    } catch {
      return null;
    }
  }

  async saveSnapshot(
    tenantId: string,
    userId: string,
    snapshot: WorkingSetSnapshot
  ): Promise<void> {
    const db = await this.getDb(tenantId, userId);
    if (!db) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(
          [STORE_META, STORE_FOLDERS, STORE_FILES, STORE_DIRECTORIES],
          'readwrite'
        );
        const metaStore = tx.objectStore(STORE_META);
        const foldersStore = tx.objectStore(STORE_FOLDERS);
        const filesStore = tx.objectStore(STORE_FILES);
        const dirsStore = tx.objectStore(STORE_DIRECTORIES);

        metaStore.clear();
        metaStore.put(snapshot.meta);

        foldersStore.clear();
        for (const folder of snapshot.folders) {
          foldersStore.put(folder);
        }

        filesStore.clear();
        for (const file of snapshot.files) {
          filesStore.put(file);
        }

        dirsStore.clear();
        for (const dir of snapshot.directories) {
          dirsStore.put(dir);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async loadOutbox(tenantId: string, userId: string): Promise<OutboxMutationRecord[]> {
    const db = await this.getDb(tenantId, userId);
    if (!db || !db.objectStoreNames.contains(STORE_OUTBOX)) return [];

    try {
      const tx = db.transaction([STORE_OUTBOX], 'readonly');
      const rows = await idbRequestPromise(
        tx.objectStore(STORE_OUTBOX).getAll() as IDBRequest<OutboxMutationRecord[]>
      );
      return rows.sort((a, b) => a.createdAt - b.createdAt);
    } catch {
      return [];
    }
  }

  async saveOutbox(
    tenantId: string,
    userId: string,
    items: OutboxMutationRecord[]
  ): Promise<void> {
    const db = await this.getDb(tenantId, userId);
    if (!db || !db.objectStoreNames.contains(STORE_OUTBOX)) return;

    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction([STORE_OUTBOX], 'readwrite');
        const store = tx.objectStore(STORE_OUTBOX);
        store.clear();
        for (const item of items) {
          store.put(item);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async purgeScope(tenantId: string, userId: string): Promise<void> {
    const dbName = getSyncDbName(tenantId, userId);
    const opened = this.openDbs.get(dbName);
    if (opened) {
      opened.close();
      this.openDbs.delete(dbName);
    }
    await deleteIndexedDbByName(dbName);
  }

  async purgeAllScopes(exceptDbName?: string): Promise<void> {
    for (const [dbName, db] of this.openDbs.entries()) {
      if (dbName !== exceptDbName) {
        db.close();
        this.openDbs.delete(dbName);
        await deleteIndexedDbByName(dbName);
      }
    }

    if (
      typeof window !== 'undefined' &&
      typeof window.indexedDB !== 'undefined' &&
      typeof window.indexedDB.databases === 'function'
    ) {
      try {
        const dbs = await window.indexedDB.databases();
        for (const info of dbs) {
          if (
            info.name &&
            info.name.startsWith(SYNC_IDB_PREFIX) &&
            info.name !== exceptDbName
          ) {
            await deleteIndexedDbByName(info.name);
          }
        }
      } catch {
        // ignore IndexedDB enumeration errors in restricted environments
      }
    }
  }
}
