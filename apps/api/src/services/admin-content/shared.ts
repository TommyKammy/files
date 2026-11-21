import type { FileLockSnapshot } from '../../durable-objects/file-lock-hub';
import type { AuthUser, ClassificationLabel } from '../../types/api';
import { base64UrlToBytes, bytesToBase64Url } from '../crypto-utils';

export const ADMIN_CONTENT_MAX_LIMIT = 100;
export const ADMIN_CONTENT_DEFAULT_LIMIT = 25;
export const ADMIN_CONTENT_REASON_MIN = 3;
export const ADMIN_CONTENT_REASON_MAX = 300;

export type AdminContentTargetType = 'file' | 'folder';
export type AdminContentSearchTargetType = 'all' | AdminContentTargetType;
export type AdminContentInspectPolicy =
  | 'disabled'
  | 'deny_confidential'
  | 'watermark_confidential';

export const ADMIN_CONTENT_INSPECT_POLICIES: ReadonlySet<AdminContentInspectPolicy> =
  new Set(['disabled', 'deny_confidential', 'watermark_confidential']);

export const DEFAULT_ADMIN_CONTENT_INSPECT_POLICY: AdminContentInspectPolicy =
  'watermark_confidential';

export class AdminContentError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 503,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminContentError';
  }
}

export interface AdminContentCursor {
  updatedAt: string;
  id: string;
}

export interface AdminContentOwner {
  id: string;
  email: string | null;
  displayName: string | null;
}

export function encodeAdminContentCursor(cursor: AdminContentCursor): string {
  return bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(cursor))
  );
}

export function decodeAdminContentCursor(
  raw: string | undefined
): AdminContentCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(raw))
    ) as Partial<AdminContentCursor>;
    if (
      typeof parsed.updatedAt !== 'string' ||
      !parsed.updatedAt ||
      typeof parsed.id !== 'string' ||
      !parsed.id
    ) {
      return null;
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

export function validateAdminContentReason(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new AdminContentError(
      400,
      'INSPECT_REASON_REQUIRED',
      'reason is required (3-300 characters)'
    );
  }
  const reason = raw.trim();
  if (
    reason.length < ADMIN_CONTENT_REASON_MIN ||
    reason.length > ADMIN_CONTENT_REASON_MAX
  ) {
    throw new AdminContentError(
      400,
      'INVALID_INSPECT_REASON',
      `reason must be ${ADMIN_CONTENT_REASON_MIN}-${ADMIN_CONTENT_REASON_MAX} characters`
    );
  }
  return reason;
}

export function isAdminContentInspectPolicy(
  value: unknown
): value is AdminContentInspectPolicy {
  return (
    typeof value === 'string' &&
    ADMIN_CONTENT_INSPECT_POLICIES.has(value as AdminContentInspectPolicy)
  );
}

export async function getAdminContentInspectPolicy(
  db: D1Database,
  tenantId: string
): Promise<AdminContentInspectPolicy> {
  const row = await db
    .prepare(
      'SELECT admin_content_inspect_policy FROM tenant_policies WHERE tenant_id = ?'
    )
    .bind(tenantId)
    .first<{ admin_content_inspect_policy: string | null }>();
  return isAdminContentInspectPolicy(row?.admin_content_inspect_policy)
    ? row.admin_content_inspect_policy
    : DEFAULT_ADMIN_CONTENT_INSPECT_POLICY;
}

/** Escape LIKE metacharacters for a literal, safe prefix search. */
export function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export type { AuthUser, ClassificationLabel, FileLockSnapshot };
