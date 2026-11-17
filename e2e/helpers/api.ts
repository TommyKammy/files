import { expect, type APIRequestContext } from '@playwright/test';

export interface FolderLike {
  id: string;
  name: string;
  parent_id: string | null;
  version: number;
  classification: string;
  effectiveRole?: string;
  capabilities?: string[];
  invite_policy?: string | null;
  deleted_at?: string | null;
}

export interface FileLike {
  id: string;
  folder_id: string | null;
  name: string;
  size_bytes: number;
  mime_type: string | null;
  classification: string;
  upload_state?: string;
  current_version_num?: number;
  meta_version?: number;
  updated_at?: string;
  deleted_at?: string | null;
}

export interface FileVersionLike {
  id: string;
  version_num: number;
  size_bytes: number;
  mime_type: string;
  upload_status: string;
  uploaded_by: string;
  created_at: string;
}

export interface FileDetailResponse {
  file: FileLike;
  effectiveRole: string;
  canDownload: boolean;
  versions: FileVersionLike[];
}

export interface FileLockStatusResponse {
  fileId: string;
  lock: {
    fileId: string;
    tenantId: string;
    mode: 'wopi_collab' | 'desktop_exclusive';
    lockId: string;
    ownerId: string;
    ownerName: string;
    ownerEmail: string | null;
    sessionId: string | null;
    acquiredAt: number;
    expiresAt: number;
    updatedAt: number;
  } | null;
  canWrite: boolean;
  readOnly: boolean;
  syncPolicy: 'full' | 'cloud_preview_only';
}

export interface DriveLockResponse {
  ok: boolean;
  fileId: string;
  lockId: string;
  expiresAt: number;
  syncPolicy: 'full' | 'cloud_preview_only';
  lock: FileLockStatusResponse['lock'];
}

interface FolderChildrenResponse {
  folder: FolderLike;
  effectiveRole: string;
  folders: FolderLike[];
  files: FileLike[];
  capabilities?: string[];
}

export interface TrashItemLike {
  id: string;
  name: string;
  type?: 'file' | 'folder';
  folder_id?: string | null;
  parent_id?: string | null;
  deleted_at?: string | null;
  deletedAt?: string;
  deletedBy?: string | null;
  deletedByName?: string | null;
  purgeAt?: string;
  daysRemaining?: number;
  version?: number;
}

export interface TrashResponse {
  folders: FolderLike[];
  files: FileLike[];
  items?: TrashItemLike[];
  nextCursor?: string | null;
  hasMore?: boolean;
  trashRetentionDays?: number;
  deleters?: Array<{ id: string; name: string }>;
  hasUnknownDeleter?: boolean;
}

interface SearchResultLike {
  id: string;
  name: string;
  folderId: string | null;
  folderName: string | null;
}

export type PermissionTargetType = 'folder' | 'file';
export type PermissionGranteeType = 'user' | 'group';
export type PermissionRole =
  | 'owner'
  | 'co_owner'
  | 'editor'
  | 'viewer_uploader'
  | 'previewer_uploader'
  | 'viewer'
  | 'previewer'
  | 'uploader';

export interface PermissionRecord {
  id: string;
  targetType: PermissionTargetType;
  targetId: string;
  granteeType: PermissionGranteeType;
  granteeId: string;
  granteeName: string | null;
  granteeEmail: string | null;
  role: PermissionRole;
  inherited: boolean;
  sourceName: string | null;
  grantedBy: string;
  createdAt: string;
  synthesizedRole?: PermissionRole | null;
  synthesizedCapabilities?: string[];
}

export interface PermissionListResponse {
  targetType: PermissionTargetType;
  targetId: string;
  effectiveRole: string;
  capabilities: string[];
  effectiveCapabilities?: string[];
  grantedRoles: PermissionRole[];
  advancedRolesEnabled: boolean;
  canInvite?: boolean;
  canManage?: boolean;
  grantableRoles?: PermissionRole[];
  invitePolicy?: {
    tenantPolicy: InvitePolicy;
    folderOwnPolicy: InvitePolicy | null;
    effectivePolicy: InvitePolicy;
    inheritedFloor: InvitePolicy;
    sourceFolderId: string | null;
    sourceFolderName: string | null;
    canEditFolderPolicy?: boolean;
  };
  effectiveBreakdown: Array<{
    granteeType: PermissionGranteeType;
    granteeId: string;
    role: PermissionRole;
    inherited: boolean;
    sourceName: string | null;
    targetId: string;
  }>;
  permissions: PermissionRecord[];
}

export type InvitePolicy = 'owners' | 'editors' | 'admins';

export interface GrantedPermission {
  id: string;
  targetType: PermissionTargetType;
  targetId: string;
  granteeType: PermissionGranteeType;
  granteeId: string;
  role: PermissionRole;
  grantedBy: string;
}

