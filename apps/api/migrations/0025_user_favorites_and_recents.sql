-- User favorites (starred files and folders) and recent item access history.

CREATE TABLE IF NOT EXISTS user_favorites (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('file', 'folder')),
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_user_favorites_user_created
  ON user_favorites (tenant_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_recent_items (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('file', 'folder')),
  item_id TEXT NOT NULL,
  last_action TEXT NOT NULL DEFAULT 'view',
  accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_user_recent_items_user_accessed
  ON user_recent_items (tenant_id, user_id, accessed_at DESC);
