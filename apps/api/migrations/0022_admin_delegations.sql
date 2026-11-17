-- ============================================================================
-- Migration: 0022_admin_delegations.sql
-- Purpose:   P13-1 / TOM-73 Co-Admin fine-grained capabilities and
--            group / root-folder scoped delegation.
--
-- Design notes:
-- - A delegation is an explicit grant from `sys_admin` to an ordinary internal
--   member. It never changes `users.role`, so every existing role-based guard
--   (offboarding, role changes, SCIM, tenant-wide session revocation, policy
--   writes, delegation management) keeps applying to Co-Admins unchanged.
-- - One active delegation per user (`UNIQUE (tenant_id, user_id)`); PATCH
--   updates the existing row rather than accumulating overlapping grants.
-- - `permissions_json` stores the expanded capability array. The optional
--   `preset` column keeps the UI preset that produced it for compact display;
--   presets are expanded server-side before persistence.
-- - `scope_group_id` and `scope_root_folder_id` are nullable. `NULL` means the
--   delegation is tenant-wide for that dimension. Both scopes must match when
--   both are present (the affected user/item must satisfy both boundaries).
-- - `ON DELETE SET NULL` keeps the delegation valid (but more restrictive)
--   when a group or root folder is removed; `ON DELETE CASCADE` removes the
--   delegation with its tenant or user.
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_delegations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preset TEXT,
  permissions_json TEXT NOT NULL DEFAULT '[]',
  scope_group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
  scope_root_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  note TEXT,
  granted_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_delegations_tenant_user
  ON admin_delegations (tenant_id, user_id);

CREATE INDEX IF NOT EXISTS idx_admin_delegations_tenant_created
  ON admin_delegations (tenant_id, created_at);
