-- ============================================================================
-- Migration: 0023_root_folder_stats.sql
-- Purpose:   Maintain O(1) per-root-folder active item counts and byte totals
--            so GET /api/admin/root-folders avoids scanning `files` via
--            `folder_closures` across large tenants.
--
-- Semantics (exact parity with loadRootMetrics):
-- - Counts only active, non-deleted files (`upload_state = 'active'` AND
--   `deleted_at IS NULL`) residing inside a root folder subtree
--   (`folder_closures` joining to a root folder where `parent_id IS NULL`).
-- ============================================================================

CREATE TABLE root_folder_stats (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  root_folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, root_folder_id)
);

CREATE INDEX idx_root_folder_stats_tenant_bytes
  ON root_folder_stats(tenant_id, total_bytes DESC);

INSERT INTO root_folder_stats (
  tenant_id, root_folder_id, file_count, total_bytes, updated_at
)
SELECT rf.tenant_id,
       rf.id,
       COUNT(fl.id),
       COALESCE(SUM(fl.size_bytes), 0),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM folders rf
  JOIN folder_closures fc
    ON fc.tenant_id = rf.tenant_id
   AND fc.ancestor_id = rf.id
  LEFT JOIN files fl
    ON fl.tenant_id = fc.tenant_id
   AND fl.folder_id = fc.descendant_id
   AND fl.upload_state = 'active'
   AND fl.deleted_at IS NULL
 WHERE rf.parent_id IS NULL
 GROUP BY rf.tenant_id, rf.id;
