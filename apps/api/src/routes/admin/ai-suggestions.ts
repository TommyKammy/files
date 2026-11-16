import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  getAuthenticatedUser,
  requireSecOrSysAdmin,
} from '../../services/authorization';
import { buildClassificationChangeStatements } from '../../services/classification-updater';
import { FileRow } from '../../services/file-upload-common';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { ClassificationLabel } from '../../types/api';
import type { AiClassificationMode } from '../../types/classification';
import type { OidcHonoEnv } from '../../types/oidc';
import { isClassificationStricter, pickStricterClassification } from '../../utils/classification';

import {
  ASSIGNABLE_LABELS,
  MAX_BULK_APPROVE_ITEMS,
  executeGroupedBatches,
} from './shared';
export function registerAiSuggestionRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/ai-suggestions — queued AI classification suggestions (uses partial index) */
  routes.get('/ai-suggestions', async (c) => {
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
  routes.post('/ai-suggestions/bulk-approve', async (c) => {
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

}
