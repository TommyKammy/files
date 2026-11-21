CREATE TABLE IF NOT EXISTS item_comments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('file', 'folder')),
  item_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_item_comments_target
  ON item_comments (tenant_id, item_type, item_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_target_time
  ON audit_logs (tenant_id, target_type, target_id, created_at DESC);
