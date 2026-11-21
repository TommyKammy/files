-- User Collections (favorite categorization)

CREATE TABLE IF NOT EXISTS user_collections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'slate',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, user_id, name)
);

CREATE TABLE IF NOT EXISTS user_collection_items (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('file','folder')),
  item_id TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id, collection_id, item_type, item_id)
);

CREATE INDEX IF NOT EXISTS idx_user_collection_items_col
  ON user_collection_items (tenant_id, user_id, collection_id, added_at DESC);
