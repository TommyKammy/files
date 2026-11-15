import type { ClassificationLabel } from '../types/api';
import { pickStricterClassification } from '../utils/classification';
import { buildAuditLogStmt } from './audit';
import { buildSyncChangeStmt } from './sync-changes';

const CONFIDENTIAL_LINK_MAX_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClassificationUpdateInput {
  tenantId: string;
  fileId: string;
  folderId?: string | null;
  fromClassification: ClassificationLabel;
  toClassification: ClassificationLabel;
  sizeBytes: number;
  clearSuggestion: boolean;
  actorId: string | null;
  actorEmail: string | null;
  actorIp: string;
  auditAction: string;
  auditMetadata?: Record<string, unknown>;
  nowIso: string;
}

/**
 * Build D1 statements for secondary side effects when a file's classification changes:
 * `tenant_storage_stats` counters and confidential `shared_links` tightening.
 */
export function buildClassificationPolicyStatements(
  db: D1Database,
  input: {
    tenantId: string;
    fileId: string;
    fromClassification: ClassificationLabel;
    toClassification: ClassificationLabel;
    sizeBytes: number;
    actorId: string | null;
    nowIso: string;
  }
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  if (input.fromClassification !== input.toClassification) {
    stmts.push(
      db
        .prepare(
          `UPDATE tenant_storage_stats
           SET file_count = MAX(0, file_count - 1),
               total_bytes = MAX(0, total_bytes - ?),
               updated_at = ?
           WHERE tenant_id = ? AND classification = ?`
        )
        .bind(input.sizeBytes, input.nowIso, input.tenantId, input.fromClassification),
      db
        .prepare(
          `INSERT INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes, updated_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (tenant_id, classification) DO UPDATE SET
             file_count = file_count + 1,
             total_bytes = total_bytes + excluded.total_bytes,
             updated_at = excluded.updated_at`
        )
        .bind(input.tenantId, input.toClassification, input.sizeBytes, input.nowIso)
    );
  }

  if (input.toClassification === 'confidential') {
    const sevenDaysLimitIso = new Date(
      Date.parse(input.nowIso) + CONFIDENTIAL_LINK_MAX_DAYS_MS
    ).toISOString();

    stmts.push(
      db
        .prepare(
          `UPDATE shared_links
           SET revoked_at = ?, revoked_by = ?
           WHERE tenant_id = ? AND target_type = 'file' AND target_id = ?
             AND revoked_at IS NULL AND access_scope = 'public'`
        )
        .bind(input.nowIso, input.actorId, input.tenantId, input.fileId),
      db
        .prepare(
          `UPDATE shared_links
           SET can_download = 0,
               require_watermark = 1,
               expires_at = CASE
                 WHEN expires_at IS NULL OR julianday(expires_at) > julianday(?) THEN ?
                 ELSE expires_at
               END
           WHERE tenant_id = ? AND target_type = 'file' AND target_id = ?
             AND revoked_at IS NULL`
        )
        .bind(sevenDaysLimitIso, sevenDaysLimitIso, input.tenantId, input.fileId)
    );
  }

  return stmts;
}

/**
 * Build atomic D1 statements for changing a file's classification while keeping
 * `tenant_storage_stats`, `files_fts`, confidential `shared_links`, and `sync_changes` consistent.
 */
export function buildClassificationChangeStatements(
  db: D1Database,
  input: ClassificationUpdateInput
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const labelChanged = input.fromClassification !== input.toClassification;

  const setClauses = [
    'classification = ?',
    'meta_version = meta_version + 1',
    'updated_at = ?',
  ];
  const binds: unknown[] = [input.toClassification, input.nowIso];

  if (input.actorId) {
    setClauses.push('updated_by = ?');
    binds.push(input.actorId);
  }
  if (input.clearSuggestion) {
    setClauses.push(
      'ai_suggested_label = NULL',
      'ai_confidence = NULL',
      'ai_reason = NULL'
    );
  }
  binds.push(input.tenantId, input.fileId);

  stmts.push(
    db
      .prepare(
        `UPDATE files SET ${setClauses.join(', ')} WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL`
      )
      .bind(...binds)
  );

  if (labelChanged) {
    stmts.push(
      db.prepare('DELETE FROM files_fts WHERE file_id = ?').bind(input.fileId),
      db
        .prepare(
          `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
           SELECT id, tenant_id, classification, name, COALESCE(extension, ''), COALESCE(ai_reason, '')
             FROM files
            WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL AND upload_state = 'active'`
        )
        .bind(input.tenantId, input.fileId)
    );
  }

  stmts.push(...buildClassificationPolicyStatements(db, input));

  stmts.push(
    buildAuditLogStmt(db, {
      tenantId: input.tenantId,
      actorId: input.actorId,
      actorEmail: input.actorEmail,
      actorIp: input.actorIp,
      action: input.auditAction,
      targetType: 'file',
      targetId: input.fileId,
      classificationSnapshot: input.toClassification,
      metadata: {
        fromClassification: input.fromClassification,
        toClassification: input.toClassification,
        ...input.auditMetadata,
      },
      nowIso: input.nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: input.tenantId,
      entityType: 'file',
      entityId: input.fileId,
      folderId: input.folderId ?? null,
      action: input.auditAction,
      payload: {
        classification: input.toClassification,
        fromClassification: input.fromClassification,
        clearSuggestion: input.clearSuggestion,
        updatedAt: input.nowIso,
      },
      nowIso: input.nowIso,
    })
  );

  return stmts;
}

/**
 * Resolve strictest inherited classification across a folder and all its active ancestors.
 */
export async function resolveFolderClassificationFloor(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<ClassificationLabel> {
  const ancestors = await db
    .prepare(
      `SELECT f.classification
         FROM folder_closures fc
         JOIN folders f ON f.tenant_id = fc.tenant_id AND f.id = fc.ancestor_id
        WHERE fc.tenant_id = ? AND fc.descendant_id = ? AND f.deleted_at IS NULL`
    )
    .bind(tenantId, folderId)
    .all<{ classification: ClassificationLabel }>();

  let strictest: ClassificationLabel = 'unset';
  for (const row of ancestors.results) {
    strictest = pickStricterClassification(strictest, row.classification);
  }
  return strictest;
}
