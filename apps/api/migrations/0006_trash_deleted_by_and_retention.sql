-- ============================================================================
-- Migration: 0006_trash_deleted_by_and_retention.sql
-- Purpose:   Phase 8 Trash UX:
--            1. Record who moved a folder/file to Trash for search, sort and
--               filtering (`deleted_by`); legacy rows stay NULL for backward
--               compatibility and are rendered as "不明".
--            2. Add composite lookup indexes for the mixed folder/file Trash
--               listing ordered by deleted_at / deleted_by / id.
--            3. Align tenant_policies.trash_retention_days CHECK with the admin
--               API (1..3650) by rebuilding the table while preserving data.
--
-- tenant_policies is a leaf table (nothing references it), so the SQLite
-- table-rebuild pattern is safe even with D1 foreign-key enforcement on.
-- ============================================================================

ALTER TABLE folders ADD COLUMN deleted_by TEXT REFERENCES users(id);
ALTER TABLE files ADD COLUMN deleted_by TEXT REFERENCES users(id);

CREATE INDEX idx_folders_trash_lookup
  ON folders(tenant_id, deleted_at, deleted_by, id)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX idx_files_trash_lookup
  ON files(tenant_id, deleted_at, deleted_by, id)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE tenant_policies_new (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enforce_company_only_links INTEGER NOT NULL DEFAULT 0 CHECK (enforce_company_only_links IN (0, 1)),
  require_watermark_confidential INTEGER NOT NULL DEFAULT 1 CHECK (require_watermark_confidential IN (0, 1)),
  max_link_expiration_days INTEGER NOT NULL DEFAULT 30 CHECK (max_link_expiration_days >= 1),
  session_max_hours INTEGER NOT NULL DEFAULT 12 CHECK (session_max_hours >= 1 AND session_max_hours <= 168),
  trash_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (trash_retention_days >= 1 AND trash_retention_days <= 3650),
  ai_classification_mode TEXT NOT NULL DEFAULT 'metadata_only'
    CHECK (ai_classification_mode IN ('disabled', 'metadata_only', 'content_excerpt')),
  ai_auto_apply_threshold REAL
    CHECK (ai_auto_apply_threshold IS NULL OR (ai_auto_apply_threshold >= 0.5 AND ai_auto_apply_threshold <= 1.0)),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO tenant_policies_new (
  tenant_id,
  enforce_company_only_links,
  require_watermark_confidential,
  max_link_expiration_days,
  session_max_hours,
  trash_retention_days,
  ai_classification_mode,
  ai_auto_apply_threshold,
  updated_by,
  updated_at
)
SELECT
  tenant_id,
  enforce_company_only_links,
  require_watermark_confidential,
  max_link_expiration_days,
  session_max_hours,
  trash_retention_days,
  ai_classification_mode,
  ai_auto_apply_threshold,
  updated_by,
  updated_at
FROM tenant_policies;

DROP TABLE tenant_policies;

ALTER TABLE tenant_policies_new RENAME TO tenant_policies;
