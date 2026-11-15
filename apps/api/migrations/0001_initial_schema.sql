-- ============================================================================
-- Files Initial Schema for Cloudflare D1 (SQLite)
-- Migration: 0001_initial_schema.sql
-- ============================================================================

-- 1. テナント・ガバナンスポリシー
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  storage_quota_bytes INTEGER NOT NULL DEFAULT 109951162777600 CHECK (storage_quota_bytes > 0), -- 100 TiB
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE tenant_policies (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enforce_company_only_links INTEGER NOT NULL DEFAULT 0 CHECK (enforce_company_only_links IN (0, 1)),
  require_watermark_confidential INTEGER NOT NULL DEFAULT 1 CHECK (require_watermark_confidential IN (0, 1)),
  max_link_expiration_days INTEGER NOT NULL DEFAULT 30 CHECK (max_link_expiration_days >= 1),
  session_max_hours INTEGER NOT NULL DEFAULT 12 CHECK (session_max_hours >= 1 AND session_max_hours <= 168),
  trash_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (trash_retention_days >= 1 AND trash_retention_days <= 365),
  ai_classification_mode TEXT NOT NULL DEFAULT 'metadata_only'
    CHECK (ai_classification_mode IN ('disabled', 'metadata_only', 'content_excerpt')),
  ai_auto_apply_threshold REAL
    CHECK (ai_auto_apply_threshold IS NULL OR (ai_auto_apply_threshold >= 0.5 AND ai_auto_apply_threshold <= 1.0)),
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 2. ユーザー・グループ・セッション・SCIMトークン（Okta / Entra ID SSO・SCIM対応）
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idp_issuer TEXT,
  external_idp_id TEXT,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  department TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('sys_admin', 'sec_admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, email)
);

-- (tenant_id, idp_issuer, external_idp_id) で IdP 主体の一意性を担保（nOAuth対策）
CREATE UNIQUE INDEX uq_users_tenant_idp
  ON users(tenant_id, idp_issuer, external_idp_id)
  WHERE external_idp_id IS NOT NULL;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE scim_tokens (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  idp_issuer TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_scim_tokens_tenant ON scim_tokens(tenant_id) WHERE revoked_at IS NULL;

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_idp_id TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (tenant_id, name)
);

CREATE UNIQUE INDEX uq_groups_tenant_idp
  ON groups(tenant_id, external_idp_id)
  WHERE external_idp_id IS NOT NULL;

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_group_members_user ON group_members(user_id, group_id);

-- 3. フォルダ階層・閉包テーブル（Closure Table）
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0 AND depth <= 20),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  classification TEXT NOT NULL DEFAULT 'unset'
    CHECK (classification IN ('unset', 'confidential', 'internal', 'public')),
  is_pinned INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_folders_keyset
  ON folders(tenant_id, parent_id, deleted_at, name, id);

CREATE UNIQUE INDEX uq_folders_active_name
  ON folders(tenant_id, COALESCE(parent_id, '__ROOT__'), name)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_folders_trash_purge
  ON folders(tenant_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE folder_closures (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ancestor_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  descendant_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL CHECK (depth >= 0),
  PRIMARY KEY (ancestor_id, descendant_id)
);

CREATE INDEX idx_folder_closures_descendant
  ON folder_closures(tenant_id, descendant_id, depth);

-- 4. ファイルメタデータ・AI機密区分提案・バージョン管理・O(1)容量集計・FTS5
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  extension TEXT,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  upload_state TEXT NOT NULL DEFAULT 'active'
    CHECK (upload_state IN ('pending', 'active', 'failed')),
  current_version_id TEXT,
  current_version_num INTEGER NOT NULL DEFAULT 1 CHECK (current_version_num >= 1),
  classification TEXT NOT NULL DEFAULT 'unset'
    CHECK (classification IN ('unset', 'confidential', 'internal', 'public')),
  ai_suggested_label TEXT
    CHECK (ai_suggested_label IS NULL OR ai_suggested_label IN ('confidential', 'internal', 'public')),
  ai_confidence REAL
    CHECK (ai_confidence IS NULL OR (ai_confidence >= 0.0 AND ai_confidence <= 1.0)),
  ai_reason TEXT,
  ai_evaluated_at TEXT,
  classification_updated_by TEXT,
  classification_updated_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  updated_by TEXT NOT NULL REFERENCES users(id),
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_files_keyset
  ON files(tenant_id, folder_id, deleted_at, name, id)
  WHERE upload_state = 'active';

CREATE UNIQUE INDEX uq_files_active_name
  ON files(tenant_id, COALESCE(folder_id, '__ROOT__'), name)
  WHERE deleted_at IS NULL AND upload_state = 'active';

CREATE INDEX idx_files_classification
  ON files(tenant_id, classification, deleted_at, updated_at DESC)
  WHERE upload_state = 'active';

CREATE INDEX idx_files_ai_suggestion_queue
  ON files(tenant_id, ai_confidence DESC, created_at DESC)
  WHERE deleted_at IS NULL AND upload_state = 'active' AND classification = 'unset' AND ai_suggested_label IS NOT NULL;

CREATE INDEX idx_files_pending_cleanup
  ON files(upload_state, created_at)
  WHERE upload_state = 'pending';

CREATE INDEX idx_files_trash_purge
  ON files(tenant_id, deleted_at)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE file_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_num INTEGER NOT NULL CHECK (version_num >= 1),
  r2_object_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,
  upload_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (upload_status IN ('pending', 'completed', 'failed')),
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (file_id, version_num)
);

