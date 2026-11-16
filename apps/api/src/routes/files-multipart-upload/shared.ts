import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import {
  type FileRow,
  type FileVersionRow,
  FileUploadError,
  finalizeUploadedVersion,
  initializePendingUpload,
} from '../../services/file-upload-common';
import {
  abortMultipartUpload,
  type CompletedPartInput,
  completeMultipartUpload,
  computeMultipartPlan,
  INITIAL_SIGNED_PARTS_LIMIT,
  initiateMultipartUpload,
  MAX_MULTIPART_PARTS,
  PART_URLS_BATCH_MAX,
} from '../../services/multipart-storage-provider';
import { issueSignedMultipartPartUrl } from '../../services/storage-url-provider';
import { emitTenantSyncSignal } from '../../services/sync-notifier';
import type { ClassificationLabel } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';
import { VALID_CLASSIFICATIONS } from '../../utils/classification';

export const MIN_MULTIPART_INIT_BYTES = 5 * 1024 * 1024; // R2/S3 5 MiB minimum non-final part size

export function handleMultipartError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409 | 413) => Response },
  err: unknown
): Response {
  if (err instanceof FileUploadError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}
