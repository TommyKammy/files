import { buildAdminGroupQuery } from '@/lib/admin-groups';
import type {
  AdminGroupDetailResponse,
  AdminGroupListQuery,
  AdminGroupListResponse,
  AdminGroupMutationResponse,
} from '@/types/files';
import { apiFetch } from './core';

/** P11-3 / TOM-69 tenant-admin group API client. */

export function fetchAdminGroups(
  query: AdminGroupListQuery = {}
): Promise<AdminGroupListResponse> {
  return apiFetch(`/api/admin/groups${buildAdminGroupQuery(query)}`);
}

export function fetchAdminGroupDetail(
  groupId: string
): Promise<AdminGroupDetailResponse> {
  return apiFetch(`/api/admin/groups/${encodeURIComponent(groupId)}`);
}

export function createAdminGroup(name: string): Promise<AdminGroupMutationResponse> {
  return apiFetch('/api/admin/groups', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function renameAdminGroup(
  groupId: string,
  name: string
): Promise<AdminGroupMutationResponse> {
  return apiFetch(`/api/admin/groups/${encodeURIComponent(groupId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

export function deleteAdminGroup(
  groupId: string
): Promise<AdminGroupMutationResponse> {
  return apiFetch(`/api/admin/groups/${encodeURIComponent(groupId)}`, {
    method: 'DELETE',
  });
}

export function addAdminGroupMembers(
  groupId: string,
  userIds: string[]
): Promise<AdminGroupMutationResponse> {
  return apiFetch(`/api/admin/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'POST',
    body: JSON.stringify({ userIds }),
  });
}

export function removeAdminGroupMember(
  groupId: string,
  userId: string
): Promise<AdminGroupMutationResponse> {
  return apiFetch(
    `/api/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    { method: 'DELETE' }
  );
}
