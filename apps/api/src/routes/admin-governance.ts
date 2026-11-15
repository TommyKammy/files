import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import {
  getAuthenticatedUser,
  requireSecOrSysAdmin,
} from '../services/authorization';
import { buildClassificationChangeStatements } from '../services/classification-updater';
import type { FileRow } from '../services/file-upload-common';
import { buildSyncChangeStmt } from '../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../services/sync-notifier';
import type { ClassificationLabel } from '../types/api';
import type { AiClassificationMode } from '../types/classification';
import type { OidcHonoEnv } from '../types/oidc';
import { isClassificationStricter, pickStricterClassification } from '../utils/classification';

const MAX_BULK_APPROVE_ITEMS = 50;
const D1_BATCH_STATEMENTS_SAFE_LIMIT = 30;
const ASSIGNABLE_LABELS = new Set<ClassificationLabel>([
  'confidential',
  'internal',
  'public',
]);
const VALID_AI_MODES = new Set<AiClassificationMode>([
  'disabled',
  'metadata_only',
  'content_excerpt',
]);

interface StorageStatRow {
  classification: ClassificationLabel;
  file_count: number;
  total_bytes: number;
  updated_at: string;
}

interface AuditLogRow {
  id: string;
  tenant_id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  classification_snapshot: string | null;
  status: 'allowed' | 'blocked';
  metadata_json: string | null;
  created_at: string;
}

/** Flush grouped per-file atomic statement batches without splitting a file across chunks. */
async function executeGroupedBatches(
  db: D1Database,
  groups: D1PreparedStatement[][]
): Promise<D1Result[]> {
  const results: D1Result[] = [];
  let current: D1PreparedStatement[] = [];
  for (const stmts of groups) {
    if (current.length > 0 && current.length + stmts.length > D1_BATCH_STATEMENTS_SAFE_LIMIT) {
      results.push(...(await db.batch(current)));
      current = [];
    }
    current.push(...stmts);
  }
  if (current.length > 0) {
    results.push(...(await db.batch(current)));
  }
  return results;
}

export const adminGovernanceRoutes = new Hono<OidcHonoEnv>();
adminGovernanceRoutes.use('*', sessionAuthMiddleware({ required: true }), requireSecOrSysAdmin);

/** GET /api/admin/storage-stats — O(1) lookup against tenant_storage_stats (no full files scan) */
adminGovernanceRoutes.get('/storage-stats', async (c) => {
  const user = getAuthenticatedUser(c);

  const [tenantRow, statsRows] = await Promise.all([
    c.env.DB.prepare('SELECT storage_quota_bytes FROM tenants WHERE id = ?')
      .bind(user.tenantId)
      .first<{ storage_quota_bytes: number }>(),
    c.env.DB.prepare(
      'SELECT classification, file_count, total_bytes, updated_at FROM tenant_storage_stats WHERE tenant_id = ?'
    )
      .bind(user.tenantId)
      .all<StorageStatRow>(),
  ]);

  const byClassification: Record<
    ClassificationLabel,
    { fileCount: number; totalBytes: number }
  > = {
    confidential: { fileCount: 0, totalBytes: 0 },
    internal: { fileCount: 0, totalBytes: 0 },
    public: { fileCount: 0, totalBytes: 0 },
    unset: { fileCount: 0, totalBytes: 0 },
  };

  let totalFiles = 0;
  let usedBytes = 0;
  for (const row of statsRows.results) {
    if (row.classification in byClassification) {
      byClassification[row.classification] = {
        fileCount: row.file_count,
        totalBytes: row.total_bytes,
      };
    }
    totalFiles += row.file_count;
    usedBytes += row.total_bytes;
  }

  let d1EstimatedBytes: number | null = null;
  try {
    const dbSize = await c.env.DB.prepare(
      'SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size()) AS db_bytes'
    ).first<{ db_bytes: number }>();
    if (typeof dbSize?.db_bytes === 'number' && Number.isFinite(dbSize.db_bytes)) {
      d1EstimatedBytes = dbSize.db_bytes;
    }
  } catch {
    d1EstimatedBytes = null;
  }

  const quotaBytes = tenantRow?.storage_quota_bytes ?? 0;

  return c.json({
    quotaBytes,
    usedBytes,
    remainingBytes: Math.max(0, quotaBytes - usedBytes),
    totalFiles,
    byClassification,
    d1EstimatedBytes,
  });
});