export interface ApiActor {
  api: APIRequestContext;
}

function assertOk(response: Awaited<ReturnType<APIRequestContext['get']>>, label: string): void {
  expect(response.ok(), `${label} failed with HTTP ${response.status()}`).toBe(true);
}

export async function listRootFolders(actor: ApiActor): Promise<FolderLike[]> {
  const res = await actor.api.get('/api/folders/roots?limit=100');
  assertOk(res, 'GET /api/folders/roots');
  const body = (await res.json()) as { folders: FolderLike[] };
  return body.folders;
}

export async function findRootFolder(
  actor: ApiActor,
  name: string
): Promise<FolderLike> {
  const folders = await listRootFolders(actor);
  const folder = folders.find((item) => item.name === name);
  expect(folder, `root folder "${name}" must exist (seed-local.sql)`).toBeTruthy();
  return folder!;
}

export async function waitForRootFolder(
  actor: ApiActor,
  name: string,
  timeout = 15_000
): Promise<FolderLike> {
  let found: FolderLike | undefined;
  await expect
    .poll(
      async () => {
        const folders = await listRootFolders(actor);
        found = folders.find((item) => item.name === name);
        return Boolean(found);
      },
      { timeout, message: `root folder "${name}" should be visible through the API` }
    )
    .toBe(true);
  return found!;
}

export async function createFolder(
  actor: ApiActor,
  input: {
    parentId: string | null;
    name: string;
    classification?: 'confidential' | 'internal' | 'public' | 'unset';
  }
): Promise<FolderLike> {
  const res = await actor.api.post('/api/folders', {
    data: {
      parentId: input.parentId,
      name: input.name,
      classification: input.classification ?? 'internal',
    },
  });
  expect(res.status(), `POST /api/folders should return 201 for "${input.name}"`).toBe(
    201
  );
  const body = (await res.json()) as { folder: FolderLike };
  return body.folder;
}

export async function getFolderChildren(
  actor: ApiActor,
  folderId: string
): Promise<FolderChildrenResponse> {
  const res = await actor.api.get(
    `/api/folders/${encodeURIComponent(folderId)}/children?limit=50&include=breadcrumbs`
  );
  assertOk(res, `GET /api/folders/${folderId}/children`);
  return (await res.json()) as FolderChildrenResponse;
}

export async function waitForFileInFolder(
  actor: ApiActor,
  folderId: string,
  fileName: string,
  options: { present?: boolean; timeout?: number } = {}
): Promise<FileLike | null> {
  const present = options.present ?? true;
  let found: FileLike | undefined;
  await expect
    .poll(
      async () => {
        const body = await getFolderChildren(actor, folderId);
        // /children intentionally omits upload_state; every returned row is active.
        found = body.files.find((file) => file.name === fileName);
        return present ? Boolean(found) : !found;
      },
      {
        timeout: options.timeout ?? 15_000,
        message: `file "${fileName}" should ${present ? 'appear in' : 'be absent from'} folder ${folderId}`,
      }
    )
    .toBe(true);
  return found ?? null;
}

export async function waitForTrashFile(
  actor: ApiActor,
  fileName: string,
  options: { present?: boolean; timeout?: number } = {}
): Promise<FileLike | null> {
  const present = options.present ?? true;
  let found: FileLike | undefined;
  await expect
    .poll(
      async () => {
        const res = await actor.api.get(
          `/api/folders/trash?limit=100&query=${encodeURIComponent(fileName)}`
        );
        assertOk(res, 'GET /api/folders/trash');
        const body = (await res.json()) as TrashResponse;
        found = body.files.find((file) => file.name === fileName);
        return present ? Boolean(found) : !found;
      },
      {
        timeout: options.timeout ?? 15_000,
        message: `file "${fileName}" should ${present ? 'appear in' : 'leave'} the trash`,
      }
    )
    .toBe(true);
  return found ?? null;
}

/**
 * GET /api/folders/trash with the full filter/sort/cursor contract.
 */
export async function listTrash(
  actor: ApiActor,
  params: {
    limit?: number;
    cursor?: string | null;
    query?: string;
    type?: 'all' | 'file' | 'folder';
    deletedBy?: string | null;
    deletedFrom?: string | null;
    deletedTo?: string | null;
    sort?: 'deletedAt_desc' | 'deletedAt_asc' | 'name_asc' | 'name_desc';
  } = {}
): Promise<TrashResponse> {
  const search = new URLSearchParams();
  search.set('limit', String(params.limit ?? 50));
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.query) search.set('query', params.query);
  if (params.type && params.type !== 'all') search.set('type', params.type);
  if (params.deletedBy) search.set('deletedBy', params.deletedBy);
  if (params.deletedFrom) search.set('deletedFrom', params.deletedFrom);
  if (params.deletedTo) search.set('deletedTo', params.deletedTo);
  if (params.sort) search.set('sort', params.sort);
  const res = await actor.api.get(`/api/folders/trash?${search.toString()}`);
  assertOk(res, 'GET /api/folders/trash');
  return (await res.json()) as TrashResponse;
}

