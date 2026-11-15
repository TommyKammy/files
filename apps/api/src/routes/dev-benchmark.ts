import { Hono } from 'hono';
import type { OidcHonoEnv } from '../types/oidc';

const TENANT_ID = 'tenant-default';

interface BenchQuerySpec {
  id: number;
  name: string;
  targetDescription: string;
  sql: string;
  bind: unknown[];
}

const BENCH_CASES: Record<number, BenchQuerySpec> = {
  1: {
    id: 1,
    name: 'Case 1: Keyset Pagination (Hotspot 50k page 250)',
    targetDescription: 'idx_files_keyset, p95 < 3ms, rows_read ~= 100',
    sql: `SELECT id, name, extension, mime_type, size_bytes, classification, updated_at
            FROM files
           WHERE tenant_id = ?
             AND folder_id = 'folder-000001'
             AND deleted_at IS NULL
             AND upload_state = 'active'
             AND (name, id) > ('hs-025000.pdf', 'file-0025000')
           ORDER BY name ASC, id ASC
           LIMIT 100`,
    bind: [TENANT_ID],
  },
  2: {
    id: 2,
    name: 'Case 2: Closure Table RBAC (Depth 6 x 5 Groups)',
    targetDescription: 'folder_closures PK, p95 < 2ms, rows_read < 30',
    sql: `SELECT COALESCE(MAX(
            CASE p.role
              WHEN 'owner' THEN 5
              WHEN 'co_owner' THEN 4
              WHEN 'editor' THEN 3
              WHEN 'viewer' THEN 2
              WHEN 'previewer' THEN 1
              ELSE 0
            END
          ), 0) AS max_rank
            FROM folder_closures fc
            JOIN permissions p
              ON p.tenant_id = fc.tenant_id
             AND p.target_type = 'folder'
             AND p.target_id = fc.ancestor_id
           WHERE fc.tenant_id = ?
             AND fc.descendant_id = 'folder-000006'
             AND (
               (p.grantee_type = 'user' AND p.grantee_id = 'user-000005')
               OR (
                 p.grantee_type = 'group'
                 AND p.grantee_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = 'user-000005')
               )
             )`,
    bind: [TENANT_ID],
  },
  3: {
    id: 3,
    name: 'Case 3: Classification Filter (confidential top 100)',
    targetDescription: 'idx_files_classification, p95 < 3ms',
    sql: `SELECT id, folder_id, name, size_bytes, updated_at
            FROM files
           WHERE tenant_id = ?
             AND classification = 'confidential'
             AND deleted_at IS NULL
             AND upload_state = 'active'
           ORDER BY updated_at DESC
           LIMIT 100`,
    bind: [TENANT_ID],
  },
  4: {
    id: 4,
    name: 'Case 4: AI Suggestion Queue (partial index top 50)',
    targetDescription: 'idx_files_ai_suggestion_queue, p95 < 3ms',
    sql: `SELECT id, folder_id, name, ai_suggested_label, ai_confidence, ai_reason, created_at
            FROM files
           WHERE tenant_id = ?
             AND deleted_at IS NULL
             AND upload_state = 'active'
             AND classification = 'unset'
             AND ai_suggested_label IS NOT NULL
           ORDER BY ai_confidence DESC, created_at DESC
           LIMIT 50`,
    bind: [TENANT_ID],
  },
  5: {
    id: 5,
    name: 'Case 5: FTS5 Cmd+K Search + RBAC (is:confidential roadmap)',
    targetDescription: 'files_fts MATCH without full table scan, p95 < 10ms',
    sql: `SELECT fl.id, fl.folder_id, fl.name, fl.classification, fl.updated_at
            FROM files_fts fts
            JOIN files fl ON fl.id = fts.file_id
           WHERE files_fts MATCH 'classification : "confidential" AND roadmap'
             AND fl.tenant_id = ?
             AND fl.upload_state = 'active'
             AND fl.deleted_at IS NULL
             AND (
               EXISTS (
                 SELECT 1 FROM permissions p
                  WHERE p.tenant_id = fl.tenant_id
                    AND p.target_type = 'file'
                    AND p.target_id = fl.id
                    AND (
                      (p.grantee_type = 'user' AND p.grantee_id = 'user-000005')
                      OR (
                        p.grantee_type = 'group'
                        AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = p.grantee_id AND gm.user_id = 'user-000005')
                      )
                    )
               )
               OR (
                 fl.folder_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1
                     FROM folder_closures fc
                     JOIN permissions p
                       ON p.tenant_id = fc.tenant_id
                      AND p.target_type = 'folder'
                      AND p.target_id = fc.ancestor_id
                    WHERE fc.tenant_id = fl.tenant_id
                      AND fc.descendant_id = fl.folder_id
                      AND (
                        (p.grantee_type = 'user' AND p.grantee_id = 'user-000005')
                        OR (
                          p.grantee_type = 'group'
                          AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id = p.grantee_id AND gm.user_id = 'user-000005')
                        )
                      )
                 )
               )
             )
           LIMIT 20`,
    bind: [TENANT_ID],
  },
  6: {
    id: 6,
    name: 'Case 6: O(1) Tenant Storage Stats',
    targetDescription: 'tenant_storage_stats only, rows_read <= 4, p95 < 1ms',
    sql: `SELECT classification, file_count, total_bytes, updated_at
            FROM tenant_storage_stats
           WHERE tenant_id = ?`,
    bind: [TENANT_ID],
  },
};

export const devBenchmarkRoutes = new Hono<OidcHonoEnv>();

// Strictly active only in local development; invisible (404) in staging & production
devBenchmarkRoutes.use('*', async (c, next) => {
  if (c.env.ENVIRONMENT !== 'local') {
    return c.json({ error: 'Not Found' }, 404);
  }
  await next();
});

devBenchmarkRoutes.get('/case/:num', async (c) => {
  const num = Number.parseInt(c.req.param('num'), 10);
  const spec = BENCH_CASES[num];
  if (!spec) {
    return c.json({ error: 'Unknown benchmark case (1..6)' }, 400);
  }

  const explainOnly = c.req.query('explain') === '1';
  if (explainOnly) {
    const plan = await c.env.DB.prepare(`EXPLAIN QUERY PLAN ${spec.sql}`)
      .bind(...spec.bind)
      .all();
    return c.json({
      id: spec.id,
      name: spec.name,
      targetDescription: spec.targetDescription,
      plan: plan.results,
    });
  }

  const t0 = performance.now();
  const res = await c.env.DB.prepare(spec.sql).bind(...spec.bind).all();
  const workerElapsedMs = performance.now() - t0;

  const meta = res.meta as unknown as {
    duration?: number;
    rows_read?: number;
    rows_written?: number;
  };

  return c.json({
    id: spec.id,
    name: spec.name,
    rowCount: res.results.length,
    sqlDurationMs: typeof meta?.duration === 'number' ? meta.duration : null,
    workerElapsedMs,
    rowsRead: typeof meta?.rows_read === 'number' ? meta.rows_read : null,
  });
});

devBenchmarkRoutes.get('/totals', async (c) => {
  const [counts, stats] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM users) AS users,
         (SELECT COUNT(*) FROM groups) AS groups,
         (SELECT COUNT(*) FROM folders) AS folders,
         (SELECT COUNT(*) FROM files) AS files`
    ).first(),
    c.env.DB.prepare(
      'SELECT classification, file_count, total_bytes FROM tenant_storage_stats WHERE tenant_id = ?'
    )
      .bind(TENANT_ID)
      .all(),
  ]);
  return c.json({ counts, storageStats: stats.results });
});
