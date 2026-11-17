import {
  buildPermissionAuditHref,
} from '@/lib/admin-permission-audit';
import {
  buildAdminContentSearchQueryString,
} from '@/lib/admin-content';
import { buildAdminSessionQuery } from '@/lib/admin-sessions';
import type {
  AdminBulkCoOwnerPayload,
  AdminBulkLifecyclePayload,
  AdminBulkResponse,
  AdminBulkTransferOwnerPayload,
  AdminContentDetail,
  AdminContentForceUnlockResponse,
  AdminContentInspectResponse,
  AdminContentSearchFilters,
  AdminContentSearchResponse,
  AdminInsightsRangeDays,
  AdminInsightsResponse,
  AdminPermissionAuditQuery,
  AdminPermissionAuditResponse,
  AdminRootFolderListResponse,
  AdminRootFolderRecord,
  AdminSessionListQuery,
  AdminSessionListResponse,
  AdminSessionRevokeResponse,
  AdminSharedLinkRow,
  AdminSsoStatusResponse,
  AdminTenantSessionsRevokeResponse,
  AdminTrashListResponse,
  AdminTrashRestoreResponse,
  AdminUserSessionsRevokeResponse,
  AiClassificationMode,
  AiSuggestionItem,
  AuditLogEntry,
  ClassificationLabel,
  FolderStructureMode,
  InvitePolicy,
  PermissionInheritanceMode,
  StorageStatsResponse,
  TenantPolicyResponse,
  TenantPolicyRow,
  TrashBulkItemRef,
  UpdateAdminPoliciesPayload,
  TrashBulkResponse,
  TrashEmptyResponse,
  TrashSort,
  TrashTypeFilter,
  WaterfallInheritanceConflict,
} from '@/types/files';
import {
  apiFetch,
} from './core';

export function fetchAdminStorageStats(): Promise<StorageStatsResponse> {
  return apiFetch('/api/admin/storage-stats');
}