/** Reads every Trash page for a query using the server cursor. */
export async function listAllTrash(
  actor: ApiActor,
  params: {
    limit?: number;
    query?: string;
    type?: 'all' | 'file' | 'folder';
    deletedBy?: string | null;
    deletedFrom?: string | null;
    deletedTo?: string | null;
    sort?: 'deletedAt_desc' | 'deletedAt_asc' | 'name_asc' | 'name_desc';
  } = {}
): Promise<TrashItemLike[]> {
  const items: TrashItemLike[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const response = await listTrash(actor, {
      ...params,
      limit: params.limit ?? 200,
      cursor,
    });
    items.push(...(response.items ?? [...response.folders, ...response.files]));
    cursor = response.nextCursor ?? null;
    if (!cursor) return items;
  }
  throw new Error('Trash pagination did not terminate');
}

/** DELETE /api/files/:id — soft delete for E2E fixtures. */
export async function softDeleteFile(
  actor: ApiActor,
  fileId: string
): Promise<void> {
  const res = await actor.api.delete(
    `/api/files/${encodeURIComponent(fileId)}`
  );
  expect(
    res.ok(),
    `DELETE /api/files/${fileId} failed with HTTP ${res.status()}`
  ).toBe(true);
}

/** POST /api/files/:id/restore — restore an E2E trash fixture. */
export async function restoreTrashFile(
  actor: ApiActor,
  fileId: string
): Promise<void> {
  const res = await actor.api.post(
    `/api/files/${encodeURIComponent(fileId)}/restore`,
    { data: {} }
  );
  expect(
    res.ok(),
    `POST /api/files/${fileId}/restore failed with HTTP ${res.status()}`
  ).toBe(true);
}

/**
 * Upload a small file through the same init -> signed PUT -> complete contract
 * used by the browser. Keeps E2E setup fast without bypassing authorization,
 * quota accounting, R2 persistence, FTS indexing, or sync changes.
 */
export async function uploadFile(
  actor: ApiActor,
  input: {
    folderId: string | null;
    name: string;
    content: string | Buffer;
    mimeType?: string;
    /** `new_version` appends to an existing same-name file instead of 409. */
    conflictPolicy?: 'fail' | 'new_version';
  }
): Promise<FileLike> {
  const mimeType = input.mimeType ?? 'text/plain; charset=utf-8';
  const body = Buffer.isBuffer(input.content)
    ? input.content
    : Buffer.from(input.content, 'utf8');

  const initRes = await actor.api.post('/api/files/upload-init', {
    data: {
      folderId: input.folderId,
      fileName: input.name,
      mimeType,
      sizeBytes: body.byteLength,
      conflictPolicy: input.conflictPolicy ?? 'fail',
    },
  });
  expect(initRes.status(), 'POST /api/files/upload-init should return 201').toBe(201);
  const init = (await initRes.json()) as {
    fileId: string;
    versionId: string;
    uploadUrl: string;
    requiredHeaders?: Record<string, string>;
  };

  const putRes = await actor.api.put(init.uploadUrl, {
    headers: init.requiredHeaders,
    data: body,
  });
  expect(putRes.status(), 'signed local-proxy PUT should return 200').toBe(200);

  const completeRes = await actor.api.post('/api/files/upload-complete', {
    data: { fileId: init.fileId, versionId: init.versionId },
  });
  expect(
    completeRes.ok(),
    `POST /api/files/upload-complete failed with HTTP ${completeRes.status()}`
  ).toBe(true);
  const complete = (await completeRes.json()) as { file: FileLike };
  return complete.file;
}

/** GET /api/files/:id — file metadata plus completed version history. */
export async function getFileDetails(
  actor: ApiActor,
  fileId: string
): Promise<FileDetailResponse> {
  const res = await actor.api.get(`/api/files/${encodeURIComponent(fileId)}`);
  assertOk(res, `GET /api/files/${fileId}`);
  return (await res.json()) as FileDetailResponse;
}

/** Waits until a file reaches at least `minVersion` (WOPI finalization is async). */
export async function waitForFileVersion(
  actor: ApiActor,
  fileId: string,
  minVersion: number,
  timeout = 30_000
): Promise<FileDetailResponse> {
  let detail: FileDetailResponse | undefined;
  await expect
    .poll(
      async () => {
        detail = await getFileDetails(actor, fileId);
        return detail.file.current_version_num ?? 0;
      },
      {
        timeout,
        message: `file ${fileId} should reach version >= ${minVersion}`,
      }
    )
    .toBeGreaterThanOrEqual(minVersion);
  return detail!;
}

