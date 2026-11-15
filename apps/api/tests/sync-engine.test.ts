import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sha256Hex } from '../src/services/crypto-utils';
import { purgeExpiredSyncChanges } from '../src/services/sync-changes';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-sync';

function authHeaders(
  userId = 'sync-owner',
  role: 'sys_admin' | 'member' = 'sys_admin',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@example.com`,
    'Content-Type': 'application/json',
  };
}

function buildTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'sync-engine-test-secret',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
  } as OidcEnv;
}

async function uploadSmallFile(
  testEnv: OidcEnv,
  folderId: string | null,
  fileName: string,
  content = 'hello sync engine',
  classification?: 'public' | 'internal' | 'confidential' | 'unset'
) {
  const bytes = new TextEncoder().encode(content);
  const initRes = await app.fetch(
    new Request('http://127.0.0.1:8787/api/files/upload-init', {
      method: 'POST',
      headers: authHeaders('sync-owner', 'sys_admin'),
      body: JSON.stringify({
        folderId,
        fileName,
        mimeType: 'text/plain',
        sizeBytes: bytes.byteLength,
        ...(classification ? { classification } : {}),
      }),
    }),
    testEnv
  );
  expect(initRes.status).toBe(201);
  const initData = (await initRes.json()) as {
    fileId: string;
    versionId: string;
    uploadUrl: string;
  };

  const putRes = await app.fetch(
    new Request(`http://127.0.0.1:8787${initData.uploadUrl}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: bytes,
    }),
    testEnv
  );
  expect(putRes.status).toBe(200);

  const completeRes = await app.fetch(
    new Request('http://127.0.0.1:8787/api/files/upload-complete', {
      method: 'POST',
      headers: authHeaders('sync-owner', 'sys_admin'),
      body: JSON.stringify({
        fileId: initData.fileId,
        versionId: initData.versionId,
      }),
    }),
    testEnv
  );
  expect(completeRes.status).toBe(200);
  return (await completeRes.json()) as {
    file: {
      id: string;
      folder_id: string | null;
      name: string;
      classification: string;
      meta_version: number;
    };
  };
}

