import {
  type FileVersionContentGrant,
  type FileVersionRestoreResponse,
  getFileVersionContentUrl,
  getFileViewerInfo,
  listFileVersions,
  restoreFileVersion,
} from '@/lib/files-api';
import type {
  FileItem,
  FileVersionItem,
  FileVersionListResponse,
} from '@/types/files';
import {
  describeVersionRequestError,
  describeVersionRestoreError,
  mapApiFileRecordToFileItem,
  mergeVersionPages,
  resolveCurrentVersionNum,
  VERSION_HISTORY_PAGE_SIZE,
  type VersionHistoryError,
} from '@/lib/version-history';

export interface FileVersionHistoryApi {
  list(
    fileId: string,
    options: { limit: number; cursor: string | null }
  ): Promise<FileVersionListResponse>;
  contentUrl(
    fileId: string,
    versionId: string,
    intent: 'preview' | 'download'
  ): Promise<FileVersionContentGrant>;
  restore(
    fileId: string,
    versionId: string,
    expectedVersion: number | undefined
  ): Promise<FileVersionRestoreResponse>;
  fileInfo(fileId: string): Promise<{
    file: unknown;
    effectiveRole?: string;
    canDownload?: boolean;
  }>;
}

const defaultApi: FileVersionHistoryApi = {
  list: (fileId, options) =>
    listFileVersions(fileId, {
      limit: options.limit,
      cursor: options.cursor,
    }),
  contentUrl: (fileId, versionId, intent) =>
    getFileVersionContentUrl(fileId, versionId, intent),
  restore: (fileId, versionId, expectedVersion) =>
    restoreFileVersion(fileId, versionId, expectedVersion),
  fileInfo: (fileId) => getFileViewerInfo(fileId),
};

export interface VersionHistoryPreviewState {
  version: FileVersionItem;
  grant: FileVersionContentGrant;
}

export interface VersionHistoryControllerState {
  versions: FileVersionItem[];
  currentVersionNum: number;
  metaVersion: number;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  error: VersionHistoryError | null;
  restoreError: VersionHistoryError | null;
  restoringVersionId: string | null;
  preparingVersionId: string | null;
  downloadingVersionId: string | null;
  preview: VersionHistoryPreviewState | null;
}

export interface VersionHistoryRestoreSuccess {
  file: FileItem | null;
  version: FileVersionItem | null;
  restoredFromVersionNum: number;
}

export type VersionRestoreOutcome =
  | {
      ok: true;
      file: FileItem | null;
      version: FileVersionItem | null;
      restoredFromVersionNum: number;
    }
  | { ok: false; error: VersionHistoryError };

export interface VersionHistoryControllerOptions {
  fileId: string;
  initialCurrentVersionNum: number;
  initialMetaVersion: number;
  pageSize?: number;
  api?: Partial<FileVersionHistoryApi>;
  openUrl?: (url: string) => void;
  onFileUpdated?: (file: FileItem) => void;
  onRestored?: (result: VersionHistoryRestoreSuccess) => void;
}