/** GET /api/admin/ai-suggestions — queued AI classification suggestions (uses partial index) */
adminGovernanceRoutes.get('/ai-suggestions', async (c) => {
  const user = getAuthenticatedUser(c);
  const labelFilter = c.req.query('suggestedLabel');
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

  const conditions = [
    'f.tenant_id = ?',
    'f.ai_suggested_label IS NOT NULL',
    'f.deleted_at IS NULL',
    "f.upload_state = 'active'",
  ];
  const binds: unknown[] = [user.tenantId];

  if (labelFilter && ASSIGNABLE_LABELS.has(labelFilter as ClassificationLabel)) {
    conditions.push('f.ai_suggested_label = ?');
    binds.push(labelFilter);
  }

  const cursorUpdatedAt = c.req.query('cursorUpdatedAt');
  const cursorId = c.req.query('cursorId');
  if (cursorUpdatedAt && cursorId) {
    conditions.push('(f.updated_at < ? OR (f.updated_at = ? AND f.id < ?))');
    binds.push(cursorUpdatedAt, cursorUpdatedAt, cursorId);
  }

  binds.push(limit + 1);

  const rows = await c.env.DB.prepare(
    `SELECT f.id, f.folder_id, fld.name AS folder_name, f.name, f.extension, f.mime_type,
            f.size_bytes, f.classification, f.ai_suggested_label, f.ai_confidence,
            f.ai_reason, f.created_by, u.email AS uploader_email, f.updated_at
     FROM files f
     LEFT JOIN folders fld ON fld.id = f.folder_id
     LEFT JOIN users u ON u.id = f.created_by
     WHERE ${conditions.join(' AND ')}
     ORDER BY f.updated_at DESC, f.id DESC
     LIMIT ?`
  )
    .bind(...binds)
    .all<{
      id: string;
      folder_id: string | null;
      folder_name: string | null;
      name: string;
      extension: string | null;
      mime_type: string | null;
      size_bytes: number;
      classification: ClassificationLabel;
      ai_suggested_label: ClassificationLabel;
      ai_confidence: number | null;
      ai_reason: string | null;
      created_by: string;
      uploader_email: string | null;
      updated_at: string;
    }>();

  const hasMore = rows.results.length > limit;
  const page = hasMore ? rows.results.slice(0, limit) : rows.results;
  const last = page[page.length - 1];

  return c.json({
    suggestions: page.map((r) => ({
      fileId: r.id,
      folderId: r.folder_id,
      folderName: r.folder_name,
      name: r.name,
      extension: r.extension,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      currentClassification: r.classification,
      suggestedLabel: r.ai_suggested_label,
      confidence: r.ai_confidence,
      reason: r.ai_reason,
      uploaderEmail: r.uploader_email,
      updatedAt: r.updated_at,
    })),
    nextCursor:
      hasMore && last ? { updatedAt: last.updated_at, id: last.id } : null,
  });
});

