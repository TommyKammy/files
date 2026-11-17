-- ============================================================================
-- Migration: 0019_admin_insights.sql
-- Purpose:   P13-2 / TOM-67 admin insights dashboard.
--
-- Design notes:
-- - `tenant_daily_insights` is a per-tenant, per-UTC-day pre-aggregation. The
--   dashboard reads a bounded range from this table instead of running
--   `COUNT(*)` over the million-row `files` table at request time.
-- - The daily maintenance Cron upserts yesterday and today from the existing
--   O(1) `tenant_storage_stats` snapshot plus boundary-index range scans.
-- - `idx_files_active_created` complements `idx_files_active_recent` so the
--   "new files today" aggregate is a (tenant_id, created_at) index range, not
--   a tenant-wide `files` scan.
-- - `idx_shared_links_tenant_created` keeps the daily "links created" and
--   trend queries off a `shared_links` full scan. Active-link counts keep
--   using the partial `idx_shared_links_tenant_active` index from 0016.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_daily_insights (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day_utc TEXT NOT NULL,
  active_users_count INTEGER NOT NULL DEFAULT 0 CHECK (active_users_count >= 0),
  active_guests_count INTEGER NOT NULL DEFAULT 0 CHECK (active_guests_count >= 0),
  new_files_count INTEGER NOT NULL DEFAULT 0 CHECK (new_files_count >= 0),
  downloads_count INTEGER NOT NULL DEFAULT 0 CHECK (downloads_count >= 0),
  shared_links_created_count INTEGER NOT NULL DEFAULT 0
    CHECK (shared_links_created_count >= 0),
  blocked_audit_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_audit_count >= 0),
  used_bytes_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes_snapshot >= 0),
  total_files_snapshot INTEGER NOT NULL DEFAULT 0 CHECK (total_files_snapshot >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, day_utc)
);

CREATE INDEX IF NOT EXISTS idx_files_active_created
  ON files(tenant_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL AND upload_state = 'active';

CREATE INDEX IF NOT EXISTS idx_shared_links_tenant_created
  ON shared_links(tenant_id, created_at DESC, id);
