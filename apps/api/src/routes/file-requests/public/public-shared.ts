import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../../middleware/session-auth';
import { buildAuditLogStmt } from '../../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../../services/authorization';
import {
  decryptCookiePayload,
  encryptCookiePayload,
  generateRandomToken,
  sha256Hex,
  timingSafeEqual,
} from '../../../services/crypto-utils';
import {
  buildR2ObjectKey,
  FileUploadError,
  finalizeUploadedVersion,
  getTenantQuotaStatus,
  validateFileNameAndExt,
} from '../../../services/file-upload-common';
import { getShareUnlockSecret } from '../../../services/shared-link-security';
import { issueSignedStorageUrl } from '../../../services/storage-url-provider';
import { emitTenantSyncSignal } from '../../../services/sync-notifier';
import type { AuthUser, ClassificationLabel } from '../../../types/api';
import type { OidcEnv, OidcHonoEnv } from '../../../types/oidc';
import {
  DANGEROUS_EXTENSIONS,
  DEFAULT_RATE_LIMIT_PER_MIN,
  FileRequestRow,
  FileRequestRuntimeEnv,
  SUBMISSION_TOKEN_TTL_MS,
  SubmissionGrantPayload,
  appendTimestampSuffix,
  getClientIp,
  parseAllowedExtensionsJson,
  resolveFolderRequestClassification,
  verifyTurnstileToken,
} from '../shared';
export async function loadActiveFileRequest(
  db: D1Database,
  rawToken: string
): Promise<
  | { ok: true; fileRequest: FileRequestRow }
  | { ok: false; status: 404 | 410; error: string; code: string }
> {
  if (!rawToken || rawToken.length < 16) {
    return { ok: false, status: 404, error: 'File request not found', code: 'REQUEST_NOT_FOUND' };
  }
  const tokenHash = await sha256Hex(rawToken);
  const reqRow = await db
    .prepare('SELECT * FROM file_requests WHERE token_hash = ?')
    .bind(tokenHash)
    .first<FileRequestRow>();

  if (!reqRow) {
    return { ok: false, status: 404, error: 'File request not found', code: 'REQUEST_NOT_FOUND' };
  }
  if (reqRow.is_active !== 1) {
    return { ok: false, status: 410, error: 'File request is closed', code: 'REQUEST_CLOSED' };
  }
  if (reqRow.expires_at && Date.parse(reqRow.expires_at) <= Date.now()) {
    return { ok: false, status: 410, error: 'File request has expired', code: 'REQUEST_EXPIRED' };
  }

  const folder = await db
    .prepare('SELECT deleted_at FROM folders WHERE tenant_id = ? AND id = ?')
    .bind(reqRow.tenant_id, reqRow.folder_id)
    .first<{ deleted_at: string | null }>();
  if (!folder || folder.deleted_at !== null) {
    return { ok: false, status: 410, error: 'File request is no longer available', code: 'TARGET_UNAVAILABLE' };
  }

  return { ok: true, fileRequest: reqRow };
}

