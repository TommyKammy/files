-- Legal Holds & Retention Policies (Phase 4 Task 5)

CREATE TABLE IF NOT EXISTS legal_holds (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  reason TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('folder','file','user')),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  created_by TEXT NOT NULL,
  released_by TEXT,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_legal_holds_target
  ON legal_holds (tenant_id, status, target_type, target_id);

CREATE TABLE IF NOT EXISTS retention_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('folder','classification')),
  target_value TEXT NOT NULL,
  retention_days INTEGER NOT NULL CHECK (retention_days >= 1 AND retention_days <= 3650),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_retention_policies_tenant_enabled
  ON retention_policies (tenant_id, enabled, target_type, target_value);
