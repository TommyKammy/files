-- ============================================================================
-- Migration: 0004_cow_copy_and_batch.sql
-- Purpose:   Phase 6 Copy-on-Write (CoW) R2 reference sharing & async subtree jobs:
--            1. Rebuild `file_versions` without UNIQUE constraint on `r2_object_key`
--               so logical CoW copies share immutable R2 objects safely.
--            2. Add non-unique `idx_file_versions_r2_key` for O(1) GC reference lookup.
--            3. Add `workspace_jobs` for chunked async subtree copy (>100 nodes).
-- ============================================================================

CREATE TABLE file_versions_next (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_num INTEGER NOT NULL CHECK (version_num >= 1),
  r2_object_key TEXT NOT NULL,
  r2_upload_id TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,
  upload_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (upload_status IN ('pending', 'completed', 'failed')),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (file_id, version_num)
);

INSERT INTO file_versions_next (
  id,
  tenant_id,
  file_id,
  version_num,
  r2_object_key,
  r2_upload_id,
  size_bytes,
  mime_type,
  upload_status,
  uploaded_by,
  comment,
  created_at
)
SELECT
  id,
  tenant_id,
  file_id,
  version_num,
  r2_object_key,
  r2_upload_id,
  size_bytes,
  mime_type,
  upload_status,
  uploaded_by,
  comment,
  created_at
FROM file_versions;

DROP TABLE file_versions;

ALTER TABLE file_versions_next RENAME TO file_versions;

CREATE INDEX idx_file_versions_file
  ON file_versions(file_id, version_num DESC);

CREATE INDEX idx_file_versions_r2_key
  ON file_versions(r2_object_key);

CREATE TABLE workspace_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('copy_subtree')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  total_items INTEGER NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  processed_items INTEGER NOT NULL DEFAULT 0 CHECK (processed_items >= 0),
  target_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  pending_json TEXT,
  error_message TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_workspace_jobs_tenant
  ON workspace_jobs(tenant_id, created_at DESC);
