import { buildAuditLogStmt } from '../../../services/audit';
import { encryptCookiePayload } from '../../../services/crypto-utils';
import { buildR2ObjectKey } from '../../../services/file-upload-common';
import { getShareUnlockSecret } from '../../../services/shared-link-security';
import { issueSignedStorageUrl } from '../../../services/storage-url-provider';
import type { OidcEnv } from '../../../types/oidc';
import {
  FileRequestRow,
  SUBMISSION_TOKEN_TTL_MS,
  SubmissionGrantPayload,
  resolveFolderRequestClassification,
} from '../shared';
import type { UploadInitValidation } from './upload-init-validation';

export async function createPendingPublicUpload({
  env,
  fileRequest,
  input,
  clientIp,
  nowIso,
}: {
  env: OidcEnv;
  fileRequest: FileRequestRow;
  input: UploadInitValidation;
  clientIp: string;
  nowIso: string;
}) {
  const classification = await resolveFolderRequestClassification(
    env.DB,
    fileRequest.tenant_id,
    fileRequest.folder_id
  );

  const fileId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const r2ObjectKey = buildR2ObjectKey(fileRequest.tenant_id, fileId, 1);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO files (
         id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
         upload_state, current_version_id, current_version_num, classification,
         created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, ?, ?)`
    ).bind(
      fileId,
      fileRequest.tenant_id,
      fileRequest.folder_id,
      input.storedName,
      input.extension,
      input.mimeType,
      input.sizeBytes,
      versionId,
      classification,
      fileRequest.created_by,
      fileRequest.created_by,
      nowIso,
      nowIso
    ),
    env.DB.prepare(
      `INSERT INTO file_versions (
         id, tenant_id, file_id, version_num, r2_object_key,
         size_bytes, mime_type, upload_status, uploaded_by, created_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, 'pending', ?, ?)`
    ).bind(
      versionId,
      fileRequest.tenant_id,
      fileId,
      r2ObjectKey,
      input.sizeBytes,
      input.mimeType,
      fileRequest.created_by,
      nowIso
    ),
    buildAuditLogStmt(env.DB, {
      tenantId: fileRequest.tenant_id,
      actorId: null,
      actorEmail: input.submitterEmail ?? 'external-submitter',
      actorIp: clientIp,
      action: 'file_request.upload_init',
      targetType: 'file',
      targetId: fileId,
      classificationSnapshot: classification,
      status: 'allowed',
      metadata: {
        fileRequestId: fileRequest.id,
        fileName: input.storedName,
        sizeBytes: input.sizeBytes,
      },
      nowIso,
    }),
  ]);

  const signedPut = await issueSignedStorageUrl(env, {
    method: 'PUT',
    objectKey: r2ObjectKey,
    tenantId: fileRequest.tenant_id,
    expiresInSeconds: 900,
    maxSizeBytes: input.sizeBytes,
    contentType: input.mimeType,
  });

  const grantSecret = getShareUnlockSecret(env);
  const submissionToken = await encryptCookiePayload(grantSecret, {
    requestId: fileRequest.id,
    fileId,
    versionId,
    submitterEmail: input.submitterEmail,
    exp: Date.now() + SUBMISSION_TOKEN_TTL_MS,
  } satisfies SubmissionGrantPayload);

  return { fileId, versionId, signedPut, submissionToken };
}