/** POST /api/admin/ai-suggestions/bulk-approve — approve/override up to 50 AI suggestions atomically */
adminGovernanceRoutes.post('/ai-suggestions/bulk-approve', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    items?: Array<{ fileId?: unknown; label?: unknown }>;
    fileIds?: unknown[];
    overrideLabel?: unknown;
  } | null;

  const normalizedItems: Array<{ fileId: string; overrideLabel?: ClassificationLabel }> = [];

  if (Array.isArray(body?.items)) {
    for (const item of body.items) {
      if (typeof item?.fileId !== 'string' || !item.fileId.trim()) {
        return c.json({ error: 'Each item requires a valid fileId' }, 400);
      }
      let overrideLabel: ClassificationLabel | undefined;
      if (item.label !== undefined) {
        if (
          typeof item.label !== 'string' ||
          !ASSIGNABLE_LABELS.has(item.label as ClassificationLabel)
        ) {
          return c.json({ error: `Invalid classification label: ${String(item.label)}` }, 400);
        }
        overrideLabel = item.label as ClassificationLabel;
      }
      normalizedItems.push({ fileId: item.fileId.trim(), overrideLabel });
    }
  } else if (Array.isArray(body?.fileIds)) {
    let batchOverride: ClassificationLabel | undefined;
    if (body.overrideLabel !== undefined) {
      if (
        typeof body.overrideLabel !== 'string' ||
        !ASSIGNABLE_LABELS.has(body.overrideLabel as ClassificationLabel)
      ) {
        return c.json({ error: 'Invalid overrideLabel' }, 400);
      }
      batchOverride = body.overrideLabel as ClassificationLabel;
    }
    for (const rawId of body.fileIds) {
      if (typeof rawId !== 'string' || !rawId.trim()) {
        return c.json({ error: 'fileIds must contain valid strings' }, 400);
      }
      normalizedItems.push({ fileId: rawId.trim(), overrideLabel: batchOverride });
    }
  } else {
    return c.json({ error: 'items[] or fileIds[] is required' }, 400);
  }

  // Deduplicate fileIds while preserving max 50 check
  const dedupedMap = new Map<string, ClassificationLabel | undefined>();
  for (const item of normalizedItems) {
    dedupedMap.set(item.fileId, item.overrideLabel);
  }
  const uniqueIds = [...dedupedMap.keys()];

  if (uniqueIds.length === 0 || uniqueIds.length > MAX_BULK_APPROVE_ITEMS) {
    return c.json(
      {
        error: `Bulk approve accepts between 1 and ${MAX_BULK_APPROVE_ITEMS} items per request`,
        code: 'MAX_BULK_LIMIT_EXCEEDED',
      },
      400
    );
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const fileRows = await c.env.DB.prepare(
    `SELECT * FROM files
     WHERE tenant_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL AND upload_state = 'active'`
  )
    .bind(user.tenantId, ...uniqueIds)
    .all<FileRow>();

  const fileById = new Map<string, FileRow>(fileRows.results.map((f) => [f.id, f]));

  // Preload strictest ancestor classifications for unique parent folders
  const folderIds = [
    ...new Set(
      fileRows.results
        .map((f) => f.folder_id)
        .filter((fid): fid is string => Boolean(fid))
    ),
  ];
  const folderFloorMap = new Map<string, ClassificationLabel>();
  if (folderIds.length > 0) {
    const fPlaceholders = folderIds.map(() => '?').join(', ');
    const ancestorRows = await c.env.DB.prepare(
      `SELECT fc.descendant_id, anc.classification
       FROM folder_closures fc
       JOIN folders anc ON anc.tenant_id = fc.tenant_id AND anc.id = fc.ancestor_id
       WHERE fc.tenant_id = ? AND fc.descendant_id IN (${fPlaceholders}) AND anc.deleted_at IS NULL`
    )
      .bind(user.tenantId, ...folderIds)
      .all<{ descendant_id: string; classification: ClassificationLabel }>();

    for (const row of ancestorRows.results) {
      const prev = folderFloorMap.get(row.descendant_id) ?? 'unset';
      folderFloorMap.set(
        row.descendant_id,
        pickStricterClassification(prev, row.classification)
      );
    }
  }

  const nowIso = new Date().toISOString();
  const stmtGroups: D1PreparedStatement[][] = [];
  const approvedIds: string[] = [];
  const skippedIds: string[] = [];
  const approvedFolderIds = new Set<string>();

  for (const fileId of uniqueIds) {
    const file = fileById.get(fileId);
    if (!file) {
      skippedIds.push(fileId);
      continue;
    }

    const chosenLabel = dedupedMap.get(fileId) ?? file.ai_suggested_label;
    if (!chosenLabel || !ASSIGNABLE_LABELS.has(chosenLabel)) {
      skippedIds.push(fileId);
      continue;
    }

    if (file.folder_id) {
      const floor = folderFloorMap.get(file.folder_id) ?? 'unset';
      if (floor === 'confidential' && isClassificationStricter(floor, chosenLabel)) {
        return c.json(
          {
            error: `Cannot assign "${chosenLabel}" to file ${file.name} beneath a confidential parent folder`,
            code: 'CLASSIFICATION_DOWNGRADE_FORBIDDEN',
            fileId,
          },
          403
        );
      }
      approvedFolderIds.add(file.folder_id);
    }

    stmtGroups.push(
      buildClassificationChangeStatements(c.env.DB, {
        tenantId: user.tenantId,
        fileId: file.id,
        folderId: file.folder_id,
        fromClassification: file.classification,
        toClassification: chosenLabel,
        sizeBytes: file.size_bytes,
        clearSuggestion: true,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        auditAction: 'admin.ai_suggestion_approved',
        auditMetadata: {
          aiSuggestedLabel: file.ai_suggested_label,
          aiConfidence: file.ai_confidence,
        },
        nowIso,
      })
    );
    approvedIds.push(file.id);
  }

  if (stmtGroups.length > 0) {
    const batchResults = await executeGroupedBatches(c.env.DB, stmtGroups);
    await emitTenantSyncSignal(c, {
      tenantId: user.tenantId,
      seq: extractLastSyncSeq(batchResults),
      eventKind: 'admin.ai_suggestion_approved',
      scopeFolderIds: Array.from(approvedFolderIds),
    });
  }

  return c.json({
    ok: true,
    approvedCount: approvedIds.length,
    approvedIds,
    skippedIds,
  });
});

