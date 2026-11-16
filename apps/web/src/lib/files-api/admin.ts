import type {
  AdminSharedLinkRow,
  AiClassificationMode,
  AiSuggestionItem,
  AuditLogEntry,
  ClassificationLabel,
  StorageStatsResponse,
  TenantPolicyRow,
} from '@/types/files';
import {
  apiFetch,
} from './core';

export function fetchAdminStorageStats(): Promise<StorageStatsResponse> {
  return apiFetch('/api/admin/storage-stats');
}

export function fetchAdminAiSuggestions(params?: {
  suggestedLabel?: ClassificationLabel;
  cursorUpdatedAt?: string;
  cursorId?: string;
  limit?: number;
}): Promise<{
  suggestions: AiSuggestionItem[];
  nextCursor: { updatedAt: string; id: string } | null;
}> {
  const qs = new URLSearchParams();
  if (params?.suggestedLabel) qs.set('suggestedLabel', params.suggestedLabel);
  if (params?.cursorUpdatedAt) qs.set('cursorUpdatedAt', params.cursorUpdatedAt);
  if (params?.cursorId) qs.set('cursorId', params.cursorId);
  if (params?.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch(`/api/admin/ai-suggestions${suffix}`);
}

export function bulkApproveAiSuggestions(
  items: Array<{ fileId: string; label?: Exclude<ClassificationLabel, 'unset'> }>
): Promise<{ ok: boolean; approvedCount: number; approvedIds: string[]; skippedIds: string[] }> {
  return apiFetch('/api/admin/ai-suggestions/bulk-approve', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export function fetchAdminSharedLinks(limit = 50): Promise<{ links: AdminSharedLinkRow[] }> {
  return apiFetch(`/api/admin/shared-links?limit=${limit}`);
}

export function adminEmergencyRevokeSharedLink(
  linkId: string,
  reason?: string
): Promise<{ ok: boolean; linkId: string; revokedAt: string }> {
  return apiFetch(`/api/admin/shared-links/${encodeURIComponent(linkId)}/revoke`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function fetchAdminPolicies(): Promise<{ policy: TenantPolicyRow }> {
  return apiFetch('/api/admin/policies');
}

export function updateAdminPolicies(payload: {
  enforceCompanyOnlyLinks?: boolean;
  requireWatermarkConfidential?: boolean;
  maxLinkExpirationDays?: number;
  sessionMaxHours?: number;
  trashRetentionDays?: number;
  aiClassificationMode?: AiClassificationMode;
  aiAutoApplyThreshold?: number | null;
}): Promise<{ policy: TenantPolicyRow }> {
  return apiFetch('/api/admin/policies', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function fetchAuditLogs(params?: {
  action?: string;
  status?: 'allowed' | 'blocked';
  actorEmail?: string;
  cursorCreatedAt?: string;
  cursorId?: string;
  limit?: number;
}): Promise<{
  logs: AuditLogEntry[];
  nextCursor: { createdAt: string; id: string } | null;
}> {
  const qs = new URLSearchParams();
  if (params?.action) qs.set('action', params.action);
  if (params?.status) qs.set('status', params.status);
  if (params?.actorEmail) qs.set('actorEmail', params.actorEmail);
  if (params?.cursorCreatedAt) qs.set('cursorCreatedAt', params.cursorCreatedAt);
  if (params?.cursorId) qs.set('cursorId', params.cursorId);
  if (params?.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch(`/api/audit-logs${suffix}`);
}

/** POST /api/folders/:id/move — single-folder subtree move with optimistic concurrency */

