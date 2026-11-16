-- TOM-56: shared-link permission levels (view / download / edit), edit-link
-- governance policies, and single-use preview stream tokens.

ALTER TABLE shared_links
  ADD COLUMN permission_level TEXT NOT NULL DEFAULT 'download'
  CHECK (permission_level IN ('view', 'download', 'edit'));

-- Backfill existing links from the legacy boolean: preview-only -> view,
-- download-capable -> download.
UPDATE shared_links
   SET permission_level = CASE WHEN can_download = 0 THEN 'view' ELSE 'download' END;

ALTER TABLE tenant_policies
  ADD COLUMN allow_shared_link_edit INTEGER NOT NULL DEFAULT 0
  CHECK (allow_shared_link_edit IN (0, 1));

ALTER TABLE tenant_policies
  ADD COLUMN allow_public_edit_links INTEGER NOT NULL DEFAULT 0
  CHECK (allow_public_edit_links IN (0, 1));

ALTER TABLE tenant_policies
  ADD COLUMN allow_viewer_share_links INTEGER NOT NULL DEFAULT 0
  CHECK (allow_viewer_share_links IN (0, 1));

-- Single-use nonces behind `/api/storage/preview-stream`. The signed token
-- itself is stateless; D1 deletion makes each nonce consumable exactly once.
CREATE TABLE IF NOT EXISTS preview_stream_tokens (
  nonce TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_preview_stream_tokens_expires
  ON preview_stream_tokens(expires_at);
