import { ApiClientError } from '@/lib/files-api/core';
import {
  formatAuditDateTime,
  formatBytes,
  hasRoleAtLeast,
} from '@/lib/formatters';
import type {
  ClassificationLabel,
  FileItem,
  FileLockInfo,
  FileVersionItem,
  FileVersionUploadStatus,
  ResourceRole,
} from '@/types/files';

/** Matches the API default; the modal asks for the same page size. */
export const VERSION_HISTORY_PAGE_SIZE = 20;

export interface VersionHistoryError {
  code: string | null;
  message: string;
  lock: FileLockInfo | null;
}

/**
 * Mobile-first layout tokens for version rows: metadata and action buttons
 * stack below `sm`, then become a single horizontal row on tablet/desktop.
 */
export const VERSION_ROW_RESPONSIVE_CLASS =
  'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between';
export const VERSION_ACTIONS_RESPONSIVE_CLASS =
  'flex w-full flex-col gap-1.5 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center sm:justify-end';

export interface VersionUploadStatusMeta {
  label: string;
  tone: 'complete' | 'pending' | 'failed';
  className: string;
}

export const VERSION_UPLOAD_STATUS_META: Record<
  FileVersionUploadStatus,
  VersionUploadStatusMeta
> = {
  completed: {
    label: '完了',
    tone: 'complete',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  pending: {
    label: 'アップロード中',
    tone: 'pending',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  },
  failed: {
    label: '失敗',
    tone: 'failed',
    className: 'border-red-200 bg-red-50 text-red-700',
  },
};

export function versionUploadStatusMeta(
  status: FileVersionUploadStatus
): VersionUploadStatusMeta {
  return VERSION_UPLOAD_STATUS_META[status];
}

export function formatVersionNumber(versionNum: number): string {
  return `v${versionNum}`;
}

export function versionAuthorLabel(
  version: Pick<FileVersionItem, 'uploadedByName' | 'uploadedBy'>
): string {
  const name = version.uploadedByName?.trim();
  if (name) return name;
  const id = version.uploadedBy?.trim();
  return id ? `ユーザー ${id.slice(0, 8)}` : '不明なユーザー';
}

export function formatVersionCreatedAt(iso: string): string {
  // Audit-style formatter is the existing app-wide JST display convention.
  return formatAuditDateTime(iso);
}

/** Turn the API's English restore marker into the modal's Japanese note. */
export function formatVersionComment(
  comment: string | null | undefined,
  restoredFromVersionNum?: number | null
): string | null {
  const trimmed = comment?.trim();
  if (trimmed) {
    const restored = /^Restored from v(\d+)$/i.exec(trimmed);
    if (restored) return `v${restored[1]} から復元`;
    return trimmed;
  }
  if (restoredFromVersionNum && restoredFromVersionNum > 0) {
    return `v${restoredFromVersionNum} から復元`;
  }
  return null;
}

/** Newest first, matching the API's `version_num DESC, id DESC` ordering. */
export function sortVersionsNewestFirst(
  versions: readonly FileVersionItem[]
): FileVersionItem[] {
  return [...versions].sort((a, b) => {
    if (a.versionNum !== b.versionNum) return b.versionNum - a.versionNum;
    return b.id.localeCompare(a.id);
  });
}

/** Merge a paginated page without duplicating rows across overlapping cursors. */
export function mergeVersionPages(
  existing: readonly FileVersionItem[],
  incoming: readonly FileVersionItem[]
): FileVersionItem[] {
  const byId = new Map<string, FileVersionItem>();
  for (const version of existing) byId.set(version.id, version);
  for (const version of incoming) byId.set(version.id, version);
  return sortVersionsNewestFirst([...byId.values()]);
}

export function resolveCurrentVersionNum(
  versions: readonly FileVersionItem[],
  fallbackCurrentVersionNum: number
): number {
  // Trust the API's isCurrent flag: a newer pending upload may exist above the
  // current completed version and must not receive the 現在版 badge.
  const flagged = versions
    .filter((version) => version.isCurrent)
    .reduce<FileVersionItem | null>(
      (newest, version) =>
        !newest || version.versionNum > newest.versionNum ? version : newest,
      null
    );
  if (flagged) return flagged.versionNum;
  if (fallbackCurrentVersionNum > 0) return fallbackCurrentVersionNum;
  return versions.reduce(
    (max, version) => Math.max(max, version.versionNum),
    0
  );
}

/** Mirrors the API: `max(current_version_num, max(version_num)) + 1`. */
export function nextVersionNumber(
  versions: readonly FileVersionItem[],
  currentVersionNum: number
): number {
  const highest = versions.reduce(
    (max, version) => Math.max(max, version.versionNum),
    0
  );
  return Math.max(currentVersionNum, highest) + 1;
}

export function isVersionPreviewable(
  version: Pick<FileVersionItem, 'uploadStatus'>
): boolean {
  return version.uploadStatus === 'completed';
}

export function canDownloadVersion(
  version: Pick<FileVersionItem, 'uploadStatus'>,
  effectiveRole: ResourceRole
): boolean {
  return (
    isVersionPreviewable(version) &&
    hasRoleAtLeast(effectiveRole, 'viewer')
  );
}

export function canRestoreVersion(
  version: Pick<FileVersionItem, 'uploadStatus' | 'isCurrent'>,
  effectiveRole: ResourceRole
): boolean {
  return (
    isVersionPreviewable(version) &&
    !version.isCurrent &&
    hasRoleAtLeast(effectiveRole, 'editor')
  );
}

export interface VersionHistoryRowView {
  version: FileVersionItem;
  versionLabel: string;
  isCurrent: boolean;
  sizeLabel: string;
  authorLabel: string;
  createdAtLabel: string;
  status: VersionUploadStatusMeta;
  comment: string | null;
  canPreview: boolean;
  canDownload: boolean;
  canRestore: boolean;
}

/**
 * Project API rows into the modal's display model. `isCurrent` is derived from
 * the resolved current version number so only one badge is ever rendered.
 */
export function buildVersionHistoryView(
  versions: readonly FileVersionItem[],
  options: {
    currentVersionNum: number;
    effectiveRole: ResourceRole;
    canDownload: boolean;
  }
): VersionHistoryRowView[] {
  const currentVersionNum = resolveCurrentVersionNum(
    versions,
    options.currentVersionNum
  );
  return sortVersionsNewestFirst(versions).map((version) => {
    const isCurrent = version.versionNum === currentVersionNum;
    const comment = formatVersionComment(
      version.comment,
      version.restoredFromVersionNum
    );
    return {
      version,
      versionLabel: formatVersionNumber(version.versionNum),
      isCurrent,
      sizeLabel: formatBytes(version.sizeBytes),
      authorLabel: versionAuthorLabel(version),
      createdAtLabel: formatVersionCreatedAt(version.createdAt),
      status: versionUploadStatusMeta(version.uploadStatus),
      comment,
      canPreview: isVersionPreviewable(version),
      canDownload:
        options.canDownload &&
        canDownloadVersion(version, options.effectiveRole),
      canRestore: canRestoreVersion(
        { ...version, isCurrent },
        options.effectiveRole
      ),
    };
  });
}

const VALID_CLASSIFICATIONS = new Set<ClassificationLabel>([
  'confidential',
  'internal',
  'public',
  'unset',
]);

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Restore / file-detail endpoints return the API's snake_case file row while
 * the client cache uses `FileItem`. This mapper is deliberately tolerant of
 * both spellings so callers can feed either a restore payload or a fixture.
 */
export function mapApiFileRecordToFileItem(raw: unknown): FileItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = asString(row.id);
  const name = asString(row.name);
  if (!id || !name) return null;

  const classification = VALID_CLASSIFICATIONS.has(
    row.classification as ClassificationLabel
  )
    ? (row.classification as ClassificationLabel)
    : 'unset';
  const uploadState = row.upload_state ?? row.uploadState;

  return {
    id,
    folder_id:
      typeof row.folder_id === 'string'
        ? row.folder_id
        : typeof row.folderId === 'string'
          ? row.folderId
          : null,
    name,
    extension:
      typeof row.extension === 'string' ? row.extension : null,
    mime_type:
      typeof row.mime_type === 'string'
        ? row.mime_type
        : typeof row.mimeType === 'string'
          ? row.mimeType
          : null,
    size_bytes:
      asNumber(row.size_bytes ?? row.sizeBytes) ?? 0,
    current_version_num:
      asNumber(row.current_version_num ?? row.currentVersionNum) ?? 1,
    meta_version: asNumber(row.meta_version ?? row.metaVersion) ?? 1,
    classification,
    ai_suggested_label: VALID_CLASSIFICATIONS.has(
      row.ai_suggested_label as ClassificationLabel
    )
      ? (row.ai_suggested_label as ClassificationLabel)
      : null,
    ai_confidence: asNumber(row.ai_confidence),
    ai_reason: asString(row.ai_reason),
    updated_at:
      asString(row.updated_at) ??
      asString(row.updatedAt) ??
      new Date(0).toISOString(),
    deleted_at: asString(row.deleted_at),
    upload_state:
      uploadState === 'pending' || uploadState === 'failed'
        ? uploadState
        : 'active',
    optimistic: false,
  };
}

