-- ============================================================================
-- Migration: 0008_folder_structure_mode.sql
-- Purpose:   P9-3 / TOM-53 open / closed folder structure mode.
--
-- `open`   keeps the historical behavior: any authenticated user may create a
--          new root folder, upload a loose root file, or move/copy/restore into
--          the workspace root.
-- `closed` restricts every root-level creation / placement to `sys_admin`.
--          Existing root folders and their subtrees are never deleted or
--          re-permissioned by switching modes.
-- ============================================================================

ALTER TABLE tenant_policies
  ADD COLUMN folder_structure_mode TEXT NOT NULL DEFAULT 'open'
    CHECK (folder_structure_mode IN ('open', 'closed'));
