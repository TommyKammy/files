import type {
  AdminSharedLinkRow,
  AdminTrashListResponse,
  AdminTrashRestoreResponse,
  AiClassificationMode,
  AiSuggestionItem,
  AuditLogEntry,
  ClassificationLabel,
  StorageStatsResponse,
  TenantPolicyRow,
  TrashBulkItemRef,
  TrashBulkResponse,
  TrashEmptyResponse,
  TrashSort,
  TrashTypeFilter,
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
  /** Additional exact action filters, combined with `action` using IN (...). */
  actions?: string[];
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
  if (params?.actions && params.actions.length > 0) {
    qs.set('actions', params.actions.join(','));
  }
  if (params?.status) qs.set('status', params.status);
  if (params?.actorEmail) qs.set('actorEmail', params.actorEmail);
  if (params?.cursorCreatedAt) qs.set('cursorCreatedAt', params.cursorCreatedAt);
  if (params?.cursorId) qs.set('cursorId', params.cursorId);
  if (params?.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch(`/api/audit-logs${suffix}`);
}

/** GET /api/admin/trash — tenant-wide Trash metadata and filter candidates. */
export function fetchAdminTrash(params?: {
  query?: string;
  type?: TrashTypeFilter;
  ownerId?: string | null;
  deletedById?: string | null;
  deletedFrom?: string | null;
  deletedTo?: string | null;
  daysRemainingMax?: number | null;
  sort?: TrashSort;
  limit?: number;
  cursor?: string | null;
}): Promise<AdminTrashListResponse> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.cursor) qs.set('cursor', params.cursor);
  if (params?.query?.trim()) qs.set('query', params.query.trim());
  if (params?.type && params.type !== 'all') qs.set('type', params.type);
  if (params?.ownerId) qs.set('ownerId', params.ownerId);
  if (params?.deletedById) qs.set('deletedById', params.deletedById);
  if (params?.deletedFrom) qs.set('deletedFrom', params.deletedFrom);
  if (params?.deletedTo) qs.set('deletedTo', params.deletedTo);
  if (
    params?.daysRemainingMax !== null &&
    params?.daysRemainingMax !== undefined
  ) {
    qs.set('daysRemainingMax', String(params.daysRemainingMax));
  }
  if (params?.sort) qs.set('sort', params.sort);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch(`/api/admin/trash${suffix}`);
}

/** POST /api/admin/trash/restore — delegated restore for sec_admin/sys_admin. */
export function restoreAdminTrash(payload: {
  items: TrashBulkItemRef[];
  targetFolderId?: string | null;
  conflictPolicy?: 'fail' | 'rename';
  restoreParentChain?: boolean;
}): Promise<AdminTrashRestoreResponse> {
  return apiFetch('/api/admin/trash/restore', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/admin/trash/empty — sys_admin tenant-wide permanent deletion. */
export function emptyAdminTrash(confirm: string): Promise<TrashEmptyResponse> {
  return apiFetch('/api/admin/trash/empty', {
    method: 'POST',
    body: JSON.stringify({ confirm }),
  });
}

/** DELETE /api/admin/trash/items — sys_admin selected permanent deletion. */
export function purgeAdminTrashItems(
  items: TrashBulkItemRef[]
): Promise<TrashBulkResponse> {
  return apiFetch('/api/admin/trash/items', {
    method: 'DELETE',
    body: JSON.stringify({ items }),
  });
}

/** POST /api/folders/:id/move — single-folder subtree move with optimistic concurrency */