/** GET /api/admin/insights?days=7|30 — pre-aggregated usage/security KPIs. */
export function fetchAdminInsights(
  days: AdminInsightsRangeDays = 7
): Promise<AdminInsightsResponse> {
  return apiFetch(`/api/admin/insights?days=${days === 30 ? 30 : 7}`);
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

export function fetchAdminPolicies(): Promise<TenantPolicyResponse> {
  return apiFetch('/api/admin/policies');
}

/** GET /api/admin/policies/inheritance-conflicts — sec_admin can review too. */
export function fetchInheritanceConflicts(): Promise<{
  permissionInheritanceMode: PermissionInheritanceMode;
  conflicts: WaterfallInheritanceConflict[];
}> {
  return apiFetch('/api/admin/policies/inheritance-conflicts');
}

export function updateAdminPolicies(
  payload: UpdateAdminPoliciesPayload
): Promise<TenantPolicyResponse & { policy: TenantPolicyRow }> {
  return apiFetch('/api/admin/policies', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function fetchAdminRootFolders(params?: {
  search?: string;
  status?: 'active' | 'archived' | 'all';
  includeArchived?: boolean;
  ownerMissingOnly?: boolean;
}): Promise<AdminRootFolderListResponse> {
  const qs = new URLSearchParams();
  if (params?.search?.trim()) qs.set('search', params.search.trim());
  if (params?.status) qs.set('status', params.status);
  if (params?.includeArchived !== undefined) {
    qs.set('includeArchived', params.includeArchived ? '1' : '0');
  }
  if (params?.ownerMissingOnly) qs.set('ownerMissingOnly', '1');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch(`/api/admin/root-folders${suffix}`);
}

export function createAdminRootFolder(payload: {
  name: string;
  classification?: ClassificationLabel;
  isPinned?: boolean;
  ownerUserId: string;
  coOwnerUserIds?: string[];
  coOwnerGroupIds?: string[];
}): Promise<{ root: AdminRootFolderRecord }> {
  return apiFetch('/api/admin/root-folders', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function transferAdminRootFolderOwner(
  folderId: string,
  payload: {
    newOwnerUserId: string;
    demotePreviousOwnersTo?: 'co_owner' | 'editor' | 'revoke';
  }
): Promise<{ root: AdminRootFolderRecord }> {
  return apiFetch(
    `/api/admin/root-folders/${encodeURIComponent(folderId)}/transfer-owner`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export function grantAdminRootFolderCoOwners(
  folderId: string,
  payload: { userIds?: string[]; groupIds?: string[] }
): Promise<{ root: AdminRootFolderRecord }> {
  return apiFetch(
    `/api/admin/root-folders/${encodeURIComponent(folderId)}/co-owners`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export function archiveAdminRootFolder(
  folderId: string
): Promise<{ ok: boolean; deletedAt: string }> {
  return apiFetch(
    `/api/admin/root-folders/${encodeURIComponent(folderId)}/archive`,
    { method: 'POST' }
  );
}

export function restoreAdminRootFolder(
  folderId: string
): Promise<{ ok: boolean; root: AdminRootFolderRecord }> {
  return apiFetch(
    `/api/admin/root-folders/${encodeURIComponent(folderId)}/restore`,
    { method: 'POST' }
  );
}

export function fetchAuditLogs(params?: {
  action?: string;
  /** Additional exact action filters, combined with `action` using IN (...). */
  actions?: string[];
  /** Prefix filters, e.g. `permission.` / `admin.root_folder.`. */
  actionPrefixes?: string[];
  targetType?: string;
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
  if (params?.actionPrefixes && params.actionPrefixes.length > 0) {
    qs.set('actionPrefixes', params.actionPrefixes.join(','));
  }
  if (params?.targetType) qs.set('targetType', params.targetType);
  if (params?.status) qs.set('status', params.status);
  if (params?.actorEmail) qs.set('actorEmail', params.actorEmail);
  if (params?.cursorCreatedAt) qs.set('cursorCreatedAt', params.cursorCreatedAt);
  if (params?.cursorId) qs.set('cursorId', params.cursorId);
  if (params?.limit) qs.set('limit', String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch(`/api/audit-logs${suffix}`);
}

/** GET /api/admin/permissions — tenant-wide direct/inherited permission audit. */
export function fetchAdminPermissionAudit(
  query: AdminPermissionAuditQuery = {}
): Promise<AdminPermissionAuditResponse> {
  return apiFetch(buildPermissionAuditHref(query));
}

/** POST /api/admin/permissions/bulk-co-owner — sys_admin only. */
export function bulkGrantAdminRootFolderCoOwners(
  payload: AdminBulkCoOwnerPayload
): Promise<AdminBulkResponse> {
  return apiFetch('/api/admin/permissions/bulk-co-owner', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/admin/root-folders/bulk-transfer-owner — sys_admin only. */
export function bulkTransferAdminRootFolderOwners(
  payload: AdminBulkTransferOwnerPayload
): Promise<AdminBulkResponse> {
  return apiFetch('/api/admin/root-folders/bulk-transfer-owner', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/admin/root-folders/bulk-archive — sys_admin only. */
export function bulkArchiveAdminRootFolders(
  payload: AdminBulkLifecyclePayload
): Promise<AdminBulkResponse> {
  return apiFetch('/api/admin/root-folders/bulk-archive', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** POST /api/admin/root-folders/bulk-restore — sys_admin only. */
export function bulkRestoreAdminRootFolders(
  payload: AdminBulkLifecyclePayload
): Promise<AdminBulkResponse> {
  return apiFetch('/api/admin/root-folders/bulk-restore', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
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


/* ------------------------------------------------------------------ */
/* P12-1 / TOM-65 admin content manager                                */
/* ------------------------------------------------------------------ */

/** GET /api/admin/content/search — tenant-wide ACL-independent search. */
export function searchAdminContent(
  filters: AdminContentSearchFilters,
  cursor: string | null = null,
  limit?: number
): Promise<AdminContentSearchResponse> {
  const qs = buildAdminContentSearchQueryString(filters, cursor, limit);
  return apiFetch(`/api/admin/content/search?${qs}`);
}

/** GET /api/admin/content/:targetType/:targetId — inspector detail. */
export function fetchAdminContentDetail(
  targetType: 'file' | 'folder',
  targetId: string
): Promise<AdminContentDetail> {
  return apiFetch(
    `/api/admin/content/${targetType}/${encodeURIComponent(targetId)}`
  );
}

/** POST /api/admin/content/files/:id/force-unlock — audited lock override. */
export function forceUnlockAdminContentFile(
  fileId: string,
  reason: string
): Promise<AdminContentForceUnlockResponse> {
  return apiFetch(
    `/api/admin/content/files/${encodeURIComponent(fileId)}/force-unlock`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }
  );
}

/** POST /api/admin/content/files/:id/inspect-preview — audited preview URL. */
export function inspectAdminContentFile(
  fileId: string,
  reason: string
): Promise<AdminContentInspectResponse> {
  return apiFetch(
    `/api/admin/content/files/${encodeURIComponent(fileId)}/inspect-preview`,
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }
  );
}

/* ------------------------------------------------------------------ */
/* P12-2 / TOM-71 active sessions & forced sign-out                    */
/* ------------------------------------------------------------------ */

/** GET /api/admin/sessions — live tenant sessions with keyset pagination. */
export function fetchAdminSessions(
  query: AdminSessionListQuery = {}
): Promise<AdminSessionListResponse> {
  return apiFetch(`/api/admin/sessions${buildAdminSessionQuery(query)}`);
}

/** POST /api/admin/sessions/:id/revoke — single-session forced sign-out. */
export function revokeAdminSession(
  sessionId: string,
  reason?: string | null
): Promise<AdminSessionRevokeResponse> {
  return apiFetch(
    `/api/admin/sessions/${encodeURIComponent(sessionId)}/revoke`,
    {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }
  );
}

/** POST /api/admin/users/:id/revoke-sessions — user-scoped sign-out. */
export function revokeAdminUserSessions(
  userId: string,
  payload: { reason?: string | null; keepCurrentSession?: boolean } = {}
): Promise<AdminUserSessionsRevokeResponse> {
  return apiFetch(
    `/api/admin/users/${encodeURIComponent(userId)}/revoke-sessions`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

/** POST /api/admin/sessions/revoke-all — sys_admin emergency tenant sign-out. */
export function revokeAllAdminSessions(payload: {
  reason?: string | null;
  keepCurrentSession?: boolean;
} = {}): Promise<AdminTenantSessionsRevokeResponse> {
  return apiFetch('/api/admin/sessions/revoke-all', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/* ------------------------------------------------------------------ */
/* P12-3 / TOM-66 IP allowlist & OIDC SSO controls                     */
/* ------------------------------------------------------------------ */

/** GET /api/admin/sso/status — masked IdP visibility for sys/sec admins. */
export function fetchAdminSsoStatus(
  options: { probeDiscovery?: boolean } = {}
): Promise<AdminSsoStatusResponse> {
  const qs = options.probeDiscovery ? '?probeDiscovery=1' : '';
  return apiFetch(`/api/admin/sso/status${qs}`);
}
