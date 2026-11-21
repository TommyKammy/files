CREATE TABLE IF NOT EXISTS item_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('file','folder')),
  item_id TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  assignee_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','completed')),
  due_at TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_item_tasks_target
  ON item_tasks (tenant_id, item_type, item_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_item_tasks_assignee
  ON item_tasks (tenant_id, assignee_id, status, due_at);

CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('mention','task_assigned','task_resolved','share_granted')),
  title TEXT NOT NULL,
  body TEXT,
  target_type TEXT,
  target_id TEXT,
  actor_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_inbox
  ON user_notifications (tenant_id, user_id, read_at, created_at DESC);
