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
import {
  loadActiveFileRequest,
} from './public-shared';
export function registerPublicFileRequestMetaRoute(routes: Hono<OidcHonoEnv>) {
  /** GET /api/fr/:token — strict blind metadata (never exposes folderId or existing files) */
  routes.get('/:token', async (c) => {
    const loaded = await loadActiveFileRequest(c.env.DB, c.req.param('token'));
    if (!loaded.ok) {
      return c.json({ error: loaded.error, code: loaded.code }, loaded.status);
    }
    const fr = loaded.fileRequest;
    const runtimeEnv = c.env as FileRequestRuntimeEnv;

    return c.json({
      title: fr.title,
      description: fr.description,
      requireSubmitterEmail: fr.require_submitter_email === 1,
      maxFileSizeBytes: fr.max_file_size_bytes,
      allowedExtensions: parseAllowedExtensionsJson(fr.allowed_extensions),
      expiresAt: fr.expires_at,
      turnstileEnabled: Boolean(runtimeEnv.TURNSTILE_SECRET_KEY),
    });
  });


}
