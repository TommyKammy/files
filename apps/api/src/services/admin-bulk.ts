import { AdminRootFolderError } from './admin-root-folders';

export const MAX_BULK_ROOT_FOLDERS = 50;

export type AdminBulkItemStatus = 'succeeded' | 'skipped' | 'failed';

export interface AdminBulkItemResult {
  folderId: string;
  folderName: string;
  status: AdminBulkItemStatus;
  code?: string;
  message?: string;
}

export interface AdminBulkSummary {
  requested: number;
  succeeded: number;
  skipped: number;
  failed: number;
  /** In a dry-run this is the number of items that can execute. */
  executable: number;
}

export interface AdminBulkResponse {
  operation: string;
  dryRun: boolean;
  replayed: boolean;
  results: AdminBulkItemResult[];
  summary: AdminBulkSummary;
  syncSeq: number | null;
}

export class AdminBulkOperationError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminBulkOperationError';
  }
}

/**
 * Validate a bulk folder id list, preserving first-seen order and enforcing the
 * documented 50-root ceiling before any idempotency key is consumed.
 */
export function normalizeBulkFolderIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new AdminBulkOperationError(
      400,
      'INVALID_FOLDER_IDS',
      'folderIds must be an array of root folder ids'
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new AdminBulkOperationError(
        400,
        'INVALID_FOLDER_IDS',
        'folderIds must contain non-empty ids'
      );
    }
    const id = raw.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new AdminBulkOperationError(
      400,
      'INVALID_FOLDER_IDS',
      'folderIds must contain at least one id'
    );
  }
  if (ids.length > MAX_BULK_ROOT_FOLDERS) {
    throw new AdminBulkOperationError(
      400,
      'BULK_LIMIT_EXCEEDED',
      `At most ${MAX_BULK_ROOT_FOLDERS} root folders can be processed per request`
    );
  }
  return ids;
}

export function buildAdminBulkSummary(
  results: readonly AdminBulkItemResult[]
): AdminBulkSummary {
  const succeeded = results.filter(
    (result) => result.status === 'succeeded'
  ).length;
  return {
    requested: results.length,
    succeeded,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
    executable: succeeded,
  };
}

export function successResult(
  folderId: string,
  folderName: string,
  message?: string
): AdminBulkItemResult {
  return { folderId, folderName, status: 'succeeded', message };
}

export function skippedResult(
  folderId: string,
  folderName: string,
  code: string,
  message: string
): AdminBulkItemResult {
  return { folderId, folderName, status: 'skipped', code, message };
}

export function failedResult(
  folderId: string,
  folderName: string,
  code: string,
  message: string
): AdminBulkItemResult {
  return { folderId, folderName, status: 'failed', code, message };
}

export function mapRootFolderError(
  folderId: string,
  folderName: string,
  err: unknown
): AdminBulkItemResult {
  if (err instanceof AdminRootFolderError) {
    return failedResult(folderId, folderName, err.code, err.message);
  }
  if (err instanceof AdminBulkOperationError) {
    return failedResult(folderId, folderName, err.code, err.message);
  }
  return failedResult(
    folderId,
    folderName,
    'INTERNAL_ERROR',
    err instanceof Error ? err.message : 'Bulk operation failed'
  );
}
