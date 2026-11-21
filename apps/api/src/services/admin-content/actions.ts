import type { FileLockSnapshot } from '../../durable-objects/file-lock-hub';
import type { AuthUser, ClassificationLabel } from '../../types/api';
import type { OidcEnv } from '../../types/oidc';
import { buildActiveFileLockDeleteStmt } from '../active-file-lock-index';
import { buildAuditLogStmt } from '../audit';
import { deliverFileContent } from '../file-content-access';
import { getFileLockState } from '../file-lock';
import { buildSyncChangeStmt } from '../sync-changes';
import { notifyTenantSyncHub } from '../sync-notifier';
import {
  AdminContentError,
  getAdminContentInspectPolicy,
  type AdminContentInspectPolicy,
} from './shared';

interface FileTargetRow {
  id: string;
  folder_id: string | null;
  name: string;
  classification: ClassificationLabel;
  current_version_id: string | null;
  current_version_num: number;
}

async function loadActiveFileTarget(
  db: D1Database,
  tenantId: string,
  fileId: string
): Promise<FileTargetRow | null> {
  return db
    .prepare(
      `SELECT id, folder_id, name, classification,
              current_version_id, current_version_num
         FROM files
        WHERE tenant_id = ? AND id = ?
          AND deleted_at IS NULL AND upload_state = 'active'`
    )
    .bind(tenantId, fileId)
    .first<FileTargetRow>();
}

export interface AdminContentForceUnlockResult {
  ok: true;
  fileId: string;
  released: boolean;
  lock: FileLockSnapshot | null;
  revokedWopiSessionCount: number;
  syncSeq: number | null;
}

