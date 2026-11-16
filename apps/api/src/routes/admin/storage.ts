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
  StorageStatRow,
} from './shared';
export function registerStorageStatsRoutes(routes: Hono<OidcHonoEnv>) {
  /** GET /api/admin/storage-stats — O(1) lookup against tenant_storage_stats (no full files scan) */
  routes.get('/storage-stats', async (c) => {
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

}
