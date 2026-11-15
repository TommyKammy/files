import type {
  AdminSharedLinkRow,
  AiClassificationMode,
  AiSuggestionItem,
  AuditLogEntry,
  AuthUser,
  BatchMoveWorkspaceResponse,
  BootstrapResponse,
  BreadcrumbItem,
  ClassificationLabel,
  CopyWorkspaceResponse,
  DevAuthAccountsResponse,
  FileItem,
  FileRequestSummary,
  FolderChildrenResponse,
  FolderSummary,
  PermissionEntry,
  PrincipalCandidate,
  PublicFileRequestMeta,
  PublicShareMeta,
  PublicShareUrlResponse,
  ResourceRole,
  SearchResultItem,
  ShareAccessScope,
  SharedLinkSummary,
  StorageStatsResponse,
  SyncDeltaResponse,
  SyncWsTicketResponse,
  TenantPolicyRow,
  UploadTaskProgress,
  UserRole,
  WorkspaceBatchItemRef,
  WorkspaceConflictPolicy,
  WorkspaceJobStatus,
} from '@/types/files';

import {
  apiFetch,
} from './core';

export function listPermissions(
  targetType: 'folder' | 'file',
  targetId: string
): Promise<{ permissions: PermissionEntry[] }> {
  const params = new URLSearchParams({ targetType, targetId });
  return apiFetch(`/api/permissions?${params.toString()}`);
}

export function grantPermission(payload: {
  targetType: 'folder' | 'file';
  targetId: string;
  granteeType: 'user' | 'group';
  granteeId: string;
  role: ResourceRole;
}): Promise<{ ok: boolean }> {
  return apiFetch('/api/permissions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function revokePermission(permissionId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/permissions/${encodeURIComponent(permissionId)}`, {
    method: 'DELETE',
  });
}

export function searchPrincipals(q: string): Promise<{ principals: PrincipalCandidate[] }> {
  return apiFetch(`/api/principals/search?q=${encodeURIComponent(q)}`);
}

export function listSharedLinks(
  targetType: 'file' | 'folder',
  targetId: string
): Promise<{ links: SharedLinkSummary[] }> {
  const params = new URLSearchParams({ targetType, targetId });
  return apiFetch(`/api/shared-links?${params.toString()}`);
}

export function createSharedLink(payload: {
  targetType: 'file' | 'folder';
  targetId: string;
  accessScope: ShareAccessScope;
  canDownload: boolean;
  requireWatermark: boolean;
  password?: string;
  expiresInDays?: number;
  maxDownloads?: number;
}): Promise<{ link: SharedLinkSummary; token: string; shareUrl: string }> {
  return apiFetch('/api/shared-links', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function revokeSharedLink(linkId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/shared-links/${encodeURIComponent(linkId)}`, {
    method: 'DELETE',
  });
}

export function getPublicShareMeta(token: string): Promise<PublicShareMeta> {
  return apiFetch(`/api/s/${encodeURIComponent(token)}/meta`);
}

export function verifyPublicSharePassword(
  token: string,
  password: string
): Promise<{ ok: boolean; unlocked: boolean; unlockToken?: string }> {
  return apiFetch(`/api/s/${encodeURIComponent(token)}/verify-password`, {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function issuePublicShareUrl(
  token: string,
  payload: {
    intent: 'preview' | 'download';
    fileId?: string;
    unlockToken?: string;
  }
): Promise<PublicShareUrlResponse> {
  const headers: Record<string, string> = {};
  if (payload.unlockToken) {
    headers['X-Share-Unlock'] = payload.unlockToken;
  }
  return apiFetch(`/api/s/${encodeURIComponent(token)}/url`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      intent: payload.intent,
      fileId: payload.fileId,
      unlockToken: payload.unlockToken,
    }),
  });
}


