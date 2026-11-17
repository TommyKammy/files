-- ============================================================================
-- Migration: 0017_admin_sessions_index.sql
-- Purpose:   P12-2 / TOM-71 active-session monitoring and forced sign-out.
--
-- Design notes:
-- - The admin session console lists only live sessions of a single tenant:
--   `revoked_at IS NULL AND expires_at > now`. Keyset pagination orders by
--   `created_at DESC, id DESC`, so the composite index mirrors that access
--   path instead of scanning every historical session row.
-- - `user_id` narrows the same index for the member detail drawer. The
--   existing `idx_sessions_user` remains the hot path for revocation writes.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_sessions_tenant_active
  ON sessions(tenant_id, revoked_at, expires_at, created_at DESC, id DESC);
