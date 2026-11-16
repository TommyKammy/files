import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../../middleware/session-auth';
import { buildAuditLogStmt } from '../../services/audit';
import {
  countEffectiveOwners,
  getAuthenticatedUser,
  hasAtLeastRole,
  resolveTargetAccess,
} from '../../services/authorization';
import { buildSyncChangeStmt } from '../../services/sync-changes';
import { emitTenantSyncSignal, extractLastSyncSeq } from '../../services/sync-notifier';
import type { ResourceRole } from '../../types/api';
import type { OidcHonoEnv } from '../../types/oidc';

export const VALID_TARGET_TYPES = new Set(['folder', 'file']);
export const VALID_GRANTEE_TYPES = new Set(['user', 'group']);
export const VALID_RESOURCE_ROLES = new Set<ResourceRole>([
  'owner',
  'co_owner',
  'editor',
  'viewer',
  'previewer',
]);

export interface PermissionListRow {
  id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  grantee_type: 'user' | 'group';
  grantee_id: string;
  role: ResourceRole;
  granted_by: string;
  created_at: string;
  grantee_name: string | null;
  grantee_email: string | null;
  source_name: string | null;
  is_inherited: number;
}