describe('Sync Engine Bootstrap, RBAC Delta, Optimistic Locking & Purge Horizon (TOM-22)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const scimTokenHash = await sha256Hex('sync-scim-token');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES ('tenant-sync', 'Sync Org', 'sync-org', 1000000)`
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES ('tenant-sync')"
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO scim_tokens (id, tenant_id, idp_issuer, name, token_hash, last_used_at, revoked_at)
         VALUES ('sync-scim-tok-1', 'tenant-sync', 'https://idp.sync.example', 'Sync SCIM Test', ?, NULL, NULL)`
      ).bind(scimTokenHash),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('sync-owner', 'tenant-sync', 'sync-owner@example.com', 'Sync Owner', 'sys_admin', 'active'),
           ('sync-collab', 'tenant-sync', 'sync-collab@example.com', 'Sync Collab', 'member', 'active'),
           ('sync-outsider', 'tenant-sync', 'sync-outsider@example.com', 'Sync Outsider', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES
           ('tenant-sync', 'unset', 0, 0),
           ('tenant-sync', 'public', 0, 0),
           ('tenant-sync', 'internal', 0, 0),
           ('tenant-sync', 'confidential', 0, 0)`
      ),
    ]);
  });

  it('serves single-batch /api/sync/bootstrap, inline breadcrumbs on folder children, and strict RBAC delta isolation', async () => {
    const testEnv = buildTestEnv();

    // Create shared root folder & owner-only confidential root folder
    const sharedRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({ name: 'SharedSpace', classification: 'internal', isPinned: true }),
      }),
      testEnv
    );
    expect(sharedRes.status).toBe(201);
    const sharedFolder = ((await sharedRes.json()) as {
      folder: { id: string; version: number };
    }).folder;

    const secretRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({ name: 'ConfidentialVault', classification: 'confidential' }),
      }),
      testEnv
    );
    expect(secretRes.status).toBe(201);
    const secretFolder = ((await secretRes.json()) as {
      folder: { id: string; version: number };
    }).folder;

    // Grant collab editor access ONLY on SharedSpace
    const grantRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/permissions', {
        method: 'POST',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({
          targetType: 'folder',
          targetId: sharedFolder.id,
          granteeType: 'user',
          granteeId: 'sync-collab',
          role: 'editor',
        }),
      }),
      testEnv
    );
    expect(grantRes.status).toBe(201);
    const permId = ((await grantRes.json()) as { permission: { id: string } }).permission.id;

    // Single-batch bootstrap for collab must NOT expose ConfidentialVault
    const bootRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/sync/bootstrap', {
        headers: authHeaders('sync-collab', 'member'),
      }),
      testEnv
    );
    expect(bootRes.status).toBe(200);
    const boot = (await bootRes.json()) as {
      user: { id: string };
      policy: Record<string, unknown> | null;
      rootFolders: Array<{ id: string; name: string; effectiveRole: string }>;
      pinnedFolders: Array<{ id: string }>;
      currentSeq: number;
      purgedBeforeSeq: number;
    };
    expect(boot.user.id).toBe('sync-collab');
    expect(boot.policy).toBeTruthy();
    expect(boot.rootFolders.map((f) => f.id)).toEqual([sharedFolder.id]);
    expect(boot.rootFolders[0].effectiveRole).toBe('editor');
    expect(boot.pinnedFolders.map((f) => f.id)).toEqual([sharedFolder.id]);
    expect(boot.currentSeq).toBeGreaterThanOrEqual(3);

    const collabStartSeq = boot.currentSeq;

    // Create child folder + upload file into SharedSpace AND upload secret file into ConfidentialVault
    const subRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({ name: 'Specs', parentId: sharedFolder.id }),
      }),
      testEnv
    );
    expect(subRes.status).toBe(201);
    const subFolder = ((await subRes.json()) as { folder: { id: string } }).folder;

    const publicFile = await uploadSmallFile(testEnv, subFolder.id, 'design.txt', 'spec', 'internal');
    const secretFile = await uploadSmallFile(
      testEnv,
      secretFolder.id,
      'm-and-a.txt',
      'top secret merger',
      'confidential'
    );

    // `?include=breadcrumbs` includes breadcrumbs cleanly on first page and meta_version on files
    const childrenWithBc = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${subFolder.id}/children?include=breadcrumbs`, {
        headers: authHeaders('sync-collab', 'member'),
      }),
      testEnv
    );
    expect(childrenWithBc.status).toBe(200);
    const childrenJson = (await childrenWithBc.json()) as {
      breadcrumbs?: Array<{ id: string; name: string }>;
      files: Array<{ id: string; meta_version: number }>;
    };
    expect(childrenJson.breadcrumbs?.map((b) => b.id)).toEqual([sharedFolder.id, subFolder.id]);
    expect(childrenJson.files[0].id).toBe(publicFile.file.id);
    expect(childrenJson.files[0].meta_version).toBe(2);

    // Move publicFile out of SharedSpace/Specs into ConfidentialVault -> emits file.update + file.moved_out
    const moveFileRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${publicFile.file.id}`, {
        method: 'PATCH',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({
          name: 'design-moved.txt',
          folderId: secretFolder.id,
          expectedVersion: publicFile.file.meta_version,
        }),
      }),
      testEnv
    );
    expect(moveFileRes.status).toBe(200);
    const movedFile = ((await moveFileRes.json()) as {
      file: { id: string; folder_id: string; classification: string; meta_version: number; name: string };
    }).file;
    expect(movedFile.classification).toBe('confidential');
    expect(movedFile.name).toBe('design-moved.txt');
    expect(movedFile.meta_version).toBe(publicFile.file.meta_version + 1);

    // Outsider polling delta since 0 sees NOTHING of ConfidentialVault or SharedSpace
    const outsiderDeltaRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/sync/delta?sinceSeq=0', {
        headers: authHeaders('sync-outsider', 'member'),
      }),
      testEnv
    );
    expect(outsiderDeltaRes.status).toBe(200);
    const outsiderDelta = (await outsiderDeltaRes.json()) as {
      resetRequired: boolean;
      changes: Array<{ entityId: string; action: string }>;
    };
    expect(outsiderDelta.resetRequired).toBe(false);
    expect(
      outsiderDelta.changes.some(
        (ch) => ch.entityId === secretFolder.id || ch.entityId === secretFile.file.id
      )
    ).toBe(false);

    // Collab polling delta since collabStartSeq sees subFolder, design.txt, AND file.moved_out (from Specs)
    // but NEVER ConfidentialVault or secretFile
    const collabDeltaRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/sync/delta?sinceSeq=${collabStartSeq}`, {
        headers: authHeaders('sync-collab', 'member'),
      }),
      testEnv
    );
    const collabDelta = (await collabDeltaRes.json()) as {
      changes: Array<{ entityId: string; folderId: string | null; action: string }>;
    };
    expect(collabDelta.changes.some((ch) => ch.entityId === subFolder.id)).toBe(true);
    expect(
      collabDelta.changes.some(
        (ch) => ch.entityId === publicFile.file.id && ch.action === 'file.moved_out' && ch.folderId === subFolder.id
      )
    ).toBe(true);
    expect(
      collabDelta.changes.some(
        (ch) => ch.entityId === secretFile.file.id || ch.entityId === secretFolder.id
      )
    ).toBe(false);

    // Revoking permission emits permission.revoke visible to the affected targetUserId
    const revokeRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/permissions/${permId}`, {
        method: 'DELETE',
        headers: authHeaders('sync-owner', 'sys_admin'),
      }),
      testEnv
    );
    expect(revokeRes.status).toBe(200);

    const collabAfterRevokeRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/sync/delta?sinceSeq=${collabStartSeq}`, {
        headers: authHeaders('sync-collab', 'member'),
      }),
      testEnv
    );
    const collabAfterRevoke = (await collabAfterRevokeRes.json()) as {
      changes: Array<{ entityId: string; action: string; targetUserId: string | null }>;
    };
    expect(
      collabAfterRevoke.changes.some(
        (ch) => ch.entityId === permId && ch.action === 'permission.revoke' && ch.targetUserId === 'sync-collab'
      )
    ).toBe(true);
  });

  it('enforces optimistic locking (409 VERSION_CONFLICT with latest) on folders & files and handles Cron purge horizon resetRequired', async () => {
    const testEnv = buildTestEnv();

    // Create folder v1 -> PATCH to v2 -> stale PATCH(expectedVersion: 1) & DELETE(expectedVersion: 1) return 409 + latest
    const createFld = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({ name: 'LockFolder', classification: 'internal' }),
      }),
      testEnv
    );
    expect(createFld.status).toBe(201);
    const fldV1 = ((await createFld.json()) as { folder: { id: string; version: number; name: string } }).folder;
    expect(fldV1.version).toBe(1);

    const patchOk = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${fldV1.id}`, {
        method: 'PATCH',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({ name: 'LockFolder-v2', expectedVersion: 1 }),
      }),
      testEnv
    );
    expect(patchOk.status).toBe(200);

    const patchConflict = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${fldV1.id}`, {
        method: 'PATCH',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({ name: 'StaleOverwrite', expectedVersion: 1 }),
      }),
      testEnv
    );
    expect(patchConflict.status).toBe(409);
    const patchConflictBody = (await patchConflict.json()) as {
      code: string;
      latest: { id: string; version: number; name: string };
    };
    expect(patchConflictBody.code).toBe('VERSION_CONFLICT');
    expect(patchConflictBody.latest.version).toBe(2);
    expect(patchConflictBody.latest.name).toBe('LockFolder-v2');

    const delFldConflict = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${fldV1.id}?expectedVersion=1`, {
        method: 'DELETE',
        headers: authHeaders('sync-owner', 'sys_admin'),
      }),
      testEnv
    );
    expect(delFldConflict.status).toBe(409);
    const delFldBody = (await delFldConflict.json()) as { code: string; latest: { version: number } };
    expect(delFldBody.code).toBe('VERSION_CONFLICT');
    expect(delFldBody.latest.version).toBe(2);

    // Upload file inside LockFolder and verify file optimistic locking on rename, classification, delete
    const uploaded = await uploadSmallFile(testEnv, fldV1.id, 'lock-target.txt', 'v1 body', 'internal');
    const initialMetaVer = uploaded.file.meta_version;

    const clsRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${uploaded.file.id}/classification`, {
        method: 'PATCH',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({ classification: 'confidential', expectedVersion: initialMetaVer }),
      }),
      testEnv
    );
    expect(clsRes.status).toBe(200);
    const clsFile = ((await clsRes.json()) as { file: { meta_version: number; classification: string } }).file;
    expect(clsFile.meta_version).toBe(initialMetaVer + 1);

    const staleRename = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${uploaded.file.id}`, {
        method: 'PATCH',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({ name: 'stale.txt', expectedVersion: initialMetaVer }),
      }),
      testEnv
    );
    expect(staleRename.status).toBe(409);
    const staleRenameJson = (await staleRename.json()) as {
      code: string;
      latest: { meta_version: number; classification: string };
    };
    expect(staleRenameJson.code).toBe('VERSION_CONFLICT');
    expect(staleRenameJson.latest.meta_version).toBe(initialMetaVer + 1);
    expect(staleRenameJson.latest.classification).toBe('confidential');

    const staleDeleteFile = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${uploaded.file.id}?expectedVersion=${initialMetaVer}`,
        {
          method: 'DELETE',
          headers: authHeaders('sync-owner', 'sys_admin'),
        }
      ),
      testEnv
    );
    expect(staleDeleteFile.status).toBe(409);

    // Valid delete with latest meta_version succeeds and records file.soft_delete delta
    const validDeleteFile = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${uploaded.file.id}?expectedVersion=${clsFile.meta_version}`,
        {
          method: 'DELETE',
          headers: authHeaders('sync-owner', 'sys_admin'),
        }
      ),
      testEnv
    );
    expect(validDeleteFile.status).toBe(200);

    // Admin policy patch + SCIM suspend deltas + Purge Horizon check
    const policyRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/admin/policies', {
        method: 'PATCH',
        headers: authHeaders('sync-owner', 'sys_admin'),
        body: JSON.stringify({ maxLinkExpirationDays: 14 }),
      }),
      testEnv
    );
    expect(policyRes.status).toBe(200);

    const scimDelRes = await app.fetch(
      new Request('http://127.0.0.1:8787/scim/v2/Users/sync-outsider', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer sync-scim-token',
        },
      }),
      testEnv
    );
    expect(scimDelRes.status).toBe(204);

    const suspendedChange = await env.DB.prepare(
      `SELECT action, target_user_id FROM sync_changes
        WHERE tenant_id = ? AND entity_type = 'user' AND entity_id = 'sync-outsider'
        ORDER BY seq DESC LIMIT 1`
    )
      .bind(TENANT_ID)
      .first<{ action: string; target_user_id: string }>();
    expect(suspendedChange?.action).toBe('user.suspended');
    expect(suspendedChange?.target_user_id).toBe('sync-outsider');

    // Backdate early sync_changes rows (> 8 days) and run Cron purge
    const oldIso = new Date(Date.now() - 8 * 86_400_000).toISOString();
    const minRow = await env.DB.prepare(
      'SELECT MIN(seq) AS min_seq FROM sync_changes WHERE tenant_id = ?'
    )
      .bind(TENANT_ID)
      .first<{ min_seq: number }>();
    const cutoffSeq = (minRow?.min_seq ?? 1) + 1;

    await env.DB.prepare(
      'UPDATE sync_changes SET created_at = ? WHERE tenant_id = ? AND seq <= ?'
    )
      .bind(oldIso, TENANT_ID, cutoffSeq)
      .run();

    const purged = await purgeExpiredSyncChanges(env.DB, Date.now(), 7);
    expect(purged).toBeGreaterThanOrEqual(2);

    // Client with stale sinceSeq (< purged_before_seq) receives resetRequired: true
    const staleSyncRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/sync/delta?sinceSeq=${cutoffSeq - 1}`, {
        headers: authHeaders('sync-owner', 'sys_admin'),
      }),
      testEnv
    );
    expect(staleSyncRes.status).toBe(200);
    const staleSync = (await staleSyncRes.json()) as {
      resetRequired: boolean;
      purgedBeforeSeq: number;
      currentSeq: number;
      changes: unknown[];
    };
    expect(staleSync.resetRequired).toBe(true);
    expect(staleSync.purgedBeforeSeq).toBe(cutoffSeq);
    expect(staleSync.currentSeq).toBeGreaterThanOrEqual(cutoffSeq);
    expect(staleSync.changes).toEqual([]);
  });
});
