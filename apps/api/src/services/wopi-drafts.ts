import { buildAuditLogStmt } from './audit';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';
import { buildUserStorageDeltaStmt } from './user-storage-stats';
import { buildRootFolderDeltaByFolderStmts } from './root-folder-stats';
import { chunkArray, executeBatchChunks } from '../utils/batch';
import { selectUnreferencedR2Keys } from './r2-gc';
import type { FileRow, FileVersionRow } from './file-upload-common';
import type { WopiSessionRow } from './wopi-token';
import type { OidcEnv } from '../types/oidc';

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const DRAFT_PURGE_BATCH = 100;

export interface WopiDraftRow {
  id: string;
  session_id: string;
  tenant_id: string;
  file_id: string;
  r2_object_key: string;
  size_bytes: number;
  mime_type: string;
  last_saved_by: string;
  is_active: number;
  promoted_at: string | null;
  promoted_version_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export async function getActiveWopiDraft(
  db: D1Database,
  tenantId: string,
  fileId: string
): Promise<WopiDraftRow | null> {
  return db
    .prepare(
      `SELECT * FROM wopi_drafts
        WHERE tenant_id = ? AND file_id = ? AND is_active = 1
          AND promoted_at IS NULL AND expires_at > ?
        ORDER BY updated_at DESC
        LIMIT 1`
    )
    .bind(tenantId, fileId, new Date().toISOString())
    .first<WopiDraftRow>();
}

export async function saveWopiDraft({
  env,
  session,
  content,
  mimeType,
  nowMs = Date.now(),
}: {
  env: Pick<OidcEnv, 'DB' | 'BUCKET'>;
  session: WopiSessionRow;
  content: ArrayBuffer;
  mimeType: string;
  nowMs?: number;
}): Promise<{ draft: WopiDraftRow; previousObjectKey: string | null }> {
  if (!session.can_write) {
    throw new Error('WOPI session is read-only');
  }
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + DRAFT_TTL_MS).toISOString();
  const draftId = crypto.randomUUID();
  const objectKey = `tenants/${session.tenant_id}/drafts/${session.file_id}/${session.id}/${crypto.randomUUID()}`;

  const previous = await env.DB.prepare(
    `SELECT * FROM wopi_drafts
      WHERE tenant_id = ? AND file_id = ? AND session_id = ? AND is_active = 1
        AND promoted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1`
  )
    .bind(session.tenant_id, session.file_id, session.id)
    .first<WopiDraftRow>();

  const mime = mimeType.trim() || 'application/octet-stream';
  await env.BUCKET.put(objectKey, content, {
    httpMetadata: { contentType: mime },
  });