const LOCK_MODES = new Set(['wopi_collab', 'desktop_exclusive']);

export function parseFileLock(value: unknown): FileLockInfo | null {
  if (!value || typeof value !== 'object') return null;
  const lock = value as Record<string, unknown>;
  if (
    typeof lock.fileId !== 'string' ||
    typeof lock.ownerName !== 'string' ||
    typeof lock.mode !== 'string' ||
    !LOCK_MODES.has(lock.mode)
  ) {
    return null;
  }
  return {
    fileId: lock.fileId,
    tenantId: typeof lock.tenantId === 'string' ? lock.tenantId : '',
    mode: lock.mode as FileLockInfo['mode'],
    lockId: typeof lock.lockId === 'string' ? lock.lockId : '',
    ownerId: typeof lock.ownerId === 'string' ? lock.ownerId : '',
    ownerName: lock.ownerName,
    ownerEmail:
      typeof lock.ownerEmail === 'string' ? lock.ownerEmail : null,
    sessionId:
      typeof lock.sessionId === 'string' ? lock.sessionId : null,
    acquiredAt: asNumber(lock.acquiredAt) ?? 0,
    expiresAt: asNumber(lock.expiresAt) ?? 0,
    updatedAt: asNumber(lock.updatedAt) ?? 0,
  };
}

