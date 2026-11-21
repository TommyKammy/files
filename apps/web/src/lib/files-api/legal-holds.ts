import { apiFetch } from './core';

export type LegalHoldTargetType = 'folder' | 'file' | 'user';
export type LegalHoldStatus = 'active' | 'released';
export type RetentionTargetType = 'folder' | 'classification';

export interface LegalHoldRecord {
  id: string;
  tenantId: string;
  name: string;
  reason: string | null;
  targetType: LegalHoldTargetType;
  targetId: string;
  status: LegalHoldStatus;
  createdBy: string;
  releasedBy: string | null;
  releasedAt: string | null;
  createdAt: string;
}

export interface RetentionPolicyRecord {
  id: string;
  tenantId: string;
  name: string;
  targetType: RetentionTargetType;
  targetValue: string;
  retentionDays: number;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export function fetchAdminLegalHolds(
  status: 'all' | LegalHoldStatus = 'all'
): Promise<{ legalHolds: LegalHoldRecord[] }> {
  const query = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;
  return apiFetch(`/api/admin/legal-holds${query}`);
}

export function createAdminLegalHold(input: {
  name: string;
  reason?: string | null;
  targetType: LegalHoldTargetType;
  targetId: string;
}): Promise<{ ok: boolean; legalHold: LegalHoldRecord }> {
  return apiFetch('/api/admin/legal-holds', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function releaseAdminLegalHold(
  id: string
): Promise<{ ok: boolean; legalHold: LegalHoldRecord }> {
  return apiFetch(`/api/admin/legal-holds/${encodeURIComponent(id)}/release`, {
    method: 'POST',
  });
}

export function fetchAdminRetentionPolicies(): Promise<{
  retentionPolicies: RetentionPolicyRecord[];
}> {
  return apiFetch('/api/admin/retention-policies');
}

export function createAdminRetentionPolicy(input: {
  name: string;
  targetType: RetentionTargetType;
  targetValue: string;
  retentionDays: number;
  enabled?: boolean;
}): Promise<{ ok: boolean; retentionPolicy: RetentionPolicyRecord }> {
  return apiFetch('/api/admin/retention-policies', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateAdminRetentionPolicy(
  id: string,
  input: {
    name?: string;
    retentionDays?: number;
    enabled?: boolean;
  }
): Promise<{ ok: boolean; retentionPolicy: RetentionPolicyRecord }> {
  return apiFetch(`/api/admin/retention-policies/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteAdminRetentionPolicy(
  id: string
): Promise<{ ok: boolean }> {
  return apiFetch(`/api/admin/retention-policies/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
