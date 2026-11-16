-- ============================================================================
-- Migration: 0007_capability_8_roles.sql
-- Purpose:   P9-1 / TOM-52 capability model with eight resource roles.
--
--   1. Expand `permissions.role` CHECK from 5 to 8 roles. The table is rebuilt
--      because SQLite cannot alter a CHECK constraint in place. All existing
--      rows (owner/co_owner/editor/viewer/previewer) are copied verbatim and
--      both lookup indexes are recreated.
--   2. Expand `wopi_sessions.role` CHECK to the same 8 roles. `wopi_drafts`
--      has a foreign key to `wopi_sessions(id)`, so both tables are rebuilt
--      with a rename -> recreate -> copy -> drop sequence. Draft rows, their
--      FK target (`wopi_sessions.id`) and all indexes are preserved.
--   3. Add `tenant_policies.advanced_roles_enabled` (default 0 / false).
--      Advanced roles (uploader, viewer_uploader, previewer_uploader) are
--      folder-only and cannot be granted while this flag is 0.
--
-- No table outside these three is touched.
-- ============================================================================

-- 1. permissions: 5 -> 8 roles -------------------------------------------------
CREATE TABLE permissions_0007_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('folder', 'file')),
  target_id TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user', 'group')),
  grantee_id TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'co_owner', 'editor', 'viewer', 'previewer',
                    'uploader', 'viewer_uploader', 'previewer_uploader')),
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (target_type, target_id, grantee_type, grantee_id)
);

INSERT INTO permissions_0007_new (
  id, tenant_id, target_type, target_id, grantee_type, grantee_id, role,
  granted_by, created_at
)
SELECT
  id, tenant_id, target_type, target_id, grantee_type, grantee_id, role,
  granted_by, created_at
FROM permissions;

DROP TABLE permissions;

ALTER TABLE permissions_0007_new RENAME TO permissions;

CREATE INDEX idx_permissions_target
  ON permissions(tenant_id, target_type, target_id);

CREATE INDEX idx_permissions_grantee
  ON permissions(tenant_id, grantee_type, grantee_id);

-- 2. wopi_sessions + wopi_drafts: 5 -> 8 roles --------------------------------
-- `wopi_drafts.session_id` references `wopi_sessions(id)`. Renaming the parent
-- first rewrites that FK to the temporary name, so the child is renamed too and
-- both tables are recreated with the same columns in the same order before the
-- data is copied back. Old tables are dropped child-first.
ALTER TABLE wopi_sessions RENAME TO wopi_sessions_0007_old;
ALTER TABLE wopi_drafts RENAME TO wopi_drafts_0007_old;

DROP INDEX IF EXISTS idx_wopi_sessions_file_active;
DROP INDEX IF EXISTS idx_wopi_sessions_expiry;
DROP INDEX IF EXISTS idx_wopi_drafts_file_active;
DROP INDEX IF EXISTS idx_wopi_drafts_expiry;
DROP INDEX IF EXISTS idx_wopi_drafts_session;

CREATE TABLE wopi_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'co_owner', 'editor', 'viewer', 'previewer',
                    'uploader', 'viewer_uploader', 'previewer_uploader')),
  can_write INTEGER NOT NULL DEFAULT 0 CHECK (can_write IN (0, 1)),
  access_token_hash TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);

CREATE INDEX idx_wopi_sessions_file_active
  ON wopi_sessions(tenant_id, file_id, is_active, expires_at);

CREATE INDEX idx_wopi_sessions_expiry
  ON wopi_sessions(expires_at)
  WHERE is_active = 1;

CREATE TABLE wopi_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES wopi_sessions(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  r2_object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,
  last_saved_by TEXT NOT NULL REFERENCES users(id),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  promoted_at TEXT,
  promoted_version_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_wopi_drafts_file_active
  ON wopi_drafts(tenant_id, file_id, is_active, updated_at DESC);

CREATE INDEX idx_wopi_drafts_expiry
  ON wopi_drafts(expires_at)
  WHERE promoted_at IS NULL;

CREATE INDEX idx_wopi_drafts_session
  ON wopi_drafts(session_id, is_active, updated_at DESC);

INSERT INTO wopi_sessions (
  id, tenant_id, file_id, user_id, role, can_write, access_token_hash,
  is_active, expires_at, created_at, revoked_at
)
SELECT
  id, tenant_id, file_id, user_id, role, can_write, access_token_hash,
  is_active, expires_at, created_at, revoked_at
FROM wopi_sessions_0007_old;

INSERT INTO wopi_drafts (
  id, session_id, tenant_id, file_id, r2_object_key, size_bytes, mime_type,
  last_saved_by, is_active, promoted_at, promoted_version_id, expires_at,
  created_at, updated_at
)
SELECT
  id, session_id, tenant_id, file_id, r2_object_key, size_bytes, mime_type,
  last_saved_by, is_active, promoted_at, promoted_version_id, expires_at,
  created_at, updated_at
FROM wopi_drafts_0007_old;

DROP TABLE wopi_drafts_0007_old;
DROP TABLE wopi_sessions_0007_old;

-- 3. tenant policy gate for advanced roles ------------------------------------
ALTER TABLE tenant_policies
  ADD COLUMN advanced_roles_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (advanced_roles_enabled IN (0, 1));