/** Downloads the current version bytes through the signed local-proxy URL. */
export async function downloadFileBytes(
  actor: ApiActor,
  fileId: string
): Promise<Buffer> {
  const res = await actor.api.get(
    `/api/files/${encodeURIComponent(fileId)}/content-url?intent=download`
  );
  assertOk(res, `GET /api/files/${fileId}/content-url`);
  const body = (await res.json()) as { url: string };
  const download = await actor.api.get(body.url);
  assertOk(download, `GET signed download for ${fileId}`);
  return download.body();
}

export async function getLockStatus(
  actor: ApiActor,
  fileId: string
): Promise<FileLockStatusResponse> {
  const res = await actor.api.get(
    `/api/files/${encodeURIComponent(fileId)}/lock-status`
  );
  assertOk(res, `GET /api/files/${fileId}/lock-status`);
  return (await res.json()) as FileLockStatusResponse;
}

export async function waitForLockStatus(
  actor: ApiActor,
  fileId: string,
  predicate: (status: FileLockStatusResponse) => boolean,
  timeout = 30_000
): Promise<FileLockStatusResponse> {
  let status: FileLockStatusResponse | undefined;
  await expect
    .poll(
      async () => {
        status = await getLockStatus(actor, fileId);
        return predicate(status);
      },
      { timeout, message: `lock status for ${fileId} should match` }
    )
    .toBe(true);
  return status!;
}

export async function acquireDriveLock(
  actor: ApiActor,
  fileId: string,
  input: { lockId: string; ttlSeconds?: number }
): Promise<DriveLockResponse> {
  const res = await actor.api.post(
    `/api/files/${encodeURIComponent(fileId)}/lock`,
    { data: input }
  );
  expect(
    res.status(),
    `POST /api/files/${fileId}/lock should return 201`
  ).toBe(201);
  return (await res.json()) as DriveLockResponse;
}

export async function releaseDriveLock(
  actor: ApiActor,
  fileId: string,
  lockId: string
): Promise<void> {
  const res = await actor.api.delete(
    `/api/files/${encodeURIComponent(fileId)}/lock`,
    { data: { lockId } }
  );
  assertOk(res, `DELETE /api/files/${fileId}/lock`);
}

export async function searchFiles(
  actor: ApiActor,
  query: string
): Promise<SearchResultLike[]> {
  const res = await actor.api.get(
    `/api/search?q=${encodeURIComponent(query)}&limit=20`
  );
  assertOk(res, 'GET /api/search');
  const body = (await res.json()) as { results: SearchResultLike[] };
  return body.results;
}

/** GET /api/permissions?targetType=folder|file&targetId=... */
export async function listPermissions(
  actor: ApiActor,
  input: { targetType: PermissionTargetType; targetId: string }
): Promise<PermissionListResponse> {
  const params = new URLSearchParams({
    targetType: input.targetType,
    targetId: input.targetId,
  });
  const res = await actor.api.get(`/api/permissions?${params.toString()}`);
  assertOk(res, 'GET /api/permissions');
  return (await res.json()) as PermissionListResponse;
}

/**
 * POST /api/permissions — grant or update a direct RBAC role.
 * Returns 201 for a new grant and 200 for an updated grant.
 */
export async function grantPermission(
  actor: ApiActor,
  input: {
    targetType: PermissionTargetType;
    targetId: string;
    granteeType: PermissionGranteeType;
    granteeId: string;
    role: PermissionRole;
  }
): Promise<GrantedPermission> {
  const res = await actor.api.post('/api/permissions', { data: input });
  expect(
    [200, 201],
    `POST /api/permissions should return 200/201 for ${input.granteeType}:${input.granteeId}`
  ).toContain(res.status());
  const body = (await res.json()) as { permission: GrantedPermission };
  return body.permission;
}

/** DELETE /api/permissions/:id — revoke a direct RBAC role. */
export async function revokePermission(
  actor: ApiActor,
  permissionId: string
): Promise<{ ok: boolean; id: string }> {
  const res = await actor.api.delete(
    `/api/permissions/${encodeURIComponent(permissionId)}`
  );
  assertOk(res, `DELETE /api/permissions/${permissionId}`);
  const body = (await res.json()) as { ok: boolean; id: string };
  expect(body).toEqual({ ok: true, id: permissionId });
  return body;
}

const E2E_SCIM_TOKEN = 'dev-e2e-scim-token';

export interface ScimUserLike {
  id: string;
  userName: string;
  displayName: string;
  active: boolean;
}

