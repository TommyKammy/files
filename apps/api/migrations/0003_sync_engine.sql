-- ============================================================================
-- Migration: 0003_sync_engine.sql
-- Purpose:   Phase 5 Linear-grade local-first sync schema:
--            1. Decoupled metadata optimistic lock version on files (`meta_version`)
--            2. Lock-free monotonic `sync_changes` log with tenant/seq index
--            3. Per-tenant purge horizon so stale `sinceSeq` triggers clean reset
-- ============================================================================

ALTER TABLE files ADD COLUMN meta_version INTEGER NOT NULL DEFAULT 1 CHECK (meta_version >= 1);

CREATE TABLE sync_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('folder', 'file', 'permission', 'shared_link', 'policy', 'user')),
  entity_id TEXT NOT NULL,
  folder_id TEXT,
  target_user_id TEXT,
  action TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_sync_changes_tenant_seq
  ON sync_changes(tenant_id, seq);

CREATE INDEX idx_sync_changes_created_at
  ON sync_changes(created_at);

CREATE TABLE tenant_sync_horizons (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  purged_before_seq INTEGER NOT NULL DEFAULT 0 CHECK (purged_before_seq >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
