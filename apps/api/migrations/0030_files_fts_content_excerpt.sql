-- Add nullable content_excerpt column to files for OOXML and plain-text full-text search
ALTER TABLE files ADD COLUMN content_excerpt TEXT;

-- Recreate files_fts virtual table to include content_excerpt
DROP TABLE IF EXISTS files_fts;

CREATE VIRTUAL TABLE files_fts USING fts5(
  file_id UNINDEXED,
  tenant_id UNINDEXED,
  classification,
  name,
  extension,
  ai_reason,
  content_excerpt,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Repopulate active non-deleted files into files_fts
INSERT INTO files_fts (
  file_id,
  tenant_id,
  classification,
  name,
  extension,
  ai_reason,
  content_excerpt
)
SELECT
  id,
  tenant_id,
  classification,
  name,
  COALESCE(extension, ''),
  COALESCE(ai_reason, ''),
  COALESCE(content_excerpt, '')
FROM files
WHERE deleted_at IS NULL
  AND upload_state = 'active';
