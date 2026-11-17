-- ============================================================================
-- Migration: 0018_ip_allowlist_and_sso.sql
-- Purpose:   P12-3 / TOM-66 IP allowlist & OIDC SSO authentication controls.
--
-- Design notes:
-- - The allowlist is stored as a JSON array of canonical IPv4/IPv6 addresses or
--   CIDRs. D1 cannot index individual entries, and the list is capped at 200
--   entries so a single tenant policy read stays tiny.
-- - `ip_allowlist_scope` widens enforcement in three steps:
--     admin_only       -> admin routes/audit logs and admin-role sessions only
--     internal_users   -> plus every member session and interactive login
--     all_access       -> plus guest sessions, guest auth and public share links
-- - `require_sso_login` blocks the local development bypass and raw
--   `X-Dev-User-Id` authentication, while existing D1 sessions and guest auth
--   remain usable (fail-safe so an administrator can always sign out).
-- - `sso_allowed_domains_json` is an exact-match email domain allowlist. An
--   empty list keeps the historical behaviour (any IdP-verified domain).
-- ============================================================================

ALTER TABLE tenant_policies
  ADD COLUMN ip_allowlist_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (ip_allowlist_enabled IN (0, 1));

ALTER TABLE tenant_policies
  ADD COLUMN ip_allowlist_scope TEXT NOT NULL DEFAULT 'admin_only'
    CHECK (ip_allowlist_scope IN ('admin_only', 'internal_users', 'all_access'));

ALTER TABLE tenant_policies
  ADD COLUMN ip_allowlist_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE tenant_policies
  ADD COLUMN require_sso_login INTEGER NOT NULL DEFAULT 0
    CHECK (require_sso_login IN (0, 1));

ALTER TABLE tenant_policies
  ADD COLUMN sso_allowed_domains_json TEXT NOT NULL DEFAULT '[]';