function defaultOpenUrl(url: string): void {
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Framework-free controller for the version-history modal. Keeping network,
 * pagination, restore and re-sync logic here makes the 409/409-lock branches
 * directly testable without a DOM, while `useVersionHistory` only binds it to
 * React's external store contract.
 */
export class VersionHistoryController {
  private readonly fileId: string;
  private readonly pageSize: number;
  private readonly api: FileVersionHistoryApi;
  private readonly openUrl: (url: string) => void;
  private readonly onFileUpdated?: (file: FileItem) => void;
  private readonly onRestored?: (result: VersionHistoryRestoreSuccess) => void;

  private listeners = new Set<() => void>();
  private generation = 0;
  private state: VersionHistoryControllerState;

  constructor(options: VersionHistoryControllerOptions) {
    this.fileId = options.fileId;
    this.pageSize = Math.max(
      1,
      Math.floor(options.pageSize ?? VERSION_HISTORY_PAGE_SIZE)
    );
    this.api = { ...defaultApi, ...options.api };
    this.openUrl = options.openUrl ?? defaultOpenUrl;
    this.onFileUpdated = options.onFileUpdated;
    this.onRestored = options.onRestored;
    this.state = {
      versions: [],
      currentVersionNum: options.initialCurrentVersionNum,
      metaVersion: options.initialMetaVersion,
      loading: true,
      loadingMore: false,
      hasMore: false,
      nextCursor: null,
      error: null,
      restoreError: null,
      restoringVersionId: null,
      preparingVersionId: null,
      downloadingVersionId: null,
      preview: null,
    };
  }

  getState = (): VersionHistoryControllerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<VersionHistoryControllerState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private applyPage(
    page: FileVersionListResponse,
    append: boolean
  ): void {
    const versions = append
      ? mergeVersionPages(this.state.versions, page.versions)
      : mergeVersionPages([], page.versions);
    this.setState({
      versions,
      currentVersionNum: resolveCurrentVersionNum(
        versions,
        this.state.currentVersionNum
      ),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      loading: false,
      loadingMore: false,
    });
  }

  async loadInitial(): Promise<void> {
    const generation = ++this.generation;
    this.setState({ loading: true, error: null });
    try {
      const page = await this.api.list(this.fileId, {
        limit: this.pageSize,
        cursor: null,
      });
      if (generation !== this.generation) return;
      this.applyPage(page, false);
    } catch (err) {
      if (generation !== this.generation) return;
      this.setState({
        loading: false,
        error: describeVersionRequestError(err, 'list'),
      });
    }
  }

  async loadMore(): Promise<void> {
    const { hasMore, nextCursor, loadingMore, loading } = this.state;
    if (!hasMore || !nextCursor || loadingMore || loading) return;
    const generation = this.generation;
    this.setState({ loadingMore: true, error: null });
    try {
      const page = await this.api.list(this.fileId, {
        limit: this.pageSize,
        cursor: nextCursor,
      });
      if (generation !== this.generation) return;
      this.applyPage(page, true);
    } catch (err) {
      if (generation !== this.generation) return;
      this.setState({
        loadingMore: false,
        error: describeVersionRequestError(err, 'list'),
      });
    }
  }

  async reload(options: { quiet?: boolean } = {}): Promise<void> {
    const generation = ++this.generation;
    if (!options.quiet) this.setState({ loading: true, error: null });
    try {
      const page = await this.api.list(this.fileId, {
        limit: this.pageSize,
        cursor: null,
      });
      if (generation !== this.generation) return;
      this.applyPage(page, false);
    } catch (err) {
      if (generation !== this.generation) return;
      this.setState({
        loading: false,
        error: describeVersionRequestError(err, 'list'),
      });
      throw err;
    }
  }

  async preparePreview(
    version: FileVersionItem
  ): Promise<VersionHistoryPreviewState | null> {
    if (version.uploadStatus !== 'completed') return null;
    if (this.state.preparingVersionId) return null;
    this.setState({ preparingVersionId: version.id, error: null });
    try {
      const grant = await this.api.contentUrl(
        this.fileId,
        version.id,
        'preview'
      );
      const preview = { version, grant };
      this.setState({ preparingVersionId: null, preview });
      return preview;
    } catch (err) {
      this.setState({
        preparingVersionId: null,
        error: describeVersionRequestError(err, 'preview'),
      });
      return null;
    }
  }

  closePreview(): void {
    this.setState({ preview: null });
  }

  async download(version: FileVersionItem): Promise<void> {
    if (version.uploadStatus !== 'completed') return;
    this.setState({ downloadingVersionId: version.id, error: null });
    try {
      const grant = await this.api.contentUrl(
        this.fileId,
        version.id,
        'download'
      );
      this.openUrl(grant.url);
    } catch (err) {
      const error = describeVersionRequestError(err, 'download');
      this.setState({ error });
      throw new Error(error.message);
    } finally {
      this.setState({ downloadingVersionId: null });
    }
  }

  /**
   * Restore is append-only. The API response is authoritative; after it
   * succeeds the list is re-fetched instead of being optimistically rewritten.
   */
  async restore(version: FileVersionItem): Promise<VersionRestoreOutcome> {
    if (this.state.restoringVersionId) {
      return {
        ok: false,
        error: {
          code: null,
          message: '別の復元操作を処理中です。完了後に再度お試しください。',
          lock: null,
        },
      };
    }

    this.setState({
      restoringVersionId: version.id,
      restoreError: null,
      error: null,
    });

    try {
      const response = await this.api.restore(
        this.fileId,
        version.id,
        this.state.metaVersion
      );
      const file = mapApiFileRecordToFileItem(response.file);

      if (file) {
        this.setState({
          metaVersion: file.meta_version ?? this.state.metaVersion + 1,
          currentVersionNum:
            file.current_version_num ?? this.state.currentVersionNum,
        });
        this.onFileUpdated?.(file);
      }

      let enrichedRestored: FileVersionItem | null = null;
      if (response.version) {
        const restoredVersion = response.version;
        enrichedRestored = {
          ...restoredVersion,
          comment:
            restoredVersion.comment ??
            `v${response.restoredFromVersionNum} から復元`,
          restoredFromVersionId:
            restoredVersion.restoredFromVersionId ?? version.id,
          restoredFromVersionNum:
            restoredVersion.restoredFromVersionNum ??
            response.restoredFromVersionNum,
        };
        // `GET /versions` does not persist the synthetic restore comment, so
        // keep the API restore row's note and re-apply it after the re-fetch.
        this.setState({
          versions: mergeVersionPages(this.state.versions, [
            enrichedRestored,
          ]),
        });
      }

      // The mutation may still be settling in edge replicas; always re-read.
      try {
        await this.reload({ quiet: true });
      } catch {
        // Keep the successful restore result; the banner shows the list error.
      }

      if (enrichedRestored) {
        this.setState({
          versions: mergeVersionPages(this.state.versions, [
            enrichedRestored,
          ]),
        });
      }

      const restoredVersion = response.version
        ? this.state.versions.find(
            (candidate) => candidate.id === response.version!.id
          ) ?? response.version
        : this.state.versions.find(
            (candidate) =>
              candidate.versionNum ===
              (file?.current_version_num ?? this.state.currentVersionNum)
          ) ?? null;

      this.setState({ restoringVersionId: null });

      if (file) {
        this.onRestored?.({
          file,
          version: restoredVersion,
          restoredFromVersionNum: response.restoredFromVersionNum,
        });
      }

      return {
        ok: true,
        file,
        version: restoredVersion,
        restoredFromVersionNum: response.restoredFromVersionNum,
      };
    } catch (err) {
      const error = describeVersionRestoreError(err);
      this.setState({
        restoringVersionId: null,
        restoreError: error,
      });
      await this.resyncLatest();
      return { ok: false, error };
    }
  }

  /**
   * After a 409/lock failure, refresh both the optimistic meta_version and the
   * history so the next attempt uses the server's current state.
   */
  private async resyncLatest(): Promise<void> {
    try {
      const info = await this.api.fileInfo(this.fileId);
      const file = mapApiFileRecordToFileItem(info.file);
      if (file) {
        this.setState({
          metaVersion: file.meta_version ?? this.state.metaVersion,
          currentVersionNum:
            file.current_version_num ?? this.state.currentVersionNum,
        });
        this.onFileUpdated?.(file);
      }
    } catch {
      // A lock/conflict response must not be masked by a secondary fetch error.
    }
    try {
      await this.reload({ quiet: true });
    } catch {
      // Keep the restore-specific error banner as the primary message.
    }
  }

  clearRestoreError(): void {
    this.setState({ restoreError: null });
  }

  /** Cancel in-flight requests when React StrictMode remounts the effect. */
  cancel(): void {
    this.generation += 1;
  }
}
