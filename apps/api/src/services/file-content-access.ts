import type { AuthUser, ClassificationLabel } from '../types/api';
import type { OidcEnv } from '../types/oidc';
import { buildAuditLogStmt } from './audit';
import { resolveTargetAccess, type TargetMetadata } from './authorization';
import { can } from './capabilities';
import {
  issueSignedStorageUrl,
  issueSingleUsePreviewUrl,
  resolveSafeDisposition,
} from './storage-url-provider';

export type ContentIntent = 'preview' | 'download';

export function contentIntentFromQuery(raw: string | undefined): ContentIntent {
  return raw === 'download' ? 'download' : 'preview';
}

export interface ContentAccessContext {
  /** Historical version being accessed; omitted for the current version. */
  versionId?: string;
}

export type ContentAccessResult =
  | { ok: true; access: TargetMetadata }
  | { ok: false; status: 403 | 404; body: { error: string } };

/**
 * Resolve the file and enforce the intent-specific RBAC role shared by the
 * current-version and historical-version `content-url` endpoints.
 */
export async function authorizeFileContentAccess(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId' | 'email' | 'ipAddress'>,
  fileId: string,
  intent: ContentIntent,
  ctx: ContentAccessContext = {}
): Promise<ContentAccessResult> {
  const access = await resolveTargetAccess(db, user, 'file', fileId);
  if (!access || access.deletedAt !== null || access.uploadState !== 'active') {
    return { ok: false, status: 404, body: { error: 'File not found' } };
  }

  const requiredCapability = intent === 'download' ? 'item.download' : 'item.preview';
  if (!can(access.capabilities, requiredCapability)) {
    const nowIso = new Date().toISOString();
    await buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'file.content_access_denied',
      targetType: 'file',
      targetId: fileId,
      classificationSnapshot: access.classification,
      status: 'blocked',
      metadata: {
        intent,
        effectiveRole: access.effectiveRole,
        ...(ctx.versionId ? { versionId: ctx.versionId } : {}),
      },
      nowIso,
    }).run();
    return { ok: false, status: 403, body: { error: 'Forbidden' } };
  }

  return { ok: true, access };
}

export interface FileContentDeliveryInput {
  env: OidcEnv;
  user: AuthUser;
  fileId: string;
  intent: ContentIntent;
  /** `null` signs the file's current version; otherwise signs the given historical version. */
  versionId: string | null;
  /** Preview-only roles (no `item.download`) are always watermarked. */
  forceWatermark?: boolean;
  /** When explicitly false, previews use the single-use Worker stream. */
  canDownload?: boolean;
}

export interface FileContentDeliveryBody {
  url: string;
  expiresAt: string;
  disposition: 'inline' | 'attachment';
  requireWatermark: boolean;
  watermarkText: string | null;
  versionId?: string;
  versionNum?: number;
}

export type FileContentDeliveryResult =
  | { ok: true; body: FileContentDeliveryBody }
  | { ok: false; status: 404; body: { error: string } };

interface ContentTargetRow {
  name: string;
  file_mime_type: string;
  classification: ClassificationLabel;
  version_id: string | null;
  version_num: number | null;
  version_mime_type: string | null;
  r2_object_key: string | null;
  require_wm: number;
}

/**
 * Sign a short-lived GET URL for the selected version and append the matching
 * DLP audit entry. Historical versions reuse the file-level classification and
 * tenant watermark policy so preview/download constraints stay identical to
 * `GET /api/files/:id/content-url`.
 */
export async function deliverFileContent(
  input: FileContentDeliveryInput
): Promise<FileContentDeliveryResult> {
  const {
    env,
    user,
    fileId,
    intent,
    versionId,
    forceWatermark = false,
    canDownload = true,
  } = input;

  const row = await env.DB.prepare(
    `SELECT fl.name,
            fl.mime_type AS file_mime_type,
            fl.classification,
            fv.id AS version_id,
            fv.version_num,
            fv.mime_type AS version_mime_type,
            fv.r2_object_key,
            COALESCE(tp.require_watermark_confidential, 1) AS require_wm
       FROM files fl
       LEFT JOIN file_versions fv
         ON fv.tenant_id = fl.tenant_id
        AND fv.id = COALESCE(?, fl.current_version_id)
       LEFT JOIN tenant_policies tp ON tp.tenant_id = fl.tenant_id
      WHERE fl.tenant_id = ? AND fl.id = ?`
  )
    .bind(versionId, user.tenantId, fileId)
    .first<ContentTargetRow>();

  if (!row || !row.version_id || !row.r2_object_key) {
    return { ok: false, status: 404, body: { error: 'File version not found' } };
  }

  const isHistorical = versionId !== null;
  const contentType = isHistorical
    ? row.version_mime_type ?? row.file_mime_type
    : row.file_mime_type;

  const disposition = resolveSafeDisposition(
    intent === 'download' ? 'attachment' : 'inline',
    row.name,
    contentType
  );

  const previewStreamOnly = intent === 'preview' && (forceWatermark || !canDownload);
  const signedGet = previewStreamOnly
    ? await issueSingleUsePreviewUrl(env, env.DB, {
        objectKey: row.r2_object_key,
        tenantId: user.tenantId,
        disposition,
        filename: row.name,
        contentType,
      })
    : await issueSignedStorageUrl(env, {
        method: 'GET',
        objectKey: row.r2_object_key,
        tenantId: user.tenantId,
        expiresInSeconds: 300,
        disposition,
        filename: row.name,
        contentType,
      });

  const requireWatermark =
    forceWatermark ||
    (row.classification === 'confidential' && row.require_wm === 1);
  const nowIso = new Date().toISOString();

  await env.DB.batch([
    buildAuditLogStmt(env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: isHistorical
        ? intent === 'download'
          ? 'file.version.download'
          : 'file.version.preview'
        : intent === 'download'
          ? 'file.download'
          : 'file.preview',
      targetType: 'file',
      targetId: fileId,
      classificationSnapshot: row.classification,
      metadata: isHistorical
        ? {
            fileId,
            versionId: row.version_id,
            versionNum: row.version_num,
            disposition,
            requireWatermark,
            previewStream: previewStreamOnly,
          }
        : { disposition, requireWatermark, previewStream: previewStreamOnly },
      nowIso,
    }),
  ]);

  return {
    ok: true,
    body: {
      url: signedGet.url,
      expiresAt: signedGet.expiresAt,
      disposition,
      requireWatermark,
      watermarkText: requireWatermark ? `${user.email} • ${nowIso}` : null,
      ...(isHistorical
        ? { versionId: row.version_id, versionNum: row.version_num ?? undefined }
        : {}),
    },
  };
}