/** POST /scim/v2/Users — provisions an isolated E2E user. */
export async function createScimUser(
  actor: ApiActor,
  input: { email: string; displayName: string }
): Promise<ScimUserLike> {
  const res = await actor.api.post('/scim/v2/Users', {
    headers: { Authorization: `Bearer ${E2E_SCIM_TOKEN}` },
    data: {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: input.email,
      displayName: input.displayName,
      emails: [{ value: input.email, primary: true }],
      active: true,
    },
  });
  expect(res.status(), 'POST /scim/v2/Users should return 201').toBe(201);
  return (await res.json()) as ScimUserLike;
}

/** PATCH /scim/v2/Users/:id — suspend an owner fixture for warning coverage. */
export async function suspendScimUser(
  actor: ApiActor,
  userId: string
): Promise<ScimUserLike> {
  const res = await actor.api.patch(
    `/scim/v2/Users/${encodeURIComponent(userId)}`,
    {
      headers: { Authorization: `Bearer ${E2E_SCIM_TOKEN}` },
      data: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      },
    }
  );
  expect(res.status(), 'PATCH /scim/v2/Users/:id should return 200').toBe(200);
  return (await res.json()) as ScimUserLike;
}

/** PATCH /api/admin/policies — sys_admin tenant invite policy. */
export async function updateTenantInvitePolicy(
  actor: ApiActor,
  invitePolicy: InvitePolicy
): Promise<void> {
  const res = await actor.api.patch('/api/admin/policies', {
    data: { invitePolicy },
  });
  assertOk(res, `PATCH /api/admin/policies invitePolicy=${invitePolicy}`);
}

/** PATCH /api/folders/:id — owner/co-owner folder invite policy override. */
export async function updateFolderInvitePolicy(
  actor: ApiActor,
  folderId: string,
  invitePolicy: InvitePolicy | null
): Promise<void> {
  const res = await actor.api.patch(
    `/api/folders/${encodeURIComponent(folderId)}`,
    { data: { invitePolicy } }
  );
  assertOk(
    res,
    `PATCH /api/folders/${folderId} invitePolicy=${String(invitePolicy)}`
  );
}

/** DELETE /api/folders/:id — soft delete a folder subtree for E2E fixtures. */export async function softDeleteFolder(
  actor: ApiActor,
  folderId: string
): Promise<void> {
  const res = await actor.api.delete(
    `/api/folders/${encodeURIComponent(folderId)}`
  );
  expect(
    res.ok(),
    `DELETE /api/folders/${folderId} failed with HTTP ${res.status()}`
  ).toBe(true);
}

/** Best-effort teardown: soft-deletes a test-created folder subtree. */
export async function deleteFolderQuietly(
  actor: ApiActor,
  folderId: string
): Promise<void> {
  try {
    const res = await actor.api.delete(
      `/api/folders/${encodeURIComponent(folderId)}`
    );
    if (!res.ok() && res.status() !== 404) {
      console.warn(
        `[e2e] cleanup DELETE /api/folders/${folderId} returned HTTP ${res.status()}`
      );
    }
  } catch (err) {
    console.warn(`[e2e] cleanup failed for folder ${folderId}:`, err);
  }
}

export interface GuestPolicyPayload {
  allowExternalCollaborators?: boolean;
  allowGuestElevatedRoles?: boolean;
  externalDomainAllowlist?: string[];
  guestInvitationExpiryDays?: number;
  guestSessionMaxHours?: number;
  externalDomainExistingGuestMode?: 'reject_new_only' | 'suspend_existing';
}

export interface GuestPolicyResponse {
  policy: {
    allowExternalCollaborators: boolean;
    allowGuestElevatedRoles: boolean;
    externalDomainAllowlist: string[];
    guestInvitationExpiryDays: number;
    guestSessionMaxHours: number;
    externalDomainExistingGuestMode?: 'reject_new_only' | 'suspend_existing';
  };
  externalDomainPolicy?: {
    mode: 'reject_new_only' | 'suspend_existing';
    affectedGuestCount: number;
    suspendedGuestIds: string[];
  };
}

/** PATCH /api/admin/policies — tenant external guest policy. */
export async function updateGuestPolicy(
  actor: ApiActor,
  payload: GuestPolicyPayload
): Promise<GuestPolicyResponse> {
  const res = await actor.api.patch('/api/admin/policies', { data: payload });
  assertOk(res, `PATCH /api/admin/policies guest policy ${JSON.stringify(payload)}`);
  return (await res.json()) as GuestPolicyResponse;
}

export interface GuestInvitationLike {
  id: string;
  userId: string | null;
  email: string;
  displayName: string;
  externalOrg: string | null;
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string | null;
  role: PermissionRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  resendCount: number;
}

export interface GuestInvitationCreateResponse {
  invitation: GuestInvitationLike;
}