/** GET /api/admin/shared-links — active shared links feed for governance monitoring */
adminGovernanceRoutes.get('/shared-links', async (c) => {
  const user = getAuthenticatedUser(c);
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

  const rows = await c.env.DB.prepare(
    `SELECT sl.id, sl.target_type, sl.target_id, sl.access_scope, sl.can_download,
            sl.require_watermark, sl.failed_password_attempts, sl.locked_until,
            sl.expires_at, sl.max_downloads, sl.download_count, sl.created_by,
            u.email AS creator_email,
            CASE
              WHEN sl.target_type = 'file' THEN (SELECT name FROM files WHERE id = sl.target_id)
              ELSE (SELECT name FROM folders WHERE id = sl.target_id)
            END AS target_name,
            sl.created_at
     FROM shared_links sl
     LEFT JOIN users u ON u.id = sl.created_by
     WHERE sl.tenant_id = ? AND sl.revoked_at IS NULL
     ORDER BY sl.created_at DESC LIMIT ?`
  )
    .bind(user.tenantId, limit)
    .all();

  return c.json({ links: rows.results });
});

/** POST /api/admin/shared-links/:id/revoke — emergency admin shared-link revocation */
adminGovernanceRoutes.post('/shared-links/:id/revoke', async (c) => {
  const user = getAuthenticatedUser(c);
  const linkId = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason =
    typeof body?.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 300)
      : 'Admin emergency revocation';

  const link = await c.env.DB.prepare(
    'SELECT id, target_type, target_id, created_by, revoked_at FROM shared_links WHERE tenant_id = ? AND id = ?'
  )
    .bind(user.tenantId, linkId)
    .first<{
      id: string;
      target_type: 'file' | 'folder';
      target_id: string;
      created_by: string;
      revoked_at: string | null;
    }>();

  if (!link || link.revoked_at !== null) {
    return c.json({ error: 'Active shared link not found' }, 404);
  }

  let targetFolderId: string | null = link.target_type === 'folder' ? link.target_id : null;
  if (link.target_type === 'file') {
    const fileRow = await c.env.DB.prepare(
      'SELECT folder_id FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(user.tenantId, link.target_id)
      .first<{ folder_id: string | null }>();
    targetFolderId = fileRow?.folder_id ?? null;
  }

  const nowIso = new Date().toISOString();
  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE shared_links SET revoked_at = ?, revoked_by = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL'
    ).bind(nowIso, user.id, user.tenantId, linkId),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.shared_link_revoked',
      targetType: link.target_type,
      targetId: link.target_id,
      status: 'allowed',
      metadata: { linkId, reason },
      nowIso,
    }),
    buildSyncChangeStmt(c.env.DB, {
      tenantId: user.tenantId,
      entityType: 'shared_link',
      entityId: linkId,
      folderId: targetFolderId,
      targetUserId: link.created_by,
      action: 'shared_link.revoke',
      payload: {
        linkId,
        targetType: link.target_type,
        targetId: link.target_id,
        reason,
        revokedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  await emitTenantSyncSignal(c, {
    tenantId: user.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind: 'shared_link.revoke',
    scopeFolderIds: [targetFolderId],
    revoked: true,
  });

  return c.json({ ok: true, linkId, revokedAt: nowIso });
});

/** GET / PATCH /api/admin/policies — tenant governance policy settings */
adminGovernanceRoutes.get('/policies', async (c) => {
  const user = getAuthenticatedUser(c);
  const policy = await c.env.DB.prepare('SELECT * FROM tenant_policies WHERE tenant_id = ?')
    .bind(user.tenantId)
    .first();
  return c.json({ policy });
});

adminGovernanceRoutes.patch('/policies', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    enforceCompanyOnlyLinks?: boolean;
    requireWatermarkConfidential?: boolean;
    maxLinkExpirationDays?: number;
    sessionMaxHours?: number;
    trashRetentionDays?: number;
    aiClassificationMode?: AiClassificationMode;
    aiAutoApplyThreshold?: number | null;
  } | null;

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'JSON body required' }, 400);
  }

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (body.enforceCompanyOnlyLinks !== undefined) {
    updates.push('enforce_company_only_links = ?');
    binds.push(body.enforceCompanyOnlyLinks ? 1 : 0);
  }
  if (body.requireWatermarkConfidential !== undefined) {
    updates.push('require_watermark_confidential = ?');
    binds.push(body.requireWatermarkConfidential ? 1 : 0);
  }
  if (body.maxLinkExpirationDays !== undefined) {
    if (!Number.isInteger(body.maxLinkExpirationDays) || body.maxLinkExpirationDays < 1 || body.maxLinkExpirationDays > 365) {
      return c.json({ error: 'maxLinkExpirationDays must be integer 1..365' }, 400);
    }
    updates.push('max_link_expiration_days = ?');
    binds.push(body.maxLinkExpirationDays);
  }
  if (body.sessionMaxHours !== undefined) {
    if (!Number.isInteger(body.sessionMaxHours) || body.sessionMaxHours < 1 || body.sessionMaxHours > 720) {
      return c.json({ error: 'sessionMaxHours must be integer 1..720' }, 400);
    }
    updates.push('session_max_hours = ?');
    binds.push(body.sessionMaxHours);
  }
  if (body.trashRetentionDays !== undefined) {
    if (!Number.isInteger(body.trashRetentionDays) || body.trashRetentionDays < 1 || body.trashRetentionDays > 3650) {
      return c.json({ error: 'trashRetentionDays must be integer 1..3650' }, 400);
    }
    updates.push('trash_retention_days = ?');
    binds.push(body.trashRetentionDays);
  }
  if (body.aiClassificationMode !== undefined) {
    if (!VALID_AI_MODES.has(body.aiClassificationMode)) {
      return c.json({ error: 'Invalid aiClassificationMode' }, 400);
    }
    updates.push('ai_classification_mode = ?');
    binds.push(body.aiClassificationMode);
  }
  if (body.aiAutoApplyThreshold !== undefined) {
    if (
      body.aiAutoApplyThreshold !== null &&
      (typeof body.aiAutoApplyThreshold !== 'number' ||
        body.aiAutoApplyThreshold < 0.7 ||
        body.aiAutoApplyThreshold > 1)
    ) {
      return c.json({ error: 'aiAutoApplyThreshold must be null or 0.70..1.00' }, 400);
    }
    updates.push('ai_auto_apply_threshold = ?');
    binds.push(body.aiAutoApplyThreshold);
  }

  if (updates.length === 0) {
    return c.json({ error: 'No policy fields provided' }, 400);
  }

  const nowIso = new Date().toISOString();
  updates.push('updated_by = ?', 'updated_at = ?');
  binds.push(user.id, nowIso, user.tenantId);

  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE tenant_policies SET ${updates.join(', ')} WHERE tenant_id = ?`
    ).bind(...binds),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.policy_updated',
      targetType: 'tenant_policy',
      targetId: user.tenantId,
      metadata: body as Record<string, unknown>,
      nowIso,
    }),
    buildSyncChangeStmt(c.env.DB, {
      tenantId: user.tenantId,
      entityType: 'policy',
      entityId: user.tenantId,
      action: 'admin.policy_updated',
      payload: {
        updatedFields: Object.keys(body),
        updatedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  await emitTenantSyncSignal(c, {
    tenantId: user.tenantId,
    seq: extractLastSyncSeq(batchResults),
    eventKind: 'admin.policy_updated',
  });

  const updated = await c.env.DB.prepare('SELECT * FROM tenant_policies WHERE tenant_id = ?')
    .bind(user.tenantId)
    .first();
  return c.json({ policy: updated });
});

/** Audit logs API (`/api/audit-logs`) — Keyset paginated over idx_audit_logs_tenant_time */
export const auditLogsRoutes = new Hono<OidcHonoEnv>();
auditLogsRoutes.use('*', sessionAuthMiddleware({ required: true }), requireSecOrSysAdmin);

auditLogsRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const conditions = ['tenant_id = ?'];
  const binds: unknown[] = [user.tenantId];

  const action = c.req.query('action')?.trim();
  if (action) {
    conditions.push('action = ?');
    binds.push(action);
  }

  const status = c.req.query('status')?.trim();
  if (status === 'allowed' || status === 'blocked') {
    conditions.push('status = ?');
    binds.push(status);
  }

  const actorEmail = c.req.query('actorEmail')?.trim();
  if (actorEmail) {
    conditions.push('actor_email = ?');
    binds.push(actorEmail);
  }

  const targetId = c.req.query('targetId')?.trim();
  if (targetId) {
    conditions.push('target_id = ?');
    binds.push(targetId);
  }

  const fromIso = c.req.query('from')?.trim();
  if (fromIso) {
    conditions.push('created_at >= ?');
    binds.push(fromIso);
  }

  const toIso = c.req.query('to')?.trim();
  if (toIso) {
    conditions.push('created_at <= ?');
    binds.push(toIso);
  }

  const cursorCreatedAt = c.req.query('cursorCreatedAt')?.trim();
  const cursorId = c.req.query('cursorId')?.trim();
  if (cursorCreatedAt && cursorId) {
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    binds.push(cursorCreatedAt, cursorCreatedAt, cursorId);
  }

  binds.push(limit + 1);

  const rows = await c.env.DB.prepare(
    `SELECT id, tenant_id, actor_id, actor_email, actor_ip, action,
            target_type, target_id, classification_snapshot, status,
            metadata_json, created_at
     FROM audit_logs
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`
  )
    .bind(...binds)
    .all<AuditLogRow>();

  const hasMore = rows.results.length > limit;
  const page = hasMore ? rows.results.slice(0, limit) : rows.results;
  const last = page[page.length - 1];

  if (c.req.query('format') === 'csv') {
    const csvEscape = (v: string | null | undefined) => {
      const s = v ?? '';
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = 'id,created_at,action,status,actor_email,actor_ip,target_type,target_id,classification,metadata_json';
    const lines = page.map((r) =>
      [
        r.id,
        r.created_at,
        r.action,
        r.status,
        r.actor_email,
        r.actor_ip,
        r.target_type,
        r.target_id,
        r.classification_snapshot,
        r.metadata_json,
      ]
        .map(csvEscape)
        .join(',')
    );
    return new Response([header, ...lines].join('\n'), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="files-audit-logs.csv"',
      },
    });
  }

  return c.json({
    logs: page.map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      actorEmail: r.actor_email,
      actorIp: r.actor_ip,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      classificationSnapshot: r.classification_snapshot,
      status: r.status,
      metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
      createdAt: r.created_at,
    })),
    nextCursor:
      hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
  });
});
