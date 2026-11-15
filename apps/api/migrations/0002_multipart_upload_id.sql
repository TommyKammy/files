-- Migration: 0002_multipart_upload_id.sql
ALTER TABLE file_versions ADD COLUMN r2_upload_id TEXT;
