import { Hono, type Context } from 'hono';
import { buildAuditLogStmt } from '../../../services/audit';
import {
  assertFileNotLocked,
  FileLockedError,
} from '../../../services/file-lock';
import {
  FileUploadError,
  finalizeUploadedVersion,
  SINGLE_UPLOAD_MAX_BYTES,
} from '../../../services/file-upload-common';
import {
  getShareLinkPolicyFlags,
  resolvePermissionLevel,
} from '../../../services/shared-link-permissions';
import {
  initializeSharedLinkPendingUpload,
  isFileConfidential,
  resolveSharedLinkTargetInfo,
} from '../../../services/shared-link-upload';
import { issueSignedStorageUrl } from '../../../services/storage-url-provider';
import { buildSyncChangeStmt } from '../../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../../services/sync-notifier';
import type { AuthUser, ClassificationLabel } from '../../../types/api';
import type { OidcHonoEnv } from '../../../types/oidc';
import type { SharedLinkRow } from '../shared';
import { getClientIp } from '../shared';
import { loadAndAuthorizeShareLink, verifyShareLinkUnlock } from './public-shared';

interface EditAuthorizationFailure {
  ok: false;
  status: 401 | 403;
  body: { error: string; code: string };
}

async function authorizeSharedLinkEdit(
  c: Context<OidcHonoEnv>,
  link: SharedLinkRow,
  user: AuthUser | null
): Promise<{ ok: true } | EditAuthorizationFailure> {
  const policy = await getShareLinkPolicyFlags(c.env.DB, link.tenant_id);
  if (resolvePermissionLevel(link) !== 'edit' || policy.allow_shared_link_edit !== 1) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'This shared link does not allow editing',
        code: 'SHARED_LINK_EDIT_DISABLED',
      },
    };
  }
  if (
    !user &&
    !(link.access_scope === 'public' && policy.allow_public_edit_links === 1)
  ) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'Sign in to edit through this shared link',
        code: 'AUTH_REQUIRED_FOR_EDIT',
      },
    };
  }
  return { ok: true };
}

function sharedLinkActor(
  link: { tenant_id: string; created_by: string },
  user: AuthUser | null,
  req: { header: (name: string) => string | undefined }
): AuthUser {
  if (user) return user;
  return {
    id: link.created_by,
    tenantId: link.tenant_id,
    email: `shared-link+${link.created_by}@anonymous.invalid`,
    displayName: 'Shared link collaborator',
    role: 'member',
    ipAddress: getClientIp(req, null),
    userType: 'member',
  };
}

