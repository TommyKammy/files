-- Item 11: Tags and Custom Metadata Templates

CREATE TABLE IF NOT EXISTS item_tags (
  tenant_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('file','folder')),
  item_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, item_type, item_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_item_tags_tenant_tag
  ON item_tags (tenant_id, tag);

CREATE TABLE IF NOT EXISTS metadata_templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  description TEXT,
  fields_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS item_metadata_values (
  tenant_id TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('file','folder')),
  item_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  values_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, item_type, item_id, template_id)
);
