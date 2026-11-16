import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import { bytesToBase64Url, base64UrlToBytes } from '../../services/crypto-utils';
import {
  createFolderWithClosures,
  fetchFolderBreadcrumbsRows,
  FolderServiceError,
  type FolderRow,
  getFolderBreadcrumbs,
  moveFolderSubtree,
  restoreFolderSubtree,
  softDeleteFolderSubtree,
  validateFolderName,
} from '../../services/folder-closure-service';
import { buildSyncChangeStmt, parseExpectedVersionInput } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { ClassificationLabel } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import { VALID_CLASSIFICATIONS } from '../../utils/classification';

export interface ChildrenCursor {
  phase: 'folders' | 'files';
  name?: string;
  id?: string;
}

export interface ChildFileRow {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string;
  size_bytes: number;
  current_version_num: number;
  meta_version: number;
  classification: ClassificationLabel;
  ai_suggested_label: ClassificationLabel | null;
  ai_confidence: number | null;
  ai_reason: string | null;
  updated_at: string;
}

export const FOLDER_CHILD_COLS =
  'id, tenant_id, parent_id, name, depth, version, classification, is_pinned, created_by, deleted_at, created_at, updated_at';
export const FILE_CHILD_COLS =
  'id, folder_id, name, extension, mime_type, size_bytes, current_version_num, meta_version, classification, ai_suggested_label, ai_confidence, ai_reason, updated_at';

export function encodeCursor(cursor: ChildrenCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeCursor(raw: string | undefined): ChildrenCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(raw))) as ChildrenCursor;
    if (parsed.phase !== 'folders' && parsed.phase !== 'files') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 50;
  return Math.min(parsed, 100);
}

export function handleFolderError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response },
  err: unknown
): Response {
  if (err instanceof FolderServiceError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.latest ? { latest: err.latest } : {}),
      },
      err.status
    );
  }
  throw err;
}
