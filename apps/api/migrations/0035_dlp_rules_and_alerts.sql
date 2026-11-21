-- Phase 4 Task 7: PII / regex DLP rules and security anomaly alerts.
CREATE TABLE IF NOT EXISTS dlp_rules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('builtin_credit_card','builtin_mynumber','builtin_email_bulk','custom_regex')),
  custom_pattern TEXT,
  action TEXT NOT NULL DEFAULT 'alert' CHECK (action IN ('alert','escalate_confidential')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dlp_rules_tenant ON dlp_rules (tenant_id, enabled);

CREATE TABLE IF NOT EXISTS security_alerts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('dlp_match','bulk_download_anomaly','failed_share_password_spike')),
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  title TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  target_type TEXT,
  target_id TEXT,
  actor_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_security_alerts_tenant
  ON security_alerts (tenant_id, status, created_at DESC);