function handleShareUploadError(
  c: { json: (body: unknown, status: 400 | 403 | 404 | 409 | 413) => Response },
  err: unknown
): Response {
  if (err instanceof FileLockedError) {
    return c.json({ error: 'File is locked', code: err.code, lock: err.lock }, 409);
  }
  if (err instanceof FileUploadError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

export function registerPublicShareUploadRoutes(routes: Hono<OidcHonoEnv>) {
  routes.post('/:token/upload-init', async (c) => {
    const user = c.get('user');
    const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
    if (!auth.ok) {
      return c.json({ error: auth.error, code: auth.code }, auth.status);
    }
    const { link, tokenHash } = auth;

    const body = (await c.req.json().catch(() => null)) as {
      fileName?: unknown;
      mimeType?: unknown;
      sizeBytes?: unknown;
      fileId?: unknown;
      conflictPolicy?: unknown;
      unlockToken?: unknown;
    } | null;
    if (!body || typeof body.sizeBytes !== 'number') {
      return c.json({ error: 'fileName and numeric sizeBytes are required' }, 400);
    }
    if (typeof body.fileName !== 'string' || !body.fileName.trim()) {
      return c.json({ error: 'fileName is required' }, 400);
    }
    if (body.sizeBytes >= SINGLE_UPLOAD_MAX_BYTES) {
      return c.json(
        {
          error: 'Shared-link uploads must be smaller than 100 MiB',
          code: 'USE_MULTIPART_UPLOAD',
        },
        400
      );
    }

    const unlocked = await verifyShareLinkUnlock(c, link, tokenHash, body.unlockToken);
    if (!unlocked.ok) {
      return c.json(unlocked.body, unlocked.status);
    }
    const authorized = await authorizeSharedLinkEdit(c, link, user);
    if (!authorized.ok) {
      return c.json(authorized.body, authorized.status);
    }

    const target = await resolveSharedLinkTargetInfo(
      c.env.DB,
      link.tenant_id,
      link.target_type,
      link.target_id
    );
    if (!target) {
      return c.json({ error: 'Shared target is no longer available' }, 404);
    }
    if (target.isConfidential) {
      return c.json(
        {
          error: 'Shared-link editing is forbidden for confidential content',
          code: 'CONFIDENTIAL_EDIT_LINK_FORBIDDEN',
        },
        403
      );
    }

    const requestedFileId =
      typeof body.fileId === 'string' && body.fileId.trim()
        ? body.fileId.trim()
        : null;
    const conflictPolicy =
      body.conflictPolicy === 'fail' ? 'fail' : 'new_version';

    try {
      let existingFileId =
        link.target_type === 'file'
          ? link.target_id
          : requestedFileId
            ? requestedFileId
            : null;
      if (link.target_type === 'folder' && !existingFileId) {
        const sameName = await c.env.DB.prepare(
          `SELECT id FROM files
            WHERE tenant_id = ? AND folder_id = ? AND name = ?
              AND deleted_at IS NULL AND upload_state = 'active'
            LIMIT 1`
        )
          .bind(link.tenant_id, link.target_id, body.fileName.trim())
          .first<{ id: string }>();
        existingFileId = sameName?.id ?? null;
      }
      if (existingFileId) {
        const existingFile = await c.env.DB.prepare(
          'SELECT classification, folder_id FROM files WHERE tenant_id = ? AND id = ?'
        )
          .bind(link.tenant_id, existingFileId)
          .first<{ classification: string; folder_id: string | null }>();
        if (
          existingFile &&
          (await isFileConfidential(
            c.env.DB,
            link.tenant_id,
            existingFile.classification as ClassificationLabel,
            existingFile.folder_id
          ))
        ) {
          return c.json(
            {
              error: 'Shared-link editing is forbidden for confidential content',
              code: 'CONFIDENTIAL_EDIT_LINK_FORBIDDEN',
            },
            403
          );
        }
        await assertFileNotLocked(c.env, existingFileId);
      }

      const actor = sharedLinkActor(link, user, c.req);
      const initialized = await initializeSharedLinkPendingUpload(c.env.DB, {
        tenantId: link.tenant_id,
        actorUserId: actor.id,
        targetType: link.target_type,
        targetId: link.target_id,
        requestedFileId,
        fileName: body.fileName,
        mimeType:
          typeof body.mimeType === 'string' && body.mimeType.trim()
            ? body.mimeType.trim()
            : 'application/octet-stream',
        sizeBytes: body.sizeBytes,
        conflictPolicy,
        target,
      });

      const contentType =
        typeof body.mimeType === 'string' && body.mimeType.trim()
          ? body.mimeType.trim()
          : 'application/octet-stream';
      const signedPut = await issueSignedStorageUrl(c.env, {
        method: 'PUT',
        objectKey: initialized.r2ObjectKey,
        tenantId: link.tenant_id,
        expiresInSeconds: 900,
        maxSizeBytes: Math.max(body.sizeBytes, 1),
        contentType,
      });

      return c.json(
        {
          fileId: initialized.fileId,
          versionId: initialized.versionId,
          versionNum: initialized.versionNum,
          fileName: initialized.fileName,
          classification: initialized.classification,
          isNewVersion: initialized.isNewVersion,
          permissionLevel: 'edit',
          uploadUrl: signedPut.url,
          method: signedPut.method,
          expiresAt: signedPut.expiresAt,
          requiredHeaders: signedPut.requiredHeaders,
        },
        201
      );
    } catch (err) {
      return handleShareUploadError(c, err);
    }
  });

  routes.post('/:token/upload-complete', async (c) => {
    const user = c.get('user');
    const auth = await loadAndAuthorizeShareLink(c.env.DB, c.req.param('token'), user);
    if (!auth.ok) {
      return c.json({ error: auth.error, code: auth.code }, auth.status);
    }
    const { link, tokenHash } = auth;

    const body = (await c.req.json().catch(() => null)) as {
      fileId?: unknown;
      versionId?: unknown;
      unlockToken?: unknown;
    } | null;
    if (
      !body ||
      typeof body.fileId !== 'string' ||
      typeof body.versionId !== 'string'
    ) {
      return c.json({ error: 'fileId and versionId are required' }, 400);
    }

    const unlocked = await verifyShareLinkUnlock(c, link, tokenHash, body.unlockToken);
    if (!unlocked.ok) {
      return c.json(unlocked.body, unlocked.status);
    }
    const authorized = await authorizeSharedLinkEdit(c, link, user);
    if (!authorized.ok) {
      return c.json(authorized.body, authorized.status);
    }

    const actor = sharedLinkActor(link, user, c.req);
    const version = await c.env.DB.prepare(
      `SELECT fv.id AS version_id, fv.file_id, fv.version_num, fv.upload_status,
              fv.uploaded_by, f.id AS file_row_id, f.folder_id, f.name,
              f.classification, f.upload_state, f.deleted_at
         FROM file_versions fv
         JOIN files f ON f.tenant_id = fv.tenant_id AND f.id = fv.file_id
        WHERE fv.tenant_id = ? AND fv.id = ? AND fv.file_id = ?`
    )
      .bind(link.tenant_id, body.versionId, body.fileId)
      .first<{
        version_id: string;
        file_id: string;
        version_num: number;
        upload_status: string;
        uploaded_by: string;
        folder_id: string | null;
        name: string;
        classification: string;
        upload_state: string;
        deleted_at: string | null;
      }>();

    if (
      !version ||
      version.deleted_at !== null ||
      (link.target_type === 'file'
        ? version.file_id !== link.target_id
        : version.folder_id !== link.target_id)
    ) {
      return c.json({ error: 'Shared upload target not found' }, 404);
    }
    if (version.upload_status !== 'pending') {
      return c.json(
        { error: 'Upload is not in a pending state', code: 'INVALID_UPLOAD_STATE' },
        409
      );
    }
    if (version.uploaded_by !== actor.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const target = await resolveSharedLinkTargetInfo(
      c.env.DB,
      link.tenant_id,
      link.target_type,
      link.target_id
    );
    const fileConfidential = await isFileConfidential(
      c.env.DB,
      link.tenant_id,
      version.classification as ClassificationLabel,
      version.folder_id
    );
    if (!target || target.isConfidential || fileConfidential) {
      return c.json(
        {
          error: 'Shared-link editing is forbidden for confidential content',
          code: 'CONFIDENTIAL_EDIT_LINK_FORBIDDEN',
        },
        target ? 403 : 404
      );
    }

    try {
      await assertFileNotLocked(c.env, version.file_id);
      const finalized = await finalizeUploadedVersion(
        c.env.DB,
        c.env.BUCKET,
        c.env.JOBS_QUEUE,
        actor,
        {
          fileId: version.file_id,
          versionId: version.version_id,
          maxAllowedBytes: SINGLE_UPLOAD_MAX_BYTES,
        }
      );

      const nowIso = new Date().toISOString();
      const action =
        version.version_num > 1
          ? 'shared_link.version_upload'
          : 'shared_link.file_upload';
      const clientIp = getClientIp(c.req, user);
      const batchResults = await c.env.DB.batch([
        buildAuditLogStmt(c.env.DB, {
          tenantId: link.tenant_id,
          actorId: user?.id ?? null,
          actorEmail: user?.email ?? null,
          actorIp: clientIp,
          action,
          targetType: 'file',
          targetId: version.file_id,
          classificationSnapshot: finalized.file.classification,
          status: 'allowed',
          metadata: {
            linkId: link.id,
            permissionLevel: 'edit',
            versionNum: version.version_num,
          },
          nowIso,
        }),
        buildSyncChangeStmt(c.env.DB, {
          tenantId: link.tenant_id,
          entityType: 'file',
          entityId: version.file_id,
          folderId: finalized.file.folder_id,
          action,
          payload: {
            fileId: version.file_id,
            linkId: link.id,
            permissionLevel: 'edit',
            versionNum: version.version_num,
            updatedAt: nowIso,
          },
          nowIso,
        }),
      ]);

      await emitTenantSyncSignal(c, {
        tenantId: link.tenant_id,
        seq: extractLastSyncSeq(batchResults),
        eventKind: action,
        scopeFolderIds: [finalized.file.folder_id],
        metadata: { linkId: link.id, permissionLevel: 'edit' },
      });

      return c.json(
        {
          ok: true,
          permissionLevel: 'edit',
          file: finalized.file,
          version: {
            id: version.version_id,
            versionNum: version.version_num,
          },
        },
        200
      );
    } catch (err) {
      return handleShareUploadError(c, err);
    }
  });
}
