import { buildAdminMemberQuery } from '@/lib/admin-users';
import type {
  AdminMemberBulkImportResponse,
  AdminMemberCreateInput,
  AdminMemberDetailResponse,
  AdminMemberListQuery,
  AdminMemberListResponse,
  AdminMemberMutationResponse,
  AdminMemberUpdateInput,
} from '@/types/files';
import { apiFetch } from './core';

/** P11-2 / TOM-64 tenant-admin internal member API client. */

export function fetchAdminMembers(
  query: AdminMemberListQuery = {}
): Promise<AdminMemberListResponse> {
  return apiFetch(`/api/admin/users${buildAdminMemberQuery(query)}`);
}

export function fetchAdminMemberDetail(
  memberId: string
): Promise<AdminMemberDetailResponse> {
  return apiFetch(`/api/admin/users/${encodeURIComponent(memberId)}`);
}

export function createAdminMember(
  input: AdminMemberCreateInput
): Promise<AdminMemberMutationResponse> {
  return apiFetch('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminMember(
  memberId: string,
  input: AdminMemberUpdateInput
): Promise<AdminMemberMutationResponse> {
  return apiFetch(`/api/admin/users/${encodeURIComponent(memberId)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function suspendAdminMember(
  memberId: string,
  options: { idempotencyKey: string }
): Promise<AdminMemberMutationResponse> {
  return apiFetch(
    `/api/admin/users/${encodeURIComponent(memberId)}/suspend`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': options.idempotencyKey },
      body: JSON.stringify({ idempotencyKey: options.idempotencyKey }),
    }
  );
}

export function resumeAdminMember(
  memberId: string,
  options: { idempotencyKey: string }
): Promise<AdminMemberMutationResponse> {
  return apiFetch(
    `/api/admin/users/${encodeURIComponent(memberId)}/resume`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': options.idempotencyKey },
      body: JSON.stringify({ idempotencyKey: options.idempotencyKey }),
    }
  );
}

export function bulkImportAdminMembers(input: {
  csv?: string;
  rows?: Array<Record<string, unknown>>;
  dryRun?: boolean;
  idempotencyKey?: string;
}): Promise<AdminMemberBulkImportResponse> {
  const headers: Record<string, string> = {};
  if (input.idempotencyKey) {
    headers['Idempotency-Key'] = input.idempotencyKey;
  }
  return apiFetch('/api/admin/users/bulk-import', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...(input.csv !== undefined ? { csv: input.csv } : {}),
      ...(input.rows !== undefined ? { rows: input.rows } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    }),
  });
}
