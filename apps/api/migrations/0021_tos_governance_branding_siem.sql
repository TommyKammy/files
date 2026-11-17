-- ============================================================================
-- Migration: 0021_tos_governance_branding_siem.sql
-- Purpose:   P13-4 / TOM-72 custom Terms of Service acceptance, tenant-wide
--            file-request governance, branding projection, SIEM webhook and
--            quota warning thresholds.
--
-- Design notes:
-- - `tenant_tos_policies` is a single row per tenant. Version starts at 1 and
--   is incremented when an active policy body/title changes or an administrator
--   explicitly requests `bumpVersion`, forcing every targeted user to accept
--   the new revision.
-- - `user_tos_acceptances` is append-only history: the UNIQUE key makes
--   acceptance idempotent per (tenant, user, version) while older accepted
--   versions remain available for audit.
-- - File-request governance lives in `tenant_policies` so the existing policy
--   PATCH endpoint remains the single administrative write path.
-- - Branding columns are nullable plain text. Consumers render them as React
--   text nodes (never raw HTML) so no markup is persisted or interpreted.
-- - The SIEM shared secret is stored encrypted by the Worker (AES-GCM) in
--   `siem_webhook_secret_encrypted`; it is never returned by the API.
-- - Quota thresholds use CHECK constraints and a strict warn < critical pair.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_tos_policies (
  tenant_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  target_audience TEXT NOT NULL DEFAULT 'all_users'
    CHECK (target_audience IN ('all_users', 'guests_only', 'members_only')),
  title TEXT NOT NULL DEFAULT '利用規約',
  body_markdown TEXT NOT NULL DEFAULT '',
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_tos_acceptances (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  accepted_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  UNIQUE (tenant_id, user_id, version)
);

CREATE INDEX IF NOT EXISTS idx_user_tos_acceptances_tenant_user
  ON user_tos_acceptances (tenant_id, user_id, version);

CREATE INDEX IF NOT EXISTS idx_user_tos_acceptances_tenant_accepted
  ON user_tos_acceptances (tenant_id, accepted_at);

ALTER TABLE tenant_policies
  ADD COLUMN allow_file_requests INTEGER NOT NULL DEFAULT 1
    CHECK (allow_file_requests IN (0, 1));

ALTER TABLE tenant_policies
  ADD COLUMN file_request_max_size_bytes INTEGER NOT NULL DEFAULT 104857600
    CHECK (file_request_max_size_bytes >= 1);

ALTER TABLE tenant_policies
  ADD COLUMN file_request_enforce_allowed_extensions INTEGER NOT NULL DEFAULT 0
    CHECK (file_request_enforce_allowed_extensions IN (0, 1));

ALTER TABLE tenant_policies ADD COLUMN branding_org_name TEXT;
ALTER TABLE tenant_policies ADD COLUMN branding_contact_info TEXT;
ALTER TABLE tenant_policies ADD COLUMN branding_footer_note TEXT;

ALTER TABLE tenant_policies
  ADD COLUMN siem_webhook_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (siem_webhook_enabled IN (0, 1));

ALTER TABLE tenant_policies ADD COLUMN siem_webhook_url TEXT;
ALTER TABLE tenant_policies ADD COLUMN siem_webhook_secret_encrypted TEXT;
ALTER TABLE tenant_policies
  ADD COLUMN siem_events_json TEXT NOT NULL
    DEFAULT '["security_blocked","admin_mutation"]';

ALTER TABLE tenant_policies
  ADD COLUMN quota_warn_threshold_pct INTEGER NOT NULL DEFAULT 80
    CHECK (quota_warn_threshold_pct BETWEEN 50 AND 99);

ALTER TABLE tenant_policies
  ADD COLUMN quota_critical_threshold_pct INTEGER NOT NULL DEFAULT 90
    CHECK (quota_critical_threshold_pct BETWEEN 51 AND 100);
