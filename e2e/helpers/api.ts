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
  deleted_at?: string | null;
}

interface FolderChildrenResponse {
  folder: FolderLike;
  effectiveRole: string;
  folders: FolderLike[];
  files: FileLike[];
}

interface TrashResponse {
  folders: FolderLike[];
  files: FileLike[];
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
  | 'viewer'
  | 'previewer';

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
}

export interface PermissionListResponse {
  targetType: PermissionTargetType;
  targetId: string;
  effectiveRole: string;
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
        const res = await actor.api.get('/api/folders/trash?limit=100');
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
 * Upload a small file through the same init -> signed PUT -> complete contract
 * used by the browser. Keeps E2E setup fast without bypassing authorization,
 * quota accounting, R2 persistence, FTS indexing, or sync changes.
 */
export async function uploadFile(
  actor: ApiActor,
  input: {
    folderId: string;
    name: string;
    content: string;
    mimeType?: string;
  }
): Promise<FileLike> {
  const mimeType = input.mimeType ?? 'text/plain; charset=utf-8';
  const body = Buffer.from(input.content, 'utf8');

  const initRes = await actor.api.post('/api/files/upload-init', {
    data: {
      folderId: input.folderId,
      fileName: input.name,
      mimeType,
      sizeBytes: body.byteLength,
      conflictPolicy: 'fail',
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