  const statements: D1PreparedStatement[] = [];
  if (previous) {
    statements.push(
      env.DB.prepare(
        `UPDATE wopi_drafts SET is_active = 0, updated_at = ? WHERE id = ?`
      ).bind(nowIso, previous.id)
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO wopi_drafts (
         id, session_id, tenant_id, file_id, r2_object_key, size_bytes,
         mime_type, last_saved_by, is_active, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    ).bind(
      draftId,
      session.id,
      session.tenant_id,
      session.file_id,
      objectKey,
      content.byteLength,
      mime,
      session.user_id,
      expiresAt,
      nowIso,
      nowIso
    )
  );

  try {
    await env.DB.batch(statements);
  } catch (err) {
    await env.BUCKET.delete(objectKey).catch(() => undefined);
    throw err;
  }

  const draft: WopiDraftRow = {
    id: draftId,
    session_id: session.id,
    tenant_id: session.tenant_id,
    file_id: session.file_id,
    r2_object_key: objectKey,
    size_bytes: content.byteLength,
    mime_type: mime,
    last_saved_by: session.user_id,
    is_active: 1,
    promoted_at: null,
    promoted_version_id: null,
    expires_at: expiresAt,
    created_at: nowIso,
    updated_at: nowIso,
  };

  return {
    draft,
    previousObjectKey: previous?.r2_object_key ?? null,
  };
}

export async function finalizeWopiDraft({
  env,
  session,
  actor,
  nowMs = Date.now(),
}: {
  env: Pick<OidcEnv, 'DB'>;
  session: WopiSessionRow;
  actor: { id: string; email: string; ipAddress: string };
  nowMs?: number;
}): Promise<{
  file: FileRow;
  version: FileVersionRow;
  draft: WopiDraftRow;
  syncSeq: number | null;
} | null> {
  const draft = await env.DB.prepare(
    `SELECT * FROM wopi_drafts
      WHERE tenant_id = ? AND file_id = ? AND session_id = ? AND is_active = 1
        AND promoted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT 1`
  )
    .bind(session.tenant_id, session.file_id, session.id)
    .first<WopiDraftRow>();
  if (!draft) return null;

  const file = await env.DB.prepare(
    `SELECT * FROM files
      WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
  )
    .bind(session.tenant_id, session.file_id)
    .first<FileRow>();
  if (!file) return null;

  const nowIso = new Date(nowMs).toISOString();
  const versionId = crypto.randomUUID();
  const versionNum = file.current_version_num + 1;
  const wasActive = file.upload_state === 'active';
  const netDeltaBytes = wasActive
    ? draft.size_bytes - file.size_bytes
    : draft.size_bytes;
  const countDelta = wasActive ? 0 : 1;

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO file_versions (
         id, tenant_id, file_id, version_num, r2_object_key, r2_upload_id,
         size_bytes, mime_type, upload_status, uploaded_by, comment, created_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'completed', ?, 'Finalized from WOPI draft', ?)`
    ).bind(
      versionId,
      session.tenant_id,
      file.id,
      versionNum,
      draft.r2_object_key,
      draft.size_bytes,
      draft.mime_type,
      actor.id,
      nowIso
    ),
    env.DB.prepare(
      `UPDATE files
          SET upload_state = 'active',
              size_bytes = ?,
              mime_type = ?,
              current_version_id = ?,
              current_version_num = ?,
              meta_version = meta_version + 1,
              updated_by = ?,
              updated_at = ?
        WHERE tenant_id = ? AND id = ?`
    ).bind(
      draft.size_bytes,
      draft.mime_type,
      versionId,
      versionNum,
      actor.id,
      nowIso,
      session.tenant_id,
      file.id
    ),
    env.DB.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(file.id),
    env.DB.prepare(
      `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      file.id,
      session.tenant_id,
      file.classification,
      file.name,
      file.extension ?? '',
      file.ai_reason ?? ''
    ),
    env.DB.prepare(
      `INSERT INTO tenant_storage_stats (
         tenant_id, classification, file_count, total_bytes, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, classification)
       DO UPDATE SET file_count = MAX(0, file_count + ?),
                     total_bytes = MAX(0, total_bytes + ?),
                     updated_at = excluded.updated_at`
    ).bind(
      session.tenant_id,
      file.classification,
      Math.max(0, countDelta),
      Math.max(0, netDeltaBytes),
      nowIso,
      countDelta,
      netDeltaBytes
    ),
    buildUserStorageDeltaStmt(env.DB, {
      tenantId: session.tenant_id,
      userId: file.created_by,
      countDelta,
      bytesDelta: netDeltaBytes,
      nowIso,
    }),
    ...(file.deleted_at === null
      ? buildRootFolderDeltaByFolderStmts(env.DB, {
          tenantId: session.tenant_id,
          folderId: file.folder_id,
          countDelta,
          bytesDelta: netDeltaBytes,
          nowIso,
        })
      : []),
    buildAuditLogStmt(env.DB, {
      tenantId: session.tenant_id,
      actorId: actor.id,
      actorEmail: actor.email,
      actorIp: actor.ipAddress,
      action: 'wopi.version_finalized',
      targetType: 'file',
      targetId: file.id,
      classificationSnapshot: file.classification,
      metadata: {
        sessionId: session.id,
        draftId: draft.id,
        versionId,
        versionNum,
        sizeBytes: draft.size_bytes,
      },
      nowIso,
    }),
    buildSyncChangeStmt(env.DB, {
      tenantId: session.tenant_id,
      entityType: 'file',
      entityId: file.id,
      folderId: file.folder_id,
      action: 'file.version_finalized',
      payload: {
        name: file.name,
        sizeBytes: draft.size_bytes,
        mimeType: draft.mime_type,
        currentVersionNum: versionNum,
        metaVersion: file.meta_version + 1,
        source: 'wopi',
        updatedAt: nowIso,
      },
      nowIso,
    }),
    env.DB.prepare(
      `UPDATE wopi_drafts
          SET is_active = 0, promoted_at = ?, promoted_version_id = ?, updated_at = ?
        WHERE id = ?`
    ).bind(nowIso, versionId, nowIso, draft.id),
  ];

  const batchResults = await env.DB.batch(statements);

  const [updatedFile, version] = await Promise.all([
    env.DB.prepare('SELECT * FROM files WHERE tenant_id = ? AND id = ?')
      .bind(session.tenant_id, file.id)
      .first<FileRow>(),
    env.DB.prepare('SELECT * FROM file_versions WHERE tenant_id = ? AND id = ?')
      .bind(session.tenant_id, versionId)
      .first<FileVersionRow>(),
  ]);

  return {
    file: updatedFile!,
    version: version!,
    draft: {
      ...draft,
      is_active: 0,
      promoted_at: nowIso,
      promoted_version_id: versionId,
      updated_at: nowIso,
    },
    syncSeq: extractLastSyncSeq(batchResults),
  };
}

export async function purgeExpiredWopiDrafts(
  env: Pick<OidcEnv, 'DB' | 'BUCKET'>,
  nowMs = Date.now()
): Promise<{ draftsPurged: number; sessionsExpired: number }> {
  const nowIso = new Date(nowMs).toISOString();

  const sessionResult = await env.DB.prepare(
    `UPDATE wopi_sessions SET is_active = 0
      WHERE is_active = 1 AND expires_at <= ?`
  )
    .bind(nowIso)
    .run();

  const candidates = await env.DB.prepare(
    `SELECT id, r2_object_key FROM wopi_drafts
      WHERE promoted_at IS NULL AND expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT ?`
  )
    .bind(nowIso, DRAFT_PURGE_BATCH)
    .all<{ id: string; r2_object_key: string }>();

  const rows = candidates.results;
  if (rows.length === 0) {
    return {
      draftsPurged: 0,
      sessionsExpired: sessionResult.meta.changes ?? 0,
    };
  }

  const unreferencedKeys = await selectUnreferencedR2Keys(
    env.DB,
    rows.map((row) => ({ id: row.id, r2_object_key: row.r2_object_key }))
  );
  for (const chunk of chunkArray(unreferencedKeys, 50)) {
    await Promise.allSettled(chunk.map((key) => env.BUCKET.delete(key)));
  }

  const deleteStmts = chunkArray(
    rows.map((row) => row.id),
    50
  ).map((ids) =>
    env.DB.prepare(
      `DELETE FROM wopi_drafts WHERE id IN (${ids.map(() => '?').join(', ')})`
    ).bind(...ids)
  );
  await executeBatchChunks(env.DB, deleteStmts, 30);

  return {
    draftsPurged: rows.length,
    sessionsExpired: sessionResult.meta.changes ?? 0,
  };
}