export async function forceUnlockAdminContentFile(
  env: OidcEnv,
  actor: AuthUser,
  fileId: string,
  reason: string
): Promise<AdminContentForceUnlockResult> {
  const file = await loadActiveFileTarget(env.DB, actor.tenantId, fileId);
  if (!file) {
    throw new AdminContentError(404, 'FILE_NOT_FOUND', 'File not found');
  }

  const liveLock = await getFileLockState(env, fileId);
  if (!liveLock || liveLock.tenantId !== actor.tenantId) {
    await buildActiveFileLockDeleteStmt(
      env.DB,
      fileId,
      actor.tenantId
    ).run();
    throw new AdminContentError(
      409,
      'FILE_LOCK_NOT_FOUND',
      'No active lock is held for this file'
    );
  }
  if (!env.FILE_LOCK_HUB) {
    throw new AdminContentError(
      503,
      'LOCK_SERVICE_UNAVAILABLE',
      'Lock service unavailable'
    );
  }

  const stub = env.FILE_LOCK_HUB.get(env.FILE_LOCK_HUB.idFromName(fileId));
  const forced = await stub.forceUnlock({
    fileId,
    tenantId: actor.tenantId,
  });
  if (!forced.released) {
    throw new AdminContentError(
      409,
      'FILE_LOCK_NOT_FOUND',
      'No active lock is held for this file'
    );
  }

  const nowIso = new Date().toISOString();
  const releasedLock = forced.lock ?? liveLock;
  const batchResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE wopi_sessions
          SET is_active = 0, revoked_at = ?
        WHERE tenant_id = ? AND file_id = ? AND is_active = 1`
    ).bind(nowIso, actor.tenantId, fileId),
    buildActiveFileLockDeleteStmt(env.DB, fileId, actor.tenantId),
    buildAuditLogStmt(env.DB, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorIp: actor.ipAddress,
      action: 'admin.content.force_unlock',
      targetType: 'file',
      targetId: fileId,
      classificationSnapshot: file.classification,
      metadata: {
        reason,
        lockId: releasedLock.lockId,
        mode: releasedLock.mode,
        ownerId: releasedLock.ownerId,
        ownerEmail: releasedLock.ownerEmail,
      },
      nowIso,
    }),
    buildSyncChangeStmt(env.DB, {
      tenantId: actor.tenantId,
      entityType: 'file',
      entityId: fileId,
      folderId: file.folder_id,
      action: 'admin.content.force_unlock',
      payload: {
        fileId,
        lockId: releasedLock.lockId,
        mode: releasedLock.mode,
        ownerId: releasedLock.ownerId,
        reason,
        forcedBy: actor.id,
        releasedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  const revokedWopiSessionCount = Number(batchResults[0]?.meta?.changes ?? 0);
  const syncSeq =
    typeof batchResults[3]?.meta?.last_row_id === 'number'
      ? Number(batchResults[3].meta.last_row_id)
      : null;

  await notifyTenantSyncHub(env, {
    tenantId: actor.tenantId,
    eventKind: 'admin.content.force_unlock',
    seq: syncSeq,
    scopeFolderIds: [file.folder_id],
    metadata: {
      fileId,
      reason,
      lockId: releasedLock.lockId,
      mode: releasedLock.mode,
      revokedWopiSessionCount,
    },
  });

  return {
    ok: true,
    fileId,
    released: true,
    lock: releasedLock,
    revokedWopiSessionCount,
    syncSeq,
  };
}

export interface AdminContentInspectResult {
  ok: true;
  fileId: string;
  fileName: string;
  classification: ClassificationLabel;
  policyApplied: AdminContentInspectPolicy;
  watermarkRequired: boolean;
  url: string;
  expiresAt: string;
  disposition: 'inline' | 'attachment';
  watermarkText: string | null;
  versionId?: string;
  versionNum?: number;
}

async function recordInspectAudit(
  db: D1Database,
  actor: AuthUser,
  file: FileTargetRow,
  reason: string,
  policyApplied: AdminContentInspectPolicy,
  status: 'allowed' | 'blocked',
  watermarkRequired: boolean,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await buildAuditLogStmt(db, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    actorIp: actor.ipAddress,
    action: 'admin.content.inspect',
    targetType: 'file',
    targetId: file.id,
    classificationSnapshot: file.classification,
    status,
    metadata: {
      reason,
      policyApplied,
      watermarkRequired,
      ...extra,
    },
    nowIso: new Date().toISOString(),
  }).run();
}

export async function inspectAdminContentFile(
  env: OidcEnv,
  actor: AuthUser,
  fileId: string,
  reason: string
): Promise<AdminContentInspectResult> {
  const file = await loadActiveFileTarget(env.DB, actor.tenantId, fileId);
  if (!file) {
    throw new AdminContentError(404, 'FILE_NOT_FOUND', 'File not found');
  }

  const policyApplied = await getAdminContentInspectPolicy(
    env.DB,
    actor.tenantId
  );

  if (policyApplied === 'disabled') {
    await recordInspectAudit(
      env.DB,
      actor,
      file,
      reason,
      policyApplied,
      'blocked',
      false,
      { blockedReason: 'ADMIN_INSPECT_DISABLED' }
    );
    throw new AdminContentError(
      403,
      'ADMIN_INSPECT_DISABLED',
      '管理者コンテンツ検査はテナントポリシーにより無効化されています'
    );
  }

  if (
    policyApplied === 'deny_confidential' &&
    file.classification === 'confidential'
  ) {
    await recordInspectAudit(
      env.DB,
      actor,
      file,
      reason,
      policyApplied,
      'blocked',
      false,
      { blockedReason: 'CONFIDENTIAL_INSPECT_DISABLED' }
    );
    throw new AdminContentError(
      403,
      'CONFIDENTIAL_INSPECT_DISABLED',
      '機密区分のファイルは管理者検査ポリシーによりブロックされました'
    );
  }

  const watermarkRequired = file.classification === 'confidential';
  const delivered = await deliverFileContent({
    env,
    user: actor,
    fileId,
    intent: 'preview',
    versionId: null,
    forceWatermark: watermarkRequired,
    canDownload: false,
  });
  if (!delivered.ok) {
    throw new AdminContentError(
      delivered.status,
      'FILE_CONTENT_NOT_FOUND',
      delivered.body.error
    );
  }

  await recordInspectAudit(
    env.DB,
    actor,
    file,
    reason,
    policyApplied,
    'allowed',
    delivered.body.requireWatermark
  );

  return {
    ok: true,
    fileId,
    fileName: file.name,
    classification: file.classification,
    policyApplied,
    watermarkRequired: delivered.body.requireWatermark,
    url: delivered.body.url,
    expiresAt: delivered.body.expiresAt,
    disposition: delivered.body.disposition,
    watermarkText: delivered.body.watermarkText,
    ...(delivered.body.versionId
      ? {
          versionId: delivered.body.versionId,
          versionNum: delivered.body.versionNum,
        }
      : {}),
  };
}
