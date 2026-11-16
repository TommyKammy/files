-- ============================================================================
-- Migration: 0014_guest_lifecycle_governance.sql
-- Purpose:   P10-3 / TOM-61 guest lifecycle governance.
--
-- Design notes:
-- - Offboarding is a logical deactivation, never a physical `users` delete:
--   `files.created_by`, `permissions.granted_by` and every other
--   `REFERENCES users(id)` foreign key stay valid. Login/resume are blocked by
--   `status = 'suspended'` plus `offboarded_at`.
-- - `expiring_notified_at` makes the 72h expiry reminder in the daily cron
--   idempotent so a retried Cron invocation cannot spam the guest.
-- - Removing a domain from the allowlist must have a deliberate, tenant-wide
--   policy for guests that already use the removed domain. The default keeps
--   the historical behaviour (reject new invitations only).
-- ============================================================================

ALTER TABLE users ADD COLUMN offboarded_at TEXT;
ALTER TABLE users ADD COLUMN offboarded_by TEXT;
ALTER TABLE users ADD COLUMN expiring_notified_at TEXT;

CREATE INDEX idx_users_guest_offboarded
  ON users(tenant_id, offboarded_at)
  WHERE user_type = 'guest';

ALTER TABLE tenant_policies
  ADD COLUMN external_domain_existing_guest_mode TEXT NOT NULL
    DEFAULT 'reject_new_only'
    CHECK (external_domain_existing_guest_mode IN
      ('reject_new_only', 'suspend_existing'));
