import type {
  CreateSharedLinkPayload,
  PermissionsListResponse,
  PrincipalCandidate,
  PrincipalSearchKind,
  PublicShareMeta,
  PublicShareUrlResponse,
  ResourceRole,
  SharedLinkSummary,
  SharedLinkUpdateResponse,
  SharedLinkUploadCompleteResponse,
  SharedLinkUploadInitResponse,
  UpdateSharedLinkPayload,
  WopiSessionResponse,
} from '@/types/files';
import {
  apiFetch,
  apiFetchBlob,
  parseContentDispositionFilename,
} from './core';

export function listPermissions(
  targetType: 'folder' | 'file',
  targetId: string
): Promise<PermissionsListResponse> {
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

export function searchPrincipals(
  q: string,
  kind: PrincipalSearchKind = 'all'
): Promise<{ principals: PrincipalCandidate[] }> {
  const params = new URLSearchParams({ q: q.trim(), kind });
  return apiFetch<{
    principals: Array<{
      type: 'user' | 'group';
      id: string;
      name?: string;
      displayName?: string;
      email: string | null;
      department?: string | null;
      userType?: 'member' | 'guest';
      externalOrg?: string | null;
      expiresAt?: string | null;
      lastLoginAt?: string | null;
      invitedBy?: string | null;
      invitationStatus?: PrincipalCandidate['invitationStatus'];
    }>;
  }>(`/api/principals/search?${params.toString()}`).then((response) => ({
    principals: response.principals.map((principal) => ({
      type: principal.type,
      id: principal.id,
      name: principal.name ?? principal.displayName ?? principal.id,
      email: principal.email,
      department: principal.department ?? null,
      userType: principal.userType ?? 'member',
      externalOrg: principal.externalOrg ?? null,
      expiresAt: principal.expiresAt ?? null,
      lastLoginAt: principal.lastLoginAt ?? null,
      invitedBy: principal.invitedBy ?? null,
      invitationStatus: principal.invitationStatus ?? null,
    })),
  }));
}

export function listSharedLinks(
  targetType: 'file' | 'folder',
  targetId: string
): Promise<{ links: SharedLinkSummary[] }> {
  const params = new URLSearchParams({ targetType, targetId });
  return apiFetch(`/api/shared-links?${params.toString()}`);
}

export function createSharedLink(
  payload: CreateSharedLinkPayload
): Promise<{ link: SharedLinkSummary; token: string; shareUrl: string }> {
  return apiFetch('/api/shared-links', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function updateSharedLink(
  linkId: string,
  payload: UpdateSharedLinkPayload
): Promise<SharedLinkUpdateResponse> {
  return apiFetch(`/api/shared-links/${encodeURIComponent(linkId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export function revokeSharedLink(linkId: string): Promise<{ ok: boolean }> {
  return apiFetch(`/api/shared-links/${encodeURIComponent(linkId)}`, {
    method: 'DELETE',
  });
}

export function getPublicShareMeta(
  token: string,
  folderId?: string | null
): Promise<PublicShareMeta> {
  const qs = folderId ? `?folderId=${encodeURIComponent(folderId)}` : '';
  return apiFetch(`/api/s/${encodeURIComponent(token)}/meta${qs}`);
}

export async function downloadPublicShareZip(
  token: string,
  options?: { folderId?: string | null; unlockToken?: string }
): Promise<{ blob: Blob; filename: string; downloadCount: number | null }> {
  const qs = options?.folderId
    ? `?folderId=${encodeURIComponent(options.folderId)}`
    : '';
  const headers: Record<string, string> = {};
  if (options?.unlockToken) {
    headers['X-Share-Unlock'] = options.unlockToken;
  }
  const { blob, headers: resHeaders } = await apiFetchBlob(
    `/api/s/${encodeURIComponent(token)}/zip${qs}`,
    { method: 'GET', headers }
  );
  const rawCount = resHeaders.get('X-Download-Count');
  const parsedCount = rawCount !== null ? Number(rawCount) : NaN;
  return {
    blob,
    filename: parseContentDispositionFilename(
      resHeaders.get('Content-Disposition'),
      'shared-folder.zip'
    ),
    downloadCount: Number.isFinite(parsedCount) ? parsedCount : null,
  };
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

export function initializeSharedLinkUpload(
  token: string,
  payload: {
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    fileId?: string;
    conflictPolicy?: 'fail' | 'new_version';
    unlockToken?: string;
  }
): Promise<SharedLinkUploadInitResponse> {
  return apiFetch(`/api/s/${encodeURIComponent(token)}/upload-init`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function completeSharedLinkUpload(
  token: string,
  payload: {
    fileId: string;
    versionId: string;
    unlockToken?: string;
  }
): Promise<SharedLinkUploadCompleteResponse> {
  return apiFetch(`/api/s/${encodeURIComponent(token)}/upload-complete`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** init -> signed PUT -> complete, mirroring the authenticated upload flow. */
export async function uploadViaSharedLink(
  token: string,
  payload: {
    file: { name: string; mimeType: string; body: Blob | ArrayBuffer | Uint8Array };
    fileId?: string;
    conflictPolicy?: 'fail' | 'new_version';
    unlockToken?: string;
  }
): Promise<SharedLinkUploadCompleteResponse> {
  const sizeBytes =
    payload.file.body instanceof Blob
      ? payload.file.body.size
      : payload.file.body.byteLength;
  const init = await initializeSharedLinkUpload(token, {
    fileName: payload.file.name,
    mimeType: payload.file.mimeType,
    sizeBytes,
    fileId: payload.fileId,
    conflictPolicy: payload.conflictPolicy,
    unlockToken: payload.unlockToken,
  });
  const res = await fetch(init.uploadUrl, {
    method: 'PUT',
    headers: init.requiredHeaders,
    body: payload.file.body as BodyInit,
    credentials: init.uploadUrl.startsWith('/') ? 'include' : 'omit',
  });
  if (!res.ok) {
    throw new Error(`アップロードに失敗しました (HTTP ${res.status})`);
  }
  return completeSharedLinkUpload(token, {
    fileId: init.fileId,
    versionId: init.versionId,
    unlockToken: payload.unlockToken,
  });
}

export function createSharedLinkWopiSession(
  token: string,
  payload: { fileId?: string; unlockToken?: string }
): Promise<WopiSessionResponse> {
  return apiFetch(`/api/s/${encodeURIComponent(token)}/wopi-session`, {
    method: 'POST',
    body: JSON.stringify(payload),
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