export function formatFileLockMode(mode: FileLockInfo['mode']): string {
  return mode === 'desktop_exclusive'
    ? 'Files Drive 排他ロック'
    : 'Web 同時編集ロック';
}

export function toVersionHistoryError(
  error: unknown,
  fallbackMessage: string
): VersionHistoryError {
  if (error instanceof ApiClientError) {
    return {
      code: error.code ?? null,
      message: error.message || fallbackMessage,
      lock: parseFileLock(error.details?.lock),
    };
  }
  return {
    code: null,
    message:
      error instanceof Error ? error.message || fallbackMessage : fallbackMessage,
    lock: null,
  };
}

function lockNotice(lock: FileLockInfo | null): string {
  if (!lock) return '';
  const email = lock.ownerEmail ? ` (${lock.ownerEmail})` : '';
  return ` ロック保有者: ${lock.ownerName}${email} / ${formatFileLockMode(lock.mode)}`;
}

/** Japanese, action-specific restore failures including 409 variants. */
export function describeVersionRestoreError(
  error: unknown
): VersionHistoryError {
  const base = toVersionHistoryError(error, 'バージョンの復元に失敗しました');
  let message = base.message;
  switch (base.code) {
    case 'FILE_LOCKED':
      message = `ファイルが編集中のため復元できませんでした。${lockNotice(base.lock)}。編集の完了後に再度お試しください。`;
      break;
    case 'VERSION_CONFLICT':
      message =
        'ファイルが別の操作で更新されました。最新の状態を再読み込みしました。内容を確認して再度お試しください。';
      break;
    case 'VERSION_ALREADY_CURRENT':
      message =
        'このバージョンは既に現在版です。最新の版履歴を再読み込みしました。';
      break;
    case 'VERSION_CONTENT_NOT_FOUND':
      message =
        '復元元のファイル内容がストレージに見つかりません。管理者に連絡してください。';
      break;
    case 'VERSION_NOT_COMPLETED':
      message =
        'アップロードが完了していないバージョンは復元できません。';
      break;
    default:
      if (base.code === null) {
        const status = error instanceof ApiClientError ? error.status : null;
        if (status === 403) {
          message =
            'このファイルを復元する権限がありません (Editor 以上が必要です)。';
        } else if (status === 404) {
          message = 'ファイルまたはバージョンが見つかりませんでした。';
        }
      }
      break;
  }
  return { ...base, message };
}

export function describeVersionRequestError(
  error: unknown,
  context: 'list' | 'preview' | 'download'
): VersionHistoryError {
  const base = toVersionHistoryError(
    error,
    context === 'list'
      ? '版履歴の取得に失敗しました'
      : context === 'preview'
        ? '過去版のプレビューを準備できませんでした'
        : '過去版のダウンロードを準備できませんでした'
  );
  if (error instanceof ApiClientError && error.status === 403) {
    if (context === 'download') {
      return {
        ...base,
        message:
          'Previewer 権限のためダウンロードできません (DLP 保護)。プレビューのみ利用できます。',
      };
    }
    if (context === 'preview') {
      return {
        ...base,
        message: 'このバージョンをプレビューする権限がありません (DLP)。',
      };
    }
    return {
      ...base,
      message: 'このファイルの版履歴を表示する権限がありません。',
    };
  }
  return base;
}