/** POST /api/guests/invitations — returns the raw response for status assertions. */
export function postGuestInvitation(
  actor: ApiActor,
  input: {
    email: string;
    displayName?: string;
    externalOrg?: string | null;
    targetType: 'folder' | 'file';
    targetId: string;
    role: PermissionRole;
  }
): ReturnType<APIRequestContext['post']> {
  return actor.api.post('/api/guests/invitations', { data: input });
}

/** POST /api/guests/invitations — asserts 201 and returns the created invitation. */
export async function createGuestInvitation(
  actor: ApiActor,
  input: {
    email: string;
    displayName?: string;
    externalOrg?: string | null;
    targetType: 'folder' | 'file';
    targetId: string;
    role: PermissionRole;
  }
): Promise<GuestInvitationLike> {
  const res = await postGuestInvitation(actor, input);
  expect(res.status(), `POST /api/guests/invitations for ${input.email} should return 201`).toBe(201);
  const body = (await res.json()) as GuestInvitationCreateResponse;
  return body.invitation;
}

export async function resendGuestInvitation(
  actor: ApiActor,
  invitationId: string
): Promise<GuestInvitationLike> {
  const res = await actor.api.post(
    `/api/guests/invitations/${encodeURIComponent(invitationId)}/resend`
  );
  assertOk(res, `POST /api/guests/invitations/${invitationId}/resend`);
  const body = (await res.json()) as GuestInvitationCreateResponse;
  return body.invitation;
}

export async function revokeGuestInvitation(
  actor: ApiActor,
  invitationId: string
): Promise<GuestInvitationLike> {
  const res = await actor.api.post(
    `/api/guests/invitations/${encodeURIComponent(invitationId)}/revoke`
  );
  assertOk(res, `POST /api/guests/invitations/${invitationId}/revoke`);
  const body = (await res.json()) as { invitation: GuestInvitationLike };
  return body.invitation;
}

export interface DevGuestMail {
  id: string;
  kind: 'guest_invitation' | 'guest_otp';
  to: string;
  subject: string;
  text: string;
  token: string | null;
  otpCode: string | null;
  acceptUrl: string | null;
  createdAt: string;
}

/** Local-only `/auth/dev-guest-mails` reader (playwright API context is loopback). */
export async function listDevGuestMails(
  actor: ApiActor,
  params: { to: string; kind?: 'guest_invitation' | 'guest_otp' }
): Promise<DevGuestMail[]> {
  const qs = new URLSearchParams({ to: params.to });
  if (params.kind) qs.set('kind', params.kind);
  const res = await actor.api.get(`/auth/dev-guest-mails?${qs.toString()}`);
  assertOk(res, 'GET /auth/dev-guest-mails');
  const body = (await res.json()) as { mails: DevGuestMail[] };
  return body.mails;
}

/** Polls the local mail sink until at least one matching message exists. */
export async function waitForDevGuestMail(
  actor: ApiActor,
  params: { to: string; kind: 'guest_invitation' | 'guest_otp' }
): Promise<DevGuestMail> {
  let found: DevGuestMail | undefined;
  await expect
    .poll(
      async () => {
        const mails = await listDevGuestMails(actor, params);
        found = mails[0];
        return Boolean(found);
      },
      {
        timeout: 15_000,
        message: `expected a ${params.kind} mail for ${params.to}`,
      }
    )
    .toBe(true);
  return found!;
}

/** POST /api/guests/invitations/:id/revoke with expected 403 helper. */
export async function expectGuestInvitationStatus(
  actor: ApiActor,
  input: {
    email: string;
    targetType: 'folder' | 'file';
    targetId: string;
    role: PermissionRole;
  },
  status: number
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await postGuestInvitation(actor, input);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  expect(res.status(), `guest invitation for ${input.email} should return ${status}`).toBe(status);
  return { status: res.status(), body };
}

/* ------------------------------------------------------------------ */
/* P10-3 / TOM-61 admin guest lifecycle helpers                        */
/* ------------------------------------------------------------------ */

export interface AdminGuestListItem {
  id: string;
  email: string;
  displayName: string;
  externalOrg: string | null;
  status: 'active' | 'suspended' | 'expired' | 'pending_invite' | 'offboarded';
  invitedBy: string | null;
  invitedByName: string | null;
  invitedByEmail: string | null;
  expiresAt: string | null;
  lastLoginAt: string | null;
  offboardedAt: string | null;
  domain: string | null;
  allowedByPolicy: boolean;
  pendingInvitationCount: number;
}

export interface AdminGuestListLike {
  guests: AdminGuestListItem[];
  total: number;
  summary: {
    total: number;
    byStatus: Record<string, number>;
    byDomain: Array<{
      domain: string;
      count: number;
      active: number;
      suspended: number;
      expired: number;
      allowedByPolicy: boolean;
    }>;
    byInviter: Array<{
      inviterId: string;
      inviterName: string;
      inviterEmail: string | null;
      count: number;
      active: number;
      suspended: number;
      expired: number;
    }>;
  };
}

