-- ============================================================================
-- Migration: 0010_invite_policy.sql
-- Purpose:   P9-5 / TOM-58 folder-aware invitation policy.
--
-- The tenant policy defaults to `owners` (owners and co-owners may invite).
-- `editors` additionally lets editors invite collaborators, while `admins`
-- restricts invitations to sys_admin accounts that also hold folder access.
-- A folder may only tighten its effective policy: child overrides cannot relax
-- a stricter tenant or ancestor policy.
-- ============================================================================

ALTER TABLE tenant_policies
  ADD COLUMN invite_policy TEXT NOT NULL DEFAULT 'owners'
    CHECK (invite_policy IN ('owners', 'editors', 'admins'));

ALTER TABLE folders
  ADD COLUMN invite_policy TEXT NULL
    CHECK (invite_policy IN ('owners', 'editors', 'admins'));
