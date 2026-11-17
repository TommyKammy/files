-- P12-1 / TOM-65: tenant-wide admin content manager.
--
-- All listing indexes are partial/covering so admin search never falls back to
-- a full `files` scan even with millions of active files.

CREATE INDEX IF NOT EXISTS idx_files_active_recent
  ON files(tenant_id, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL AND upload_state = 'active';

CREATE INDEX IF NOT EXISTS idx_files_active_creator
  ON files(tenant_id, created_by, updated_at DESC, id DESC)
  WHERE deleted_at IS NULL AND upload_state = 'active';

CREATE INDEX IF NOT EXISTS idx_folders_active_recent
  ON folders(tenant_id, deleted_at, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_shared_links_tenant_active
  ON shared_links(tenant_id, target_type, target_id)
  WHERE revoked_at IS NULL;

-- Admin content inspection policy:
--   disabled               -> no admin content preview at all
--   deny_confidential      -> confidential files can never be inspected
--   watermark_confidential -> allow, force a single-use watermark for confidential
ALTER TABLE tenant_policies
  ADD COLUMN admin_content_inspect_policy TEXT NOT NULL DEFAULT 'watermark_confidential'
  CHECK (admin_content_inspect_policy IN (
    'disabled',
    'deny_confidential',
    'watermark_confidential'
  ));

-- FileLockHub is the source of truth. This shadow table exists only so
-- `lockedOnly` can be answered with an indexed D1 predicate; every result is
-- re-checked against the live Durable Object before it is returned.
CREATE TABLE IF NOT EXISTS active_file_locks (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('wopi_collab', 'desktop_exclusive')),
  lock_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_email TEXT,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_active_file_locks_tenant_exp
  ON active_file_locks(tenant_id, expires_at);