export interface AdminGuestDetailLike {
  guest: AdminGuestListItem & {
    accountStatus: 'active' | 'suspended';
    domainAllowedByPolicy: boolean;
    offboardedBy: string | null;
  };
  permissions: {
    direct: Array<Record<string, unknown>>;
    inherited: Array<Record<string, unknown>>;
  };
  sharedItems: Array<{
    itemType: 'folder' | 'file';
    id: string;
    name: string;
    classification: string;
    dlpProtected: boolean;
    effectiveRole: string | null;
  }>;
  recentAuditLogs: Array<{ id: string; action: string }>;
  pendingInvitationId: string | null;
}

export function adminGuestIdempotencyKey(action: string, guestId: string): string {
  return `e2e-guest-${action}-${guestId}-${crypto.randomUUID()}`;
}

export async function listAdminGuests(
  actor: ApiActor,
  query: Record<string, string | number> = {}
): Promise<AdminGuestListLike> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    qs.set(key, String(value));
  }
  const res = await actor.api.get(
    `/api/admin/guests${qs.toString() ? `?${qs.toString()}` : ''}`
  );
  assertOk(res, 'GET /api/admin/guests');
  return (await res.json()) as AdminGuestListLike;
}

export async function findAdminGuestByEmail(
  actor: ApiActor,
  email: string
): Promise<AdminGuestListItem> {
  const body = await listAdminGuests(actor, { query: email, limit: 200 });
  const guest = body.guests.find((item) => item.email === email);
  expect(guest, `admin guest list should contain ${email}`).toBeTruthy();
  return guest!;
}

export async function getAdminGuestDetail(
  actor: ApiActor,
  guestId: string
): Promise<AdminGuestDetailLike> {
  const res = await actor.api.get(
    `/api/admin/guests/${encodeURIComponent(guestId)}`
  );
  assertOk(res, `GET /api/admin/guests/${guestId}`);
  return (await res.json()) as AdminGuestDetailLike;
}

export async function suspendAdminGuestApi(
  actor: ApiActor,
  guestId: string
): Promise<void> {
  const key = adminGuestIdempotencyKey('suspend', guestId);
  const res = await actor.api.post(
    `/api/admin/guests/${encodeURIComponent(guestId)}/suspend`,
    { headers: { 'Idempotency-Key': key }, data: { idempotencyKey: key } }
  );
  assertOk(res, `POST /api/admin/guests/${guestId}/suspend`);
}

export async function resumeAdminGuestApi(
  actor: ApiActor,
  guestId: string,
  extendDays = 30
): Promise<void> {
  const key = adminGuestIdempotencyKey('resume', guestId);
  const res = await actor.api.post(
    `/api/admin/guests/${encodeURIComponent(guestId)}/resume`,
    {
      headers: { 'Idempotency-Key': key },
      data: { idempotencyKey: key, extendDays },
    }
  );
  assertOk(res, `POST /api/admin/guests/${guestId}/resume`);
}

export async function resendAdminGuestInviteApi(
  actor: ApiActor,
  guestId: string
): Promise<void> {
  const key = adminGuestIdempotencyKey('resend', guestId);
  const res = await actor.api.post(
    `/api/admin/guests/${encodeURIComponent(guestId)}/resend-invite`,
    { headers: { 'Idempotency-Key': key }, data: { idempotencyKey: key } }
  );
  assertOk(res, `POST /api/admin/guests/${guestId}/resend-invite`);
}

export async function offboardAdminGuestApi(
  actor: ApiActor,
  guestId: string
): Promise<{
  sessionsRevoked: number;
  invitationsRevoked: number;
  permissionsDeleted: number;
}> {
  const key = adminGuestIdempotencyKey('offboard', guestId);
  const res = await actor.api.delete(
    `/api/admin/guests/${encodeURIComponent(guestId)}`,
    { headers: { 'Idempotency-Key': key }, data: { idempotencyKey: key } }
  );
  assertOk(res, `DELETE /api/admin/guests/${guestId}`);
  return (await res.json()) as {
    sessionsRevoked: number;
    invitationsRevoked: number;
    permissionsDeleted: number;
  };
}

/* ------------------------------------------------------------------ */
/* P11-2 / TOM-64 admin internal member helpers                        */
/* ------------------------------------------------------------------ */

export type AdminMemberRole = 'sys_admin' | 'sec_admin' | 'member';

