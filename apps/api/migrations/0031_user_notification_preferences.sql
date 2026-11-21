CREATE TABLE IF NOT EXISTS user_notification_preferences (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  email_on_mention INTEGER NOT NULL DEFAULT 1,
  email_on_task_assigned INTEGER NOT NULL DEFAULT 1,
  email_on_task_resolved INTEGER NOT NULL DEFAULT 1,
  email_on_share_granted INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, user_id)
);

-- Allow 'notification' kind in local dev / test mail sink alongside guest kinds.
CREATE TABLE guest_mail_sink_new (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('guest_invitation', 'guest_otp', 'notification')),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  token TEXT,
  otp_code TEXT,
  accept_url TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO guest_mail_sink_new (
  id, tenant_id, kind, to_email, subject, body_text, token, otp_code, accept_url, created_at
)
SELECT id, tenant_id, kind, to_email, subject, body_text, token, otp_code, accept_url, created_at
FROM guest_mail_sink;

DROP TABLE guest_mail_sink;
ALTER TABLE guest_mail_sink_new RENAME TO guest_mail_sink;

CREATE INDEX idx_guest_mail_sink_tenant_time
  ON guest_mail_sink(tenant_id, created_at DESC);
