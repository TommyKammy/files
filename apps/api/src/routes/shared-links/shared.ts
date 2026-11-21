import type {
  AuthUser,
  ClassificationLabel,
  ShareAccessScope,
} from '../../types/api';
import { resolvePermissionLevel } from '../../services/shared-link-permissions';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const CONFIDENTIAL_MAX_EXPIRY_DAYS = 7;
export const DEFAULT_MAX_EXPIRY_DAYS = 30;
export const MAX_PASSWORD_FAILURES = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
export const PREVIEW_URL_TTL_SECONDS = 300;
export const VALID_SCOPES = new Set<ShareAccessScope>([
  'public',
  'company_only',
  'collaborators_only',
]);

export interface SharedLinkRow {
  id: string;
  tenant_id: string;
  token_hash: string;
  token_ciphertext?: string | null;
  target_type: 'file' | 'folder';
  target_id: string;
  access_scope: ShareAccessScope;
  can_download: number;
  permission_level: import('../../services/shared-link-permissions').SharePermissionLevel;
  require_watermark: number;
  password_hash: string | null;
  failed_password_attempts: number;
  locked_until: string | null;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  created_by: string;
  revoked_at: string | null;
  revoked_by: string | null;
  created_at: string;
}

export interface TenantPolicyRow {
  enforce_company_only_links: number;
  require_watermark_confidential: number;
  max_link_expiration_days: number;
  allow_shared_link_edit: number;
  allow_public_edit_links: number;
  allow_viewer_share_links: number;
}

export interface ShareTargetFileRow {
  id: string;
  tenant_id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number;
  upload_state: string;
  classification: ClassificationLabel;
  deleted_at: string | null;
  r2_object_key: string | null;
}

export interface ShareTargetFolderRow {
  id: string;
  tenant_id: string;
  name: string;
  classification: ClassificationLabel;
  deleted_at: string | null;
}

export function getClientIp(req: { header: (name: string) => string | undefined }, user: AuthUser | null): string {
  return (
    user?.ipAddress ??
    req.header('CF-Connecting-IP') ??
    req.header('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export function formatLinkSummary(row: SharedLinkRow, shareUrl: string | null = null) {
  const nowMs = Date.now();
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    accessScope: row.access_scope,
    permissionLevel: resolvePermissionLevel(row),
    canDownload: row.can_download === 1,
    requireWatermark: row.require_watermark === 1,
    hasPassword: Boolean(row.password_hash),
    isLocked: Boolean(row.locked_until && Date.parse(row.locked_until) > nowMs),
    lockedUntil: row.locked_until,
    expiresAt: row.expires_at,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
    shareUrl,
  };
}

export function parseExpirationIso(
  expiresAtRaw: unknown,
  expiresInDaysRaw: unknown,
  maxDays: number,
  forceDeadline: boolean
): { ok: true; expiresAt: string | null } | { ok: false; error: string } {
  const nowMs = Date.now();
  const maxMs = nowMs + maxDays * DAY_MS;

  let requestedMs: number | null = null;
  if (typeof expiresAtRaw === 'string' && expiresAtRaw.trim()) {
    const parsed = Date.parse(expiresAtRaw.trim());
    if (Number.isNaN(parsed)) {
      return { ok: false, error: 'Invalid expiresAt ISO timestamp' };
    }
    requestedMs = parsed;
  } else if (typeof expiresInDaysRaw === 'number' && Number.isFinite(expiresInDaysRaw)) {
    if (expiresInDaysRaw <= 0) {
      return { ok: false, error: 'expiresInDays must be positive' };
    }
    requestedMs = nowMs + expiresInDaysRaw * DAY_MS;
  }

  if (requestedMs !== null) {
    if (requestedMs <= nowMs) {
      return { ok: false, error: 'Expiration timestamp must be in the future' };
    }
    return {
      ok: true,
      expiresAt: new Date(Math.min(requestedMs, maxMs)).toISOString(),
    };
  }

  return {
    ok: true,
    expiresAt: forceDeadline ? new Date(maxMs).toISOString() : null,
  };
}

export async function hasConfidentialAncestor(
  db: D1Database,
  tenantId: string,
  folderId: string | null
): Promise<boolean> {
  if (!folderId) return false;
  const hit = await db
    .prepare(
      `SELECT 1 FROM folder_closures fc
       JOIN folders f ON f.id = fc.ancestor_id
       WHERE fc.tenant_id = ? AND fc.descendant_id = ? AND f.classification = 'confidential' AND f.deleted_at IS NULL
       LIMIT 1`
    )
    .bind(tenantId, folderId)
    .first();
  return Boolean(hit);
}

/** Authenticated shared-link management API (`/api/shared-links`) */
