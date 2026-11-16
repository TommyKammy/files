import { expect, type APIRequestContext } from '@playwright/test';

export interface FolderLike {
  id: string;
  name: string;
  parent_id: string | null;
  version: number;
  classification: string;
  effectiveRole?: string;
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
  grantedRoles: PermissionRole[];
  advancedRolesEnabled: boolean;
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
    folderId: string;
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

/** DELETE /api/folders/:id — soft delete a folder subtree for E2E fixtures. */
export async function softDeleteFolder(
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
