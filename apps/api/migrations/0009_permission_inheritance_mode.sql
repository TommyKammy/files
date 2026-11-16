-- ============================================================================
-- Migration: 0009_permission_inheritance_mode.sql
-- Purpose:   P9-4 / TOM-54 permission inheritance mode (additive / waterfall).
--
-- `additive`  keeps the historical behavior: direct child grants are composed
--             with every inherited ancestor grant (capability union).
-- `waterfall` makes ancestor grants authoritative: a principal that already
--             inherits access from an ancestor folder can no longer be
--             re-granted or overridden on a descendant. Existing legacy child
--             overrides are preserved and surfaced by the conflict report so an
--             admin can review them; switching modes never deletes grants.
-- ============================================================================

ALTER TABLE tenant_policies
  ADD COLUMN permission_inheritance_mode TEXT NOT NULL DEFAULT 'additive'
    CHECK (permission_inheritance_mode IN ('additive', 'waterfall'));