export interface AdminMemberListItem {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
  role: AdminMemberRole;
  status: 'active' | 'suspended';
  storageQuotaBytes: number | null;
  usedBytes: number;
  fileCount: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AdminMemberListLike {
  users: AdminMemberListItem[];
  total: number;
  summary: {
    total: number;
    byStatus: Record<string, number>;
    byRole: Record<string, number>;
    departments: Array<{ department: string | null; count: number }>;
  };
}

export interface AdminMemberDetailLike {
  user: AdminMemberListItem & { updatedAt: string };
  rootFolders: Array<{ id: string; name: string; classification: string }>;
  groups: Array<{ id: string; name: string }>;
  activeSessionCount: number;
  recentAuditLogs: Array<{ id: string; action: string }>;
}

export interface AdminMemberBulkImportLike {
  ok: boolean;
  dryRun: boolean;
  replayed: boolean;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  errorCount: number;
  results: Array<{
    rowNumber: number;
    email: string;
    action: 'create' | 'update' | 'unchanged' | 'error';
    code?: string;
    error?: string;
  }>;
  notice: string;
}

export function adminMemberIdempotencyKey(
  action: string,
  memberId: string
): string {
  return `e2e-member-${action}-${memberId}-${crypto.randomUUID()}`;
}

export async function listAdminMembers(
  actor: ApiActor,
  query: Record<string, string | number> = {}
): Promise<AdminMemberListLike> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    qs.set(key, String(value));
  }
  const res = await actor.api.get(
    `/api/admin/users${qs.toString() ? `?${qs.toString()}` : ''}`
  );
  assertOk(res, 'GET /api/admin/users');
  return (await res.json()) as AdminMemberListLike;
}

export async function findAdminMemberByEmail(
  actor: ApiActor,
  email: string
): Promise<AdminMemberListItem> {
  const body = await listAdminMembers(actor, { query: email, limit: 200 });
  const member = body.users.find((item) => item.email === email);
  expect(member, `admin member list should contain ${email}`).toBeTruthy();
  return member!;
}

export async function createAdminMemberApi(
  actor: ApiActor,
  input: {
    email: string;
    displayName: string;
    department?: string | null;
    role?: AdminMemberRole;
    storageQuotaBytes?: number | null;
  }
): Promise<AdminMemberListItem> {
  const res = await actor.api.post('/api/admin/users', {
    data: {
      email: input.email,
      displayName: input.displayName,
      department: input.department ?? null,
      role: input.role ?? 'member',
      storageQuotaBytes: input.storageQuotaBytes ?? null,
    },
  });
  expect(res.status(), `POST /api/admin/users for ${input.email}`).toBe(201);
  const body = (await res.json()) as { user: AdminMemberListItem };
  return body.user;
}

export async function getAdminMemberDetail(
  actor: ApiActor,
  memberId: string
): Promise<AdminMemberDetailLike> {
  const res = await actor.api.get(
    `/api/admin/users/${encodeURIComponent(memberId)}`
  );
  assertOk(res, `GET /api/admin/users/${memberId}`);
  return (await res.json()) as AdminMemberDetailLike;
}

export async function suspendAdminMemberApi(
  actor: ApiActor,
  memberId: string
): Promise<{ sessionsRevoked: number }> {
  const key = adminMemberIdempotencyKey('suspend', memberId);
  const res = await actor.api.post(
    `/api/admin/users/${encodeURIComponent(memberId)}/suspend`,
    { headers: { 'Idempotency-Key': key }, data: { idempotencyKey: key } }
  );
  assertOk(res, `POST /api/admin/users/${memberId}/suspend`);
  return (await res.json()) as { sessionsRevoked: number };
}

export async function resumeAdminMemberApi(
  actor: ApiActor,
  memberId: string
): Promise<void> {
  const key = adminMemberIdempotencyKey('resume', memberId);
  const res = await actor.api.post(
    `/api/admin/users/${encodeURIComponent(memberId)}/resume`,
    { headers: { 'Idempotency-Key': key }, data: { idempotencyKey: key } }
  );
  assertOk(res, `POST /api/admin/users/${memberId}/resume`);
}

export async function bulkImportAdminMembersApi(
  actor: ApiActor,
  input: {
    csv?: string;
    rows?: Array<Record<string, unknown>>;
    dryRun?: boolean;
    idempotencyKey?: string;
  }
): Promise<AdminMemberBulkImportLike> {
  const headers: Record<string, string> = {};
  if (input.idempotencyKey) {
    headers['Idempotency-Key'] = input.idempotencyKey;
  }
  const res = await actor.api.post('/api/admin/users/bulk-import', {
    headers,
    data: {
      ...(input.csv !== undefined ? { csv: input.csv } : {}),
      ...(input.rows !== undefined ? { rows: input.rows } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
    },
  });
  assertOk(res, 'POST /api/admin/users/bulk-import');
  return (await res.json()) as AdminMemberBulkImportLike;
}