CREATE INDEX idx_file_versions_file
  ON file_versions(file_id, version_num DESC);

-- O(1) テナント機密区分別容量・ファイル数集計（最大4行/テナント）
CREATE TABLE tenant_storage_stats (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  classification TEXT NOT NULL
    CHECK (classification IN ('unset', 'confidential', 'internal', 'public')),
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (tenant_id, classification)
);

-- ⌘K 横断検索用 FTS5 仮想テーブル（アクティブファイルのみアプリ層から同期）
CREATE VIRTUAL TABLE files_fts USING fts5(
  file_id UNINDEXED,
  tenant_id UNINDEXED,
  classification,
  name,
  extension,
  ai_reason,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 5. RBAC アクセス権限
CREATE TABLE permissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('folder', 'file')),
  target_id TEXT NOT NULL,
  grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user', 'group')),
  grantee_id TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('owner', 'co_owner', 'editor', 'viewer', 'previewer')),
  granted_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (target_type, target_id, grantee_type, grantee_id)
);

CREATE INDEX idx_permissions_target
  ON permissions(tenant_id, target_type, target_id);

CREATE INDEX idx_permissions_grantee
  ON permissions(tenant_id, grantee_type, grantee_id);

-- 6. 共有リンク統制
CREATE TABLE shared_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK (target_type IN ('folder', 'file')),
  target_id TEXT NOT NULL,
  access_scope TEXT NOT NULL DEFAULT 'company_only'
    CHECK (access_scope IN ('public', 'company_only', 'collaborators_only')),
  can_download INTEGER NOT NULL DEFAULT 1 CHECK (can_download IN (0, 1)),
  require_watermark INTEGER NOT NULL DEFAULT 0 CHECK (require_watermark IN (0, 1)),
  password_hash TEXT,
  failed_password_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_password_attempts >= 0),
  locked_until TEXT,
  expires_at TEXT,
  max_downloads INTEGER CHECK (max_downloads IS NULL OR max_downloads >= 1),
  download_count INTEGER NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  revoked_at TEXT,
  revoked_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_shared_links_target
  ON shared_links(tenant_id, target_type, target_id)
  WHERE revoked_at IS NULL;

-- 7. ファイルリクエスト（外部提出専用ブラインドドロップボックス）
CREATE TABLE file_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  require_submitter_email INTEGER NOT NULL DEFAULT 1 CHECK (require_submitter_email IN (0, 1)),
  max_file_size_bytes INTEGER NOT NULL DEFAULT 104857600 CHECK (max_file_size_bytes > 0), -- default 100 MiB
  allowed_extensions TEXT, -- NULL (default safe list) or JSON array string e.g. '["pdf","png"]'
  submission_count INTEGER NOT NULL DEFAULT 0 CHECK (submission_count >= 0),
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_file_requests_folder
  ON file_requests(tenant_id, folder_id)
  WHERE is_active = 1;

-- 8. 監査ログ
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  actor_id TEXT,
  actor_email TEXT,
  actor_ip TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  classification_snapshot TEXT,
  status TEXT NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed', 'blocked')),
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_audit_logs_tenant_time
  ON audit_logs(tenant_id, created_at DESC, id);

CREATE INDEX idx_audit_logs_blocked
  ON audit_logs(tenant_id, status, created_at DESC)
  WHERE status = 'blocked';
