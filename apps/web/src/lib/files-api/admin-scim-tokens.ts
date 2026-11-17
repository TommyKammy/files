import type {
  AdminScimTokenCreateInput,
  AdminScimTokenListResponse,
  AdminScimTokenMutationResponse,
} from '@/types/files';
import { apiFetch } from './core';

/** P11-3 / TOM-69 tenant-admin SCIM bearer token API client. */

export function fetchAdminScimTokens(): Promise<AdminScimTokenListResponse> {
  return apiFetch('/api/admin/scim-tokens');
}

export function createAdminScimToken(
  input: AdminScimTokenCreateInput
): Promise<AdminScimTokenMutationResponse> {
  return apiFetch('/api/admin/scim-tokens', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function rotateAdminScimToken(
  tokenId: string
): Promise<AdminScimTokenMutationResponse> {
  return apiFetch(
    `/api/admin/scim-tokens/${encodeURIComponent(tokenId)}/rotate`,
    { method: 'POST' }
  );
}

export function revokeAdminScimToken(
  tokenId: string
): Promise<AdminScimTokenMutationResponse> {
  return apiFetch(
    `/api/admin/scim-tokens/${encodeURIComponent(tokenId)}/revoke`,
    { method: 'POST' }
  );
}
