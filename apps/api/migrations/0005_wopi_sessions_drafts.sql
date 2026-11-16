-- Phase 7: WOPI collaborative editing sessions and draft lifecycle.
-- Drafts are intentionally separated from file_versions so Collabora autosave
-- does not consume a formal version number on every PutFile.

CREATE TABLE wopi_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'co_owner', 'editor', 'viewer', 'previewer')),
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
