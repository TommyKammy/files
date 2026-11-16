import type { ResourceRole } from '../../types/api';

export const VALID_TARGET_TYPES = new Set(['folder', 'file']);
export const VALID_GRANTEE_TYPES = new Set(['user', 'group']);
export const VALID_RESOURCE_ROLES = new Set<ResourceRole>([
  'owner',
  'co_owner',
  'editor',
  'viewer_uploader',
  'previewer_uploader',
  'viewer',
  'previewer',
  'uploader',
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
