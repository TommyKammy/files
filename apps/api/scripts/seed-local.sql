-- Local development seed for Files (idempotent)
INSERT OR IGNORE INTO tenants (id, name, slug)
VALUES ('tenant-default', 'Files Local Dev Organization', 'default');

INSERT OR IGNORE INTO tenant_policies (
  tenant_id,
  enforce_company_only_links,
  require_watermark_confidential,
  max_link_expiration_days,
  session_max_hours,
  trash_retention_days,
  ai_classification_mode,
  ai_auto_apply_threshold
) VALUES (
  'tenant-default',
  0,
  1,
  30,
  12,
  30,
  'metadata_only',
  0.90
);

INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, department, role, status)
VALUES
  ('dev-admin-001', 'tenant-default', 'dev-admin@example.com', 'Dev Admin', 'IT Security', 'sys_admin', 'active'),
  ('dev-sec-001', 'tenant-default', 'dev-sec@example.com', 'Security Officer', 'Security', 'sec_admin', 'active'),
  ('dev-member-001', 'tenant-default', 'dev-member@example.com', 'Dev Member', 'Engineering', 'member', 'active');

INSERT OR IGNORE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
VALUES
  ('tenant-default', 'unset', 0, 0),
  ('tenant-default', 'confidential', 0, 0),
  ('tenant-default', 'internal', 0, 0),
  ('tenant-default', 'public', 0, 0);

INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
VALUES
  ('folder-root-general', 'tenant-default', NULL, '全社共有', 0, 1, 'internal', 'dev-admin-001'),
  ('folder-root-confidential', 'tenant-default', NULL, '機密プロジェクト', 0, 1, 'confidential', 'dev-admin-001');

INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
VALUES
  ('tenant-default', 'folder-root-general', 'folder-root-general', 0),
  ('tenant-default', 'folder-root-confidential', 'folder-root-confidential', 0);

INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
VALUES
  ('perm-seed-general-admin', 'tenant-default', 'folder', 'folder-root-general', 'user', 'dev-admin-001', 'owner', 'dev-admin-001'),
  ('perm-seed-general-member', 'tenant-default', 'folder', 'folder-root-general', 'user', 'dev-member-001', 'editor', 'dev-admin-001'),
  ('perm-seed-conf-admin', 'tenant-default', 'folder', 'folder-root-confidential', 'user', 'dev-admin-001', 'owner', 'dev-admin-001');

INSERT OR IGNORE INTO groups (id, tenant_id, name)
VALUES ('group-e2e-collaborators', 'tenant-default', 'E2E Collaborators');

-- E2E-only SCIM bearer token (raw token: dev-e2e-scim-token). It is scoped to
-- the local dev tenant so Playwright can provision suspended-owner fixtures
-- without touching the interactive :8787 state.
INSERT OR IGNORE INTO scim_tokens (id, tenant_id, idp_issuer, name, token_hash, revoked_at)
VALUES (
  'scim-dev-e2e',
  'tenant-default',
  'dev-e2e',
  'E2E SCIM',
  '6ed4d37c5b07e5f2cb9043b23f4194ef9f663afebc7d2bd3c144f9568a40465b',
  NULL
);

INSERT OR IGNORE INTO group_members (group_id, user_id)
VALUES ('group-e2e-collaborators', 'dev-member-001');
