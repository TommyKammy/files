-- ============================================================================
-- Migration: 0013_external_guests.sql
-- Purpose:   P10-1 / TOM-59 external guest accounts (invitations, email OTP
--            authentication, expiry and role restrictions).
--
-- Design notes:
-- - Guests are ordinary `users` rows with `user_type = 'guest'`. This keeps
--   every existing foreign key (`sessions.user_id`, `files.created_by`,
--   `permissions.granted_by`, ...) valid without a parallel identity table.
-- - Only the SHA-256 hash of an invitation token / OTP is persisted.
-- - `guest_mail_sink` is a local-development / Vitest-only delivery sink. The
--   read endpoint (`/auth/dev-guest-mails`) is guarded by
--   `isLocalDevBypassAllowed` and returns 404 everywhere else.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN user_type TEXT NOT NULL DEFAULT 'member'
    CHECK (user_type IN ('member', 'guest'));

ALTER TABLE users ADD COLUMN external_org TEXT;
ALTER TABLE users ADD COLUMN invited_by TEXT;
ALTER TABLE users ADD COLUMN expires_at TEXT;
ALTER TABLE users ADD COLUMN last_login_at TEXT;

CREATE INDEX idx_users_tenant_type
  ON users(tenant_id, user_type);

CREATE INDEX idx_users_guest_expiry
  ON users(tenant_id, expires_at)
  WHERE user_type = 'guest';

CREATE TABLE guest_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  external_org TEXT,
  invited_by TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK (target_type IN ('folder', 'file')),
  target_id TEXT NOT NULL,
  role TEXT NOT NULL
    CHECK (role IN ('editor', 'viewer_uploader', 'previewer_uploader',
                    'viewer', 'previewer', 'uploader')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  resend_count INTEGER NOT NULL DEFAULT 0 CHECK (resend_count >= 0),
  last_sent_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_guest_invitations_tenant_status
  ON guest_invitations(tenant_id, status, created_at DESC);

CREATE INDEX idx_guest_invitations_target
  ON guest_invitations(tenant_id, target_type, target_id);

CREATE INDEX idx_guest_invitations_user
  ON guest_invitations(user_id);

CREATE INDEX idx_guest_invitations_expires
  ON guest_invitations(status, expires_at);

CREATE TABLE guest_otp_challenges (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('accept', 'login')),
  expires_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_guest_otp_challenges_lookup
  ON guest_otp_challenges(tenant_id, email, created_at DESC);

CREATE INDEX idx_guest_otp_challenges_expires
  ON guest_otp_challenges(expires_at);

-- Local development / Playwright / Vitest-only email sink. Production sends
-- through the configured HTTP webhook instead.
CREATE TABLE guest_mail_sink (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('guest_invitation', 'guest_otp')),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  token TEXT,
  otp_code TEXT,
  accept_url TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_guest_mail_sink_tenant_time
  ON guest_mail_sink(tenant_id, created_at DESC);

ALTER TABLE tenant_policies
  ADD COLUMN allow_external_collaborators INTEGER NOT NULL DEFAULT 0
    CHECK (allow_external_collaborators IN (0, 1));

ALTER TABLE tenant_policies
  ADD COLUMN external_domain_allowlist_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE tenant_policies
  ADD COLUMN guest_invitation_expiry_days INTEGER NOT NULL DEFAULT 14
    CHECK (guest_invitation_expiry_days >= 1 AND guest_invitation_expiry_days <= 365);

ALTER TABLE tenant_policies
  ADD COLUMN guest_session_max_hours INTEGER NOT NULL DEFAULT 24
    CHECK (guest_session_max_hours >= 1 AND guest_session_max_hours <= 168);

ALTER TABLE tenant_policies
  ADD COLUMN allow_guest_elevated_roles INTEGER NOT NULL DEFAULT 0
    CHECK (allow_guest_elevated_roles IN (0, 1));
