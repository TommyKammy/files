-- ============================================================================
-- Migration: 0015_admin_member_users.sql
-- Purpose:   P11-2 / TOM-64 internal member administration (per-member
--            storage quotas, member listing/detail and bulk import).
--
-- Design notes:
-- - `users.last_login_at` already exists (0013). Do not re-add it.
-- - `idx_users_tenant_type` already exists (0013). This migration adds the
--   covering member-list index instead.
-- - `user_storage_stats` mirrors `tenant_storage_stats`, but keyed by the file
--   owner (`files.created_by`) so per-user usage is an O(1) lookup and the
--   upload-time quota guard never scans `files`.
-- - The backfill counts only live, active files, matching the tenant stats
--   semantics used by the admin dashboard and purge pipeline.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN storage_quota_bytes INTEGER NULL
    CHECK (storage_quota_bytes IS NULL OR storage_quota_bytes > 0);

CREATE INDEX IF NOT EXISTS idx_users_tenant_member_status
  ON users(tenant_id, user_type, status, email);

CREATE TABLE user_storage_stats (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX idx_user_storage_stats_tenant_usage
  ON user_storage_stats(tenant_id, total_bytes DESC);

-- Initial per-owner aggregation. `deleted_at IS NULL AND upload_state = 'active'`
-- is the same definition used by `tenant_storage_stats` maintenance paths.
INSERT INTO user_storage_stats (
  tenant_id, user_id, file_count, total_bytes, updated_at
)
SELECT tenant_id,
       created_by,
       COUNT(*),
       COALESCE(SUM(size_bytes), 0),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM files
 WHERE deleted_at IS NULL
   AND upload_state = 'active'
   AND created_by IS NOT NULL
 GROUP BY tenant_id, created_by;
