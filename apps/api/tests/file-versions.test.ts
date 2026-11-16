import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { runDailyMaintenance } from '../src/consumers/maintenance-cron';
import { app } from '../src/index';
import { buildFileVersionRestoreStatements } from '../src/services/file-version-restore';
import type { FileRow, FileVersionRow } from '../src/services/file-upload-common';
import { selectUnreferencedR2Keys } from '../src/services/r2-gc';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-versions';
const OTHER_TENANT_ID = 'tenant-versions-other';
const EDITOR = 'fv-editor';
const VIEWER = 'fv-viewer';
const PREVIEWER = 'fv-previewer';
const OUTSIDER = 'fv-outsider';
const OTHER_EDITOR = 'fv-other-editor';
const INTERNAL_FOLDER = 'fv-folder-internal';
const CONFIDENTIAL_FOLDER = 'fv-folder-confidential';

function authHeaders(
  userId = EDITOR,
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': 'member',
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@example.com`,
    'Content-Type': 'application/json',
  };
}

function buildTestEnv(overrides: Partial<OidcEnv> = {}): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'file-versions-proxy-secret',
    WOPI_TOKEN_SECRET: 'file-versions-wopi-secret',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
    ...overrides,
  } as OidcEnv;
}

interface UploadedVersion {
  fileId: string;
  versionId: string;
  versionNum: number;
  sizeBytes: number;
}

async function uploadVersion(options: {
  testEnv: OidcEnv;
  fileName: string;
  folderId?: string | null;
  mimeType?: string;
  content: string;
  userId?: string;
}): Promise<UploadedVersion> {
  const {
    testEnv,
    fileName,
    folderId = INTERNAL_FOLDER,
    mimeType = 'text/plain',
    content,
    userId = EDITOR,
  } = options;
  const bytes = new TextEncoder().encode(content);

  const initRes = await app.fetch(
    new Request('http://127.0.0.1:8787/api/files/upload-init', {
      method: 'POST',
      headers: authHeaders(userId),
      body: JSON.stringify({
        folderId,
        fileName,
        mimeType,
        sizeBytes: bytes.byteLength,
        conflictPolicy: 'new_version',
      }),
    }),
    testEnv
  );
  expect(initRes.status).toBe(201);
  const initialized = (await initRes.json()) as {
    fileId: string;
    versionId: string;
    versionNum: number;
    uploadUrl: string;
  };

  const putRes = await app.fetch(
    new Request(`http://127.0.0.1:8787${initialized.uploadUrl}`, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: bytes,
    }),
    testEnv
  );
  expect(putRes.status).toBe(200);

  const completeRes = await app.fetch(
    new Request('http://127.0.0.1:8787/api/files/upload-complete', {
      method: 'POST',
      headers: authHeaders(userId),
      body: JSON.stringify({
        fileId: initialized.fileId,
        versionId: initialized.versionId,
      }),
    }),
    testEnv
  );
  expect(completeRes.status).toBe(200);

  return {
    fileId: initialized.fileId,
    versionId: initialized.versionId,
    versionNum: initialized.versionNum,
    sizeBytes: bytes.byteLength,
  };
}

async function fetchSignedContent(
  testEnv: OidcEnv,
  url: string
): Promise<{ response: Response; text: string }> {
  const response = await app.fetch(
    new Request(`http://127.0.0.1:8787${url}`),
    testEnv
  );
  const bytes = await response.arrayBuffer();
  return { response, text: new TextDecoder().decode(bytes) };
}

async function openSyncWebSocket(
  testEnv: OidcEnv,
  userId = EDITOR
): Promise<{
  ws: WebSocket;
  messages: string[];
  waitForMessages: (minCount: number, timeoutMs?: number) => Promise<string[]>;
}> {
  const ticketRes = await app.fetch(
    new Request('http://127.0.0.1:8787/api/sync/ws-ticket', {
      method: 'POST',
      headers: authHeaders(userId),
    }),
    testEnv
  );
  expect(ticketRes.status).toBe(200);
  const ticketBody = (await ticketRes.json()) as { ticket: string; wsUrl: string };

  const wsRes = await app.fetch(
    new Request(ticketBody.wsUrl.replace('ws://', 'http://'), {
      headers: {
        Upgrade: 'websocket',
        Origin: 'http://127.0.0.1:8787',
      },
    }),
    testEnv
  );
  expect(wsRes.status).toBe(101);
  const ws = wsRes.webSocket;
  expect(ws).toBeTruthy();

  const messages: string[] = [];
  ws!.addEventListener('message', (event) => {
    messages.push(typeof event.data === 'string' ? event.data : String(event.data));
  });
  ws!.accept();

  const waitForMessages = async (minCount: number, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    while (messages.length < minCount && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    return messages;
  };

  return { ws: ws!, messages, waitForMessages };
}

async function closeSyncWebSocket(ws: WebSocket | undefined): Promise<void> {
  if (!ws) return;
  try {
    ws.close(1000, 'test_cleanup');
  } catch {
    // Already closed
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('File version history, historical content URLs and CoW restore (TOM-46)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES
           (?, 'Version History Org', 'version-history-org', 1000000000000),
           (?, 'Other Version Org', 'other-version-org', 1000000000000)`
      ).bind(TENANT_ID, OTHER_TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id, require_watermark_confidential, trash_retention_days)
         VALUES (?, 1, 7), (?, 1, 7)`
      ).bind(TENANT_ID, OTHER_TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           (?, ?, 'fv-editor@example.com', 'Version Editor', 'member', 'active'),
           (?, ?, 'fv-viewer@example.com', 'Version Viewer', 'member', 'active'),
           (?, ?, 'fv-previewer@example.com', 'Version Previewer', 'member', 'active'),
           (?, ?, 'fv-outsider@example.com', 'Version Outsider', 'member', 'active'),
           (?, ?, 'fv-other-editor@example.com', 'Other Editor', 'sys_admin', 'active')`
      ).bind(
        EDITOR,
        TENANT_ID,
        VIEWER,
        TENANT_ID,
        PREVIEWER,
        TENANT_ID,
        OUTSIDER,
        TENANT_ID,
        OTHER_EDITOR,
        OTHER_TENANT_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES
           (?, ?, NULL, 'Version Internal', 0, 1, 'internal', ?),
           (?, ?, NULL, 'Version Confidential', 0, 1, 'confidential', ?)`
      ).bind(
        INTERNAL_FOLDER,
        TENANT_ID,
        EDITOR,
        CONFIDENTIAL_FOLDER,
        TENANT_ID,
        EDITOR
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           (?, ?, ?, 0),
           (?, ?, ?, 0)`
      ).bind(
        TENANT_ID,
        INTERNAL_FOLDER,
        INTERNAL_FOLDER,
        TENANT_ID,
        CONFIDENTIAL_FOLDER,
        CONFIDENTIAL_FOLDER
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('fv-p-editor-int', ?, 'folder', ?, 'user', ?, 'editor', ?),
           ('fv-p-viewer-int', ?, 'folder', ?, 'user', ?, 'viewer', ?),
           ('fv-p-preview-int', ?, 'folder', ?, 'user', ?, 'previewer', ?),
           ('fv-p-editor-conf', ?, 'folder', ?, 'user', ?, 'editor', ?),
           ('fv-p-viewer-conf', ?, 'folder', ?, 'user', ?, 'viewer', ?),
           ('fv-p-preview-conf', ?, 'folder', ?, 'user', ?, 'previewer', ?)`
      ).bind(
        TENANT_ID,
        INTERNAL_FOLDER,
        EDITOR,
        EDITOR,
        TENANT_ID,
        INTERNAL_FOLDER,
        VIEWER,
        EDITOR,
        TENANT_ID,
        INTERNAL_FOLDER,
        PREVIEWER,
        EDITOR,
        TENANT_ID,
        CONFIDENTIAL_FOLDER,
        EDITOR,
        EDITOR,
        TENANT_ID,
        CONFIDENTIAL_FOLDER,
        VIEWER,
        EDITOR,
        TENANT_ID,
        CONFIDENTIAL_FOLDER,
        PREVIEWER,
        EDITOR
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES (?, 'unset', 0, 0), (?, 'public', 0, 0), (?, 'internal', 0, 0), (?, 'confidential', 0, 0)`
      ).bind(TENANT_ID, TENANT_ID, TENANT_ID, TENANT_ID),
    ]);
  });

  it('lists versions newest-first with keyset pagination and never exposes R2 object keys', async () => {
    const testEnv = buildTestEnv();

    const v1 = await uploadVersion({
      testEnv,
      fileName: 'list-flow.txt',
      content: 'version-one',
      mimeType: 'text/plain',
    });
    const v2 = await uploadVersion({
      testEnv,
      fileName: 'list-flow.txt',
      content: 'version-two-is-longer',
      mimeType: 'application/pdf',
    });
    const v3 = await uploadVersion({
      testEnv,
      fileName: 'list-flow.txt',
      content: 'v3',
      mimeType: 'text/csv',
    });

    const listRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${v1.fileId}/versions`, {
        headers: authHeaders(PREVIEWER),
      }),
      testEnv
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      versions: Array<Record<string, unknown>>;
      nextCursor: string | null;
      hasMore: boolean;
    };

    expect(listBody.versions.map((v) => v.id)).toEqual([
      v3.versionId,
      v2.versionId,
      v1.versionId,
    ]);
    expect(listBody.versions.map((v) => v.versionNum)).toEqual([3, 2, 1]);
    expect(listBody.versions.map((v) => v.isCurrent)).toEqual([true, false, false]);
    expect(listBody.versions[0].uploadedBy).toBe(EDITOR);
    expect(listBody.versions[0].uploadedByName).toBe('Version Editor');
    expect(listBody.versions[0].uploadStatus).toBe('completed');
    expect(listBody.versions[0].sizeBytes).toBe(v3.sizeBytes);
    expect(listBody.versions[0].mimeType).toBe('text/csv');
    expect(Object.keys(listBody.versions[0]).sort()).toEqual(
      [
        'createdAt',
        'id',
        'isCurrent',
        'mimeType',
        'sizeBytes',
        'uploadStatus',
        'uploadedBy',
        'uploadedByName',
        'versionNum',
      ].sort()
    );
    expect(listBody.nextCursor).toBeNull();
    expect(listBody.hasMore).toBe(false);

    const serialized = JSON.stringify(listBody);
    expect(serialized).not.toContain('r2_object_key');
    expect(serialized).not.toContain('r2ObjectKey');
    expect(serialized).not.toContain(`tenants/${TENANT_ID}/objects/`);

    const page1Res = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${v1.fileId}/versions?limit=2`,
        { headers: authHeaders(EDITOR) }
      ),
      testEnv
    );
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      versions: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page1.versions.map((v) => v.id)).toEqual([v3.versionId, v2.versionId]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    const page2Res = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${v1.fileId}/versions?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`,
        { headers: authHeaders(EDITOR) }
      ),
      testEnv
    );
    expect(page2Res.status).toBe(200);
    const page2 = (await page2Res.json()) as {
      versions: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page2.versions.map((v) => v.id)).toEqual([v1.versionId]);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();

    const clampedRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${v1.fileId}/versions?limit=999`,
        { headers: authHeaders(EDITOR) }
      ),
      testEnv
    );
    expect(clampedRes.status).toBe(200);
    expect(
      ((await clampedRes.json()) as { versions: unknown[] }).versions.length
    ).toBe(3);

    const invalidCursorRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${v1.fileId}/versions?cursor=not-a-cursor`,
        { headers: authHeaders(EDITOR) }
      ),
      testEnv
    );
    expect(invalidCursorRes.status).toBe(400);

    // Existing metadata endpoint contract stays intact and omits R2 keys.
    const detailRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${v1.fileId}`, {
        headers: authHeaders(PREVIEWER),
      }),
      testEnv
    );
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      file: { id: string; current_version_num: number };
      effectiveRole: string;
      canDownload: boolean;
      versions: Array<Record<string, unknown>>;
    };
    expect(detail.file.id).toBe(v1.fileId);
    expect(detail.file.current_version_num).toBe(3);
    expect(detail.effectiveRole).toBe('previewer');
    expect(detail.canDownload).toBe(false);
    expect(detail.versions).toHaveLength(3);
    expect(JSON.stringify(detail.versions)).not.toContain('r2_object_key');

    // Soft-deleted files are not enumerable.
    const deleted = await uploadVersion({
      testEnv,
      fileName: 'list-deleted.txt',
      content: 'soon-deleted',
    });
    const deleteRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${deleted.fileId}`, {
        method: 'DELETE',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(deleteRes.status).toBe(200);
    const deletedListRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${deleted.fileId}/versions`, {
        headers: authHeaders(EDITOR),
      }),
      testEnv
    );
    expect(deletedListRes.status).toBe(404);
    const deletedContentRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${deleted.fileId}/versions/${deleted.versionId}/content-url`,
        { headers: authHeaders(EDITOR) }
      ),
      testEnv
    );
    expect(deletedContentRes.status).toBe(404);
    const deletedRestoreRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${deleted.fileId}/versions/${deleted.versionId}/restore`,
        { method: 'POST', headers: authHeaders(EDITOR), body: JSON.stringify({}) }
      ),
      testEnv
    );
    expect(deletedRestoreRes.status).toBe(404);
  });

  it('restores a historical version with CoW sharing and protects the shared R2 object from GC', async () => {
    const testEnv = buildTestEnv();
    const v1Content = 'COW-PAYLOAD-V1';
    const v1 = await uploadVersion({
      testEnv,
      fileName: 'cow-flow.pdf',
      content: v1Content,
      mimeType: 'application/pdf',
    });
    const v2 = await uploadVersion({
      testEnv,
      fileName: 'cow-flow.pdf',
      content: 'COW-PAYLOAD-V2-IS-LONGER',
      mimeType: 'application/pdf',
    });
    const v3 = await uploadVersion({
      testEnv,
      fileName: 'cow-flow.pdf',
      content: 'COW-PAYLOAD-V3-MEDIUM',
      mimeType: 'application/pdf',
    });

    const beforeRestore = await env.DB.prepare(
      'SELECT meta_version FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ meta_version: number }>();
    expect(beforeRestore).toBeTruthy();

    const restoreRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${v1.fileId}/versions/${v1.versionId}/restore`,
        { method: 'POST', headers: authHeaders(EDITOR), body: JSON.stringify({}) }
      ),
      testEnv
    );
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as {
      ok: boolean;
      file: {
        id: string;
        current_version_id: string;
        current_version_num: number;
        size_bytes: number;
        meta_version: number;
      };
      version: {
        id: string;
        versionNum: number;
        sizeBytes: number;
        isCurrent: boolean;
        uploadedBy: string;
        uploadedByName: string | null;
        uploadStatus: string;
        restoredFromVersionNum: number;
      };
      restoredFromVersionId: string;
      restoredFromVersionNum: number;
    };

    expect(restored.ok).toBe(true);
    expect(restored.version.versionNum).toBe(4);
    expect(restored.version.sizeBytes).toBe(v1.sizeBytes);
    expect(restored.version.isCurrent).toBe(true);
    expect(restored.version.uploadedBy).toBe(EDITOR);
    expect(restored.version.uploadedByName).toBe('Version Editor');
    expect(restored.version.uploadStatus).toBe('completed');
    expect(restored.version.restoredFromVersionNum).toBe(1);
    expect(restored.restoredFromVersionId).toBe(v1.versionId);
    expect(restored.restoredFromVersionNum).toBe(1);
    expect(restored.file.current_version_id).toBe(restored.version.id);
    expect(restored.file.current_version_num).toBe(4);
    expect(restored.file.size_bytes).toBe(v1.sizeBytes);
    expect(restored.file.meta_version).toBe(beforeRestore!.meta_version + 1);
    expect(JSON.stringify(restored)).not.toContain('r2_object_key');
    expect(JSON.stringify(restored)).not.toContain('r2ObjectKey');

    const listRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${v1.fileId}/versions`, {
        headers: authHeaders(EDITOR),
      }),
      testEnv
    );
    const listBody = (await listRes.json()) as {
      versions: Array<{ id: string; isCurrent: boolean; versionNum: number }>;
    };
    expect(listBody.versions.map((v) => v.versionNum)).toEqual([4, 3, 2, 1]);
    expect(listBody.versions.map((v) => v.isCurrent)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(listBody.versions.map((v) => v.id)).toContain(v1.versionId);
    expect(listBody.versions.map((v) => v.id)).toContain(v2.versionId);
    expect(listBody.versions.map((v) => v.id)).toContain(v3.versionId);

    // Restored content reads back the exact v1 bytes through the signed proxy.
    const contentUrlRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${v1.fileId}/versions/${restored.version.id}/content-url?intent=preview`,
        { headers: authHeaders(EDITOR) }
      ),
      testEnv
    );
    expect(contentUrlRes.status).toBe(200);
    const contentUrl = (await contentUrlRes.json()) as {
      url: string;
      versionId: string;
      versionNum: number;
      disposition: string;
      requireWatermark: boolean;
    };
    expect(contentUrl.versionId).toBe(restored.version.id);
    expect(contentUrl.versionNum).toBe(4);
    expect(contentUrl.requireWatermark).toBe(false);
    const fetched = await fetchSignedContent(testEnv, contentUrl.url);
    expect(fetched.response.status).toBe(200);
    expect(fetched.text).toBe(v1Content);

    const keyRows = await env.DB.prepare(
      `SELECT id, version_num, r2_object_key
         FROM file_versions
        WHERE tenant_id = ? AND file_id = ?
        ORDER BY version_num ASC`
    )
      .bind(TENANT_ID, v1.fileId)
      .all<{ id: string; version_num: number; r2_object_key: string }>();
    expect(keyRows.results).toHaveLength(4);
    const sourceKey = keyRows.results[0].r2_object_key;
    const currentKey = keyRows.results[3].r2_object_key;
    expect(currentKey).toBe(sourceKey);
    expect(keyRows.results[1].r2_object_key).not.toBe(sourceKey);
    expect(keyRows.results[2].r2_object_key).not.toBe(sourceKey);

    // CoW reference accounting: the source row alone is protected while v4 still points at it.
    const protectedKeys = await selectUnreferencedR2Keys(env.DB, [
      { id: v1.versionId, r2_object_key: sourceKey },
    ]);
    expect(protectedKeys).toEqual([]);
    const bothDeletable = await selectUnreferencedR2Keys(env.DB, [
      { id: v1.versionId, r2_object_key: sourceKey },
      { id: restored.version.id, r2_object_key: sourceKey },
    ]);
    expect(bothDeletable).toEqual([sourceKey]);

    // A second file referencing the same CoW key proves runDailyMaintenance keeps it alive.
    const copyFileId = 'fv-cow-copy';
    const copyVersionId = 'fv-cow-copy-v1';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, classification,
           created_by, updated_by
         ) VALUES (?, ?, ?, 'cow-copy.pdf', 'pdf', 'application/pdf', ?, 'active', ?, 1, 'internal', ?, ?)`
      ).bind(
        copyFileId,
        TENANT_ID,
        INTERNAL_FOLDER,
        v1.sizeBytes,
        copyVersionId,
        EDITOR,
        EDITOR
      ),
      env.DB.prepare(
        `INSERT INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key, size_bytes,
           mime_type, upload_status, uploaded_by
         ) VALUES (?, ?, ?, 1, ?, ?, 'application/pdf', 'completed', ?)`
      ).bind(
        copyVersionId,
        TENANT_ID,
        copyFileId,
        sourceKey,
        v1.sizeBytes,
        EDITOR
      ),
      env.DB.prepare(
        `INSERT INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by
         ) VALUES ('fv-perm-cow-copy', ?, 'file', ?, 'user', ?, 'editor', ?)`
      ).bind(TENANT_ID, copyFileId, EDITOR, EDITOR),
    ]);

    const oldDeletedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    await env.DB.prepare('UPDATE files SET deleted_at = ? WHERE tenant_id = ? AND id = ?')
      .bind(oldDeletedAt, TENANT_ID, v1.fileId)
      .run();
    await runDailyMaintenance(buildTestEnv(), new Date());

    expect(
      await env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(v1.fileId).first()
    ).toBeNull();
    expect(await env.BUCKET.head(sourceKey)).not.toBeNull();
    expect(
      await env.DB.prepare('SELECT id FROM file_versions WHERE file_id = ?')
        .bind(v1.fileId)
        .first()
    ).toBeNull();

    await env.DB.prepare('UPDATE files SET deleted_at = ? WHERE tenant_id = ? AND id = ?')
      .bind(oldDeletedAt, TENANT_ID, copyFileId)
      .run();
    await runDailyMaintenance(buildTestEnv(), new Date());
    expect(await env.BUCKET.head(sourceKey)).toBeNull();
  });

  it('applies signed size deltas, MIME switches, FTS refresh, sync_changes, audit logs and TenantSyncHub signals on restore', async () => {
    const testEnv = buildTestEnv();
    const v1Content = 'A'.repeat(64);
    const v2Content = 'B'.repeat(4096);
    const v3Content = 'C'.repeat(128);

    const v1 = await uploadVersion({
      testEnv,
      fileName: 'restore-effects.txt',
      content: v1Content,
      mimeType: 'text/plain',
    });
    const v2 = await uploadVersion({
      testEnv,
      fileName: 'restore-effects.txt',
      content: v2Content,
      mimeType: 'application/pdf',
    });
    const v3 = await uploadVersion({
      testEnv,
      fileName: 'restore-effects.txt',
      content: v3Content,
      mimeType: 'text/csv',
    });

    const initialStats = await env.DB.prepare(
      `SELECT file_count, total_bytes FROM tenant_storage_stats
        WHERE tenant_id = ? AND classification = 'internal'`
    )
      .bind(TENANT_ID)
      .first<{ file_count: number; total_bytes: number }>();
    expect(initialStats).toBeTruthy();

    const beforeRestore = await env.DB.prepare(
      'SELECT meta_version FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ meta_version: number }>();
    expect(beforeRestore).toBeTruthy();

    const ws = await openSyncWebSocket(testEnv);
    try {
      // Grow: v2 (4096) replaces current v3 (128).
      const growRes = await app.fetch(
        new Request(
          `http://127.0.0.1:8787/api/files/${v1.fileId}/versions/${v2.versionId}/restore`,
          { method: 'POST', headers: authHeaders(EDITOR), body: JSON.stringify({}) }
        ),
        testEnv
      );
      expect(growRes.status).toBe(200);
      const grown = (await growRes.json()) as {
        file: { size_bytes: number; mime_type: string; current_version_num: number; meta_version: number };
        version: { versionNum: number; sizeBytes: number };
      };
      expect(grown.file.size_bytes).toBe(v2.sizeBytes);
      expect(grown.file.mime_type).toBe('application/pdf');
      expect(grown.file.current_version_num).toBe(4);
      expect(grown.file.meta_version).toBe(beforeRestore!.meta_version + 1);
      expect(grown.version.versionNum).toBe(4);

      const growStats = await env.DB.prepare(
        `SELECT file_count, total_bytes FROM tenant_storage_stats
          WHERE tenant_id = ? AND classification = 'internal'`
      )
        .bind(TENANT_ID)
        .first<{ file_count: number; total_bytes: number }>();
      expect(growStats).toEqual({
        file_count: initialStats!.file_count,
        total_bytes: initialStats!.total_bytes + (v2.sizeBytes - v3.sizeBytes),
      });

      const growSearchRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/search?q=restore-effects', {
          headers: authHeaders(EDITOR),
        }),
        testEnv
      );
      expect(growSearchRes.status).toBe(200);
      const growSearch = (await growSearchRes.json()) as {
        results: Array<{ id: string; sizeBytes: number; mimeType: string }>;
      };
      expect(growSearch.results.find((r) => r.id === v1.fileId)).toMatchObject({
        sizeBytes: v2.sizeBytes,
        mimeType: 'application/pdf',
      });

      // Shrink: v1 (64) replaces current v2 (4096).
      const shrinkRes = await app.fetch(
        new Request(
          `http://127.0.0.1:8787/api/files/${v1.fileId}/versions/${v1.versionId}/restore`,
          {
            method: 'POST',
            headers: authHeaders(EDITOR),
            body: JSON.stringify({
              expectedVersion: grown.file.meta_version,
            }),
          }
        ),
        testEnv
      );
      expect(shrinkRes.status).toBe(200);
      const shrunk = (await shrinkRes.json()) as {
        file: { size_bytes: number; mime_type: string; current_version_num: number; meta_version: number };
        version: { versionNum: number; sizeBytes: number; restoredFromVersionNum: number };
      };
      expect(shrunk.file.size_bytes).toBe(v1.sizeBytes);
      expect(shrunk.file.mime_type).toBe('text/plain');
      expect(shrunk.file.current_version_num).toBe(5);
      expect(shrunk.file.meta_version).toBe(beforeRestore!.meta_version + 2);
      expect(shrunk.version.versionNum).toBe(5);
      expect(shrunk.version.restoredFromVersionNum).toBe(1);

      const shrinkStats = await env.DB.prepare(
        `SELECT file_count, total_bytes FROM tenant_storage_stats
          WHERE tenant_id = ? AND classification = 'internal'`
      )
        .bind(TENANT_ID)
        .first<{ file_count: number; total_bytes: number }>();
      expect(shrinkStats).toEqual({
        file_count: initialStats!.file_count,
        total_bytes: initialStats!.total_bytes + (v1.sizeBytes - v3.sizeBytes),
      });

      const shrinkSearchRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/search?q=restore-effects', {
          headers: authHeaders(EDITOR),
        }),
        testEnv
      );
      const shrinkSearch = (await shrinkSearchRes.json()) as {
        results: Array<{ id: string; sizeBytes: number; mimeType: string }>;
      };
      expect(shrinkSearch.results.find((r) => r.id === v1.fileId)).toMatchObject({
        sizeBytes: v1.sizeBytes,
        mimeType: 'text/plain',
      });

      const syncRows = await env.DB.prepare(
        `SELECT action, payload_json FROM sync_changes
          WHERE tenant_id = ? AND entity_id = ? AND action = 'file.version_restored'
          ORDER BY seq ASC`
      )
        .bind(TENANT_ID, v1.fileId)
        .all<{ action: string; payload_json: string }>();
      expect(syncRows.results).toHaveLength(2);
      const growPayload = JSON.parse(syncRows.results[0].payload_json) as Record<string, unknown>;
      const shrinkPayload = JSON.parse(syncRows.results[1].payload_json) as Record<string, unknown>;
      expect(growPayload).toMatchObject({
        sizeBytes: v2.sizeBytes,
        mimeType: 'application/pdf',
        currentVersionNum: 4,
        metaVersion: beforeRestore!.meta_version + 1,
        restoredFromVersionNum: 2,
      });
      expect(shrinkPayload).toMatchObject({
        sizeBytes: v1.sizeBytes,
        mimeType: 'text/plain',
        currentVersionNum: 5,
        metaVersion: beforeRestore!.meta_version + 2,
        restoredFromVersionNum: 1,
        restoredFromVersionId: v1.versionId,
      });
      expect(typeof shrinkPayload.updatedAt).toBe('string');

      const auditRows = await env.DB.prepare(
        `SELECT action, target_id, metadata_json FROM audit_logs
          WHERE tenant_id = ? AND target_id = ? AND action = 'file.version.restore'
          ORDER BY rowid ASC`
      )
        .bind(TENANT_ID, v1.fileId)
        .all<{ action: string; target_id: string; metadata_json: string }>();
      expect(auditRows.results).toHaveLength(2);
      const latestAudit = JSON.parse(auditRows.results[1].metadata_json) as Record<string, unknown>;
      expect(latestAudit).toMatchObject({
        fileId: v1.fileId,
        restoredFromVersionId: v1.versionId,
        restoredFromVersionNum: 1,
        newVersionNum: 5,
        versionNum: 5,
        description: 'restored from v1',
      });

      const frames = await ws.waitForMessages(2);
      expect(frames.length).toBeGreaterThanOrEqual(2);
      const restoreFrames = frames
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((frame) => frame.eventKind === 'file.version_restored');
      expect(restoreFrames.length).toBeGreaterThanOrEqual(2);
      for (const frame of restoreFrames) {
        expect(frame.scopeFolderIds).toContain(INTERNAL_FOLDER);
        expect(frame.type).toBe('sync.invalidate');
      }
    } finally {
      await closeSyncWebSocket(ws.ws);
    }

    expect(v3.versionNum).toBe(3);
  });

  it('writes no stats/audit/sync side effects when the optimistic restore guard loses', async () => {
    const testEnv = buildTestEnv();
    const v1 = await uploadVersion({
      testEnv,
      fileName: 'guard-flow.txt',
      content: 'guard-v1',
    });
    await uploadVersion({
      testEnv,
      fileName: 'guard-flow.txt',
      content: 'guard-v2',
    });

    const fileRow = await env.DB.prepare(
      'SELECT * FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, v1.fileId)
      .first<FileRow>();
    const sourceVersion = await env.DB.prepare(
      'SELECT * FROM file_versions WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, v1.versionId)
      .first<FileVersionRow>();
    expect(fileRow).toBeTruthy();
    expect(sourceVersion).toBeTruthy();

    const statsBefore = await env.DB.prepare(
      `SELECT file_count, total_bytes FROM tenant_storage_stats
        WHERE tenant_id = ? AND classification = 'internal'`
    )
      .bind(TENANT_ID)
      .first<{ file_count: number; total_bytes: number }>();
    const auditBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM audit_logs
        WHERE tenant_id = ? AND target_id = ? AND action = 'file.version.restore'`
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ cnt: number }>();
    const syncBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM sync_changes
        WHERE tenant_id = ? AND entity_id = ? AND action = 'file.version_restored'`
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ cnt: number }>();

    const staleVersionId = crypto.randomUUID();
    const batchResults = await env.DB.batch(
      buildFileVersionRestoreStatements({
        db: env.DB,
        user: {
          id: EDITOR,
          tenantId: TENANT_ID,
          email: 'fv-editor@example.com',
          displayName: 'Version Editor',
          role: 'member',
          ipAddress: '127.0.0.1',
          userType: 'member',
        },
        file: {
          ...fileRow!,
          meta_version: fileRow!.meta_version + 100,
        },
        sourceVersion: sourceVersion!,
        newVersionId: staleVersionId,
        newVersionNum: 3,
        nowIso: new Date().toISOString(),
      })
    );

    expect(batchResults[0].meta.changes).toBe(0);
    expect(batchResults[1].meta.changes).toBe(0);
    expect(
      await env.DB.prepare('SELECT id FROM file_versions WHERE id = ?')
        .bind(staleVersionId)
        .first()
    ).toBeNull();

    const statsAfter = await env.DB.prepare(
      `SELECT file_count, total_bytes FROM tenant_storage_stats
        WHERE tenant_id = ? AND classification = 'internal'`
    )
      .bind(TENANT_ID)
      .first<{ file_count: number; total_bytes: number }>();
    expect(statsAfter).toEqual(statsBefore);

    const auditAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM audit_logs
        WHERE tenant_id = ? AND target_id = ? AND action = 'file.version.restore'`
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ cnt: number }>();
    expect(auditAfter?.cnt).toBe(auditBefore?.cnt);

    const syncAfter = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM sync_changes
        WHERE tenant_id = ? AND entity_id = ? AND action = 'file.version_restored'`
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ cnt: number }>();
    expect(syncAfter?.cnt).toBe(syncBefore?.cnt);

    const unchanged = await env.DB.prepare(
      'SELECT current_version_num, meta_version FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ current_version_num: number; meta_version: number }>();
    expect(unchanged).toEqual({
      current_version_num: 2,
      meta_version: fileRow!.meta_version,
    });
  });

  it('enforces the previewer/viewer/editor/outsider RBAC matrix for list, content-url and restore', async () => {
    const testEnv = buildTestEnv();
    const v1 = await uploadVersion({
      testEnv,
      fileName: 'rbac-flow.txt',
      content: 'rbac-v1',
    });
    const v2 = await uploadVersion({
      testEnv,
      fileName: 'rbac-flow.txt',
      content: 'rbac-v2',
    });
    const base = `http://127.0.0.1:8787/api/files/${v1.fileId}`;

    // 401 without credentials for every endpoint.
    for (const [method, path] of [
      ['GET', `${base}/versions`],
      ['GET', `${base}/versions/${v1.versionId}/content-url?intent=preview`],
      ['POST', `${base}/versions/${v1.versionId}/restore`],
    ] as const) {
      const res = await app.fetch(
        new Request(path, {
          method,
          ...(method === 'POST' ? { body: JSON.stringify({}) } : {}),
        }),
        testEnv
      );
      expect(res.status).toBe(401);
    }

    const listStatus = async (userId: string, tenantId = TENANT_ID) =>
      (
        await app.fetch(
          new Request(`${base}/versions`, { headers: authHeaders(userId, tenantId) }),
          testEnv
        )
      ).status;

    expect(await listStatus(PREVIEWER)).toBe(200);
    expect(await listStatus(VIEWER)).toBe(200);
    expect(await listStatus(EDITOR)).toBe(200);
    expect(await listStatus(OUTSIDER)).toBe(403);
    expect(await listStatus(OTHER_EDITOR, OTHER_TENANT_ID)).toBe(404);

    const previewStatus = async (userId: string, tenantId = TENANT_ID) =>
      (
        await app.fetch(
          new Request(`${base}/versions/${v1.versionId}/content-url?intent=preview`, {
            headers: authHeaders(userId, tenantId),
          }),
          testEnv
        )
      ).status;

    expect(await previewStatus(PREVIEWER)).toBe(200);
    expect(await previewStatus(VIEWER)).toBe(200);
    expect(await previewStatus(EDITOR)).toBe(200);
    expect(await previewStatus(OUTSIDER)).toBe(403);
    expect(await previewStatus(OTHER_EDITOR, OTHER_TENANT_ID)).toBe(404);

    const downloadStatus = async (userId: string, tenantId = TENANT_ID) =>
      (
        await app.fetch(
          new Request(`${base}/versions/${v1.versionId}/content-url?intent=download`, {
            headers: authHeaders(userId, tenantId),
          }),
          testEnv
        )
      ).status;

    expect(await downloadStatus(PREVIEWER)).toBe(403);
    expect(await downloadStatus(VIEWER)).toBe(200);
    expect(await downloadStatus(EDITOR)).toBe(200);
    expect(await downloadStatus(OUTSIDER)).toBe(403);
    expect(await downloadStatus(OTHER_EDITOR, OTHER_TENANT_ID)).toBe(404);

    const restoreStatus = async (userId: string, tenantId = TENANT_ID) =>
      (
        await app.fetch(
          new Request(`${base}/versions/${v1.versionId}/restore`, {
            method: 'POST',
            headers: authHeaders(userId, tenantId),
            body: JSON.stringify({}),
          }),
          testEnv
        )
      ).status;

    expect(await restoreStatus(PREVIEWER)).toBe(403);
    expect(await restoreStatus(VIEWER)).toBe(403);
    expect(await restoreStatus(OUTSIDER)).toBe(403);
    expect(await restoreStatus(OTHER_EDITOR, OTHER_TENANT_ID)).toBe(404);
    expect(await restoreStatus(EDITOR)).toBe(200);

    const afterRestoreList = await app.fetch(
      new Request(`${base}/versions`, { headers: authHeaders(EDITOR) }),
      testEnv
    );
    const afterRestore = (await afterRestoreList.json()) as {
      versions: Array<{ id: string; versionNum: number; isCurrent: boolean }>;
    };
    expect(afterRestore.versions.map((v) => v.versionNum)).toEqual([3, 2, 1]);
    expect(afterRestore.versions[0].isCurrent).toBe(true);

    const viewerDetail = await app.fetch(
      new Request(base, { headers: authHeaders(VIEWER) }),
      testEnv
    );
    const viewerDetailBody = (await viewerDetail.json()) as { canDownload: boolean };
    expect(viewerDetailBody.canDownload).toBe(true);

    const previewerDetail = await app.fetch(
      new Request(base, { headers: authHeaders(PREVIEWER) }),
      testEnv
    );
    const previewerDetailBody = (await previewerDetail.json()) as { canDownload: boolean };
    expect(previewerDetailBody.canDownload).toBe(false);

    expect(v2.versionNum).toBe(2);
  });

  it('applies confidential DLP rules and writes version preview/download audit logs', async () => {
    const testEnv = buildTestEnv();
    const v1Content = 'confidential-version-one';
    const v1 = await uploadVersion({
      testEnv,
      fileName: 'dlp-secret.pdf',
      folderId: CONFIDENTIAL_FOLDER,
      content: v1Content,
      mimeType: 'application/pdf',
    });
    await uploadVersion({
      testEnv,
      fileName: 'dlp-secret.pdf',
      folderId: CONFIDENTIAL_FOLDER,
      content: 'confidential-version-two-is-longer',
      mimeType: 'application/pdf',
    });

    const previewRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${v1.fileId}/versions/${v1.versionId}/content-url?intent=preview`,
        { headers: authHeaders(PREVIEWER) }
      ),
      testEnv
    );
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      url: string;
      disposition: string;
      requireWatermark: boolean;
      watermarkText: string | null;
      versionId: string;
      versionNum: number;
    };
    expect(preview.disposition).toBe('inline');
    expect(preview.requireWatermark).toBe(true);
    expect(preview.watermarkText).toContain('fv-previewer@example.com');
    expect(preview.versionId).toBe(v1.versionId);
    expect(preview.versionNum).toBe(1);
    expect(JSON.stringify(preview)).not.toContain('r2_object_key');

    const previewContent = await fetchSignedContent(testEnv, preview.url);
    expect(previewContent.response.status).toBe(200);
    expect(previewContent.text).toBe(v1Content);
    expect(previewContent.response.headers.get('Content-Security-Policy')).toBe(
      "sandbox; default-src 'none'"
    );

    const deniedDownload = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${v1.fileId}/versions/${v1.versionId}/content-url?intent=download`,
        { headers: authHeaders(PREVIEWER) }
      ),
      testEnv
    );
    expect(deniedDownload.status).toBe(403);

    const viewerDownload = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${v1.fileId}/versions/${v1.versionId}/content-url?intent=download`,
        { headers: authHeaders(VIEWER) }
      ),
      testEnv
    );
    expect(viewerDownload.status).toBe(200);
    const download = (await viewerDownload.json()) as {
      url: string;
      disposition: string;
      requireWatermark: boolean;
      watermarkText: string | null;
    };
    expect(download.disposition).toBe('attachment');
    expect(download.requireWatermark).toBe(true);
    expect(download.watermarkText).toContain('fv-viewer@example.com');
    const downloadContent = await fetchSignedContent(testEnv, download.url);
    expect(downloadContent.response.status).toBe(200);
    expect(downloadContent.text).toBe(v1Content);
    expect(downloadContent.response.headers.get('Content-Disposition')).toContain(
      'attachment;'
    );

    const previewAudit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_logs
        WHERE tenant_id = ? AND target_id = ? AND action = 'file.version.preview'
        ORDER BY rowid DESC LIMIT 1`
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ metadata_json: string }>();
    expect(previewAudit).toBeTruthy();
    expect(JSON.parse(previewAudit!.metadata_json)).toMatchObject({
      fileId: v1.fileId,
      versionId: v1.versionId,
      versionNum: 1,
      requireWatermark: true,
    });

    const downloadAudit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_logs
        WHERE tenant_id = ? AND target_id = ? AND action = 'file.version.download'
        ORDER BY rowid DESC LIMIT 1`
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ metadata_json: string }>();
    expect(downloadAudit).toBeTruthy();
    expect(JSON.parse(downloadAudit!.metadata_json)).toMatchObject({
      fileId: v1.fileId,
      versionId: v1.versionId,
      versionNum: 1,
      disposition: 'attachment',
      requireWatermark: true,
    });

    const deniedAudit = await env.DB.prepare(
      `SELECT status, metadata_json FROM audit_logs
        WHERE tenant_id = ? AND target_id = ? AND action = 'file.content_access_denied'
        ORDER BY rowid DESC LIMIT 1`
    )
      .bind(TENANT_ID, v1.fileId)
      .first<{ status: string; metadata_json: string }>();
    expect(deniedAudit?.status).toBe('blocked');
    expect(JSON.parse(deniedAudit!.metadata_json)).toMatchObject({
      intent: 'download',
      effectiveRole: 'previewer',
      versionId: v1.versionId,
    });
  });

  it('rejects cross-tenant/wrong-file versions, missing content, incomplete versions, optimistic conflicts and active locks', async () => {
    const testEnv = buildTestEnv();
    const v1 = await uploadVersion({
      testEnv,
      fileName: 'errors-flow.txt',
      content: 'errors-v1',
    });
    const v2 = await uploadVersion({
      testEnv,
      fileName: 'errors-flow.txt',
      content: 'errors-v2',
    });
    const other = await uploadVersion({
      testEnv,
      fileName: 'errors-other.txt',
      content: 'other-v1',
    });

    const base = `http://127.0.0.1:8787/api/files/${v1.fileId}`;

    // Cross-tenant requests are indistinguishable from unknown files.
    const crossTenantList = await app.fetch(
      new Request(`${base}/versions`, {
        headers: authHeaders(OTHER_EDITOR, OTHER_TENANT_ID),
      }),
      testEnv
    );
    expect(crossTenantList.status).toBe(404);
    const crossTenantContent = await app.fetch(
      new Request(`${base}/versions/${v1.versionId}/content-url`, {
        headers: authHeaders(OTHER_EDITOR, OTHER_TENANT_ID),
      }),
      testEnv
    );
    expect(crossTenantContent.status).toBe(404);
    const crossTenantRestore = await app.fetch(
      new Request(`${base}/versions/${v1.versionId}/restore`, {
        method: 'POST',
        headers: authHeaders(OTHER_EDITOR, OTHER_TENANT_ID),
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(crossTenantRestore.status).toBe(404);

    // A version id from another file in the same tenant must not resolve here.
    const wrongFileContent = await app.fetch(
      new Request(`${base}/versions/${other.versionId}/content-url`, {
        headers: authHeaders(EDITOR),
      }),
      testEnv
    );
    expect(wrongFileContent.status).toBe(404);
    const wrongFileRestore = await app.fetch(
      new Request(`${base}/versions/${other.versionId}/restore`, {
        method: 'POST',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(wrongFileRestore.status).toBe(404);

    // A pending replacement version is visible but not previewable/restorable.
    const pendingInitRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/upload-init', {
        method: 'POST',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({
          folderId: INTERNAL_FOLDER,
          fileName: 'errors-flow.txt',
          mimeType: 'text/plain',
          sizeBytes: 9,
          conflictPolicy: 'new_version',
        }),
      }),
      testEnv
    );
    expect(pendingInitRes.status).toBe(201);
    const pending = (await pendingInitRes.json()) as {
      fileId: string;
      versionId: string;
      versionNum: number;
    };
    expect(pending.fileId).toBe(v1.fileId);
    expect(pending.versionNum).toBe(3);

    const pendingListRes = await app.fetch(
      new Request(`${base}/versions`, { headers: authHeaders(EDITOR) }),
      testEnv
    );
    expect(pendingListRes.status).toBe(200);
    const pendingList = (await pendingListRes.json()) as {
      versions: Array<{ id: string; versionNum: number; uploadStatus: string; isCurrent: boolean }>;
    };
    const pendingEntry = pendingList.versions.find((v) => v.id === pending.versionId);
    expect(pendingEntry).toMatchObject({
      versionNum: 3,
      uploadStatus: 'pending',
      isCurrent: false,
    });

    const pendingContent = await app.fetch(
      new Request(`${base}/versions/${pending.versionId}/content-url`, {
        headers: authHeaders(EDITOR),
      }),
      testEnv
    );
    expect(pendingContent.status).toBe(409);
    expect(((await pendingContent.json()) as { code: string }).code).toBe(
      'VERSION_NOT_COMPLETED'
    );
    const pendingRestore = await app.fetch(
      new Request(`${base}/versions/${pending.versionId}/restore`, {
        method: 'POST',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(pendingRestore.status).toBe(409);
    expect(((await pendingRestore.json()) as { code: string }).code).toBe(
      'VERSION_NOT_COMPLETED'
    );

    const currentRestore = await app.fetch(
      new Request(`${base}/versions/${v2.versionId}/restore`, {
        method: 'POST',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(currentRestore.status).toBe(409);
    expect(((await currentRestore.json()) as { code: string }).code).toBe(
      'VERSION_ALREADY_CURRENT'
    );

    const beforeConflict = await env.DB.prepare('SELECT * FROM files WHERE id = ?')
      .bind(v1.fileId)
      .first<{ meta_version: number }>();
    const conflictRestore = await app.fetch(
      new Request(`${base}/versions/${v1.versionId}/restore`, {
        method: 'POST',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({ expectedVersion: (beforeConflict?.meta_version ?? 1) - 1 }),
      }),
      testEnv
    );
    expect(conflictRestore.status).toBe(409);
    const conflictBody = (await conflictRestore.json()) as {
      code: string;
      latest: { meta_version: number };
    };
    expect(conflictBody.code).toBe('VERSION_CONFLICT');
    expect(conflictBody.latest.meta_version).toBe(beforeConflict?.meta_version);
    const versionCountAfterConflict = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM file_versions WHERE file_id = ?'
    )
      .bind(v1.fileId)
      .first<{ cnt: number }>();
    expect(versionCountAfterConflict?.cnt).toBe(3);

    // Missing R2 object for a completed historical version.
    const missingV1 = await uploadVersion({
      testEnv,
      fileName: 'errors-missing.bin',
      content: 'missing-one',
      mimeType: 'application/octet-stream',
    });
    await uploadVersion({
      testEnv,
      fileName: 'errors-missing.bin',
      content: 'missing-two',
      mimeType: 'application/octet-stream',
    });
    const missingRow = await env.DB.prepare(
      'SELECT r2_object_key FROM file_versions WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, missingV1.versionId)
      .first<{ r2_object_key: string }>();
    await env.BUCKET.delete(missingRow!.r2_object_key);
    const missingRestore = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${missingV1.fileId}/versions/${missingV1.versionId}/restore`,
        { method: 'POST', headers: authHeaders(EDITOR), body: JSON.stringify({}) }
      ),
      testEnv
    );
    expect(missingRestore.status).toBe(409);
    expect(((await missingRestore.json()) as { code: string }).code).toBe(
      'VERSION_CONTENT_NOT_FOUND'
    );

    // Desktop exclusive lock blocks restore.
    const lockRes = await app.fetch(
      new Request(`${base}/lock`, {
        method: 'POST',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({ lockId: 'fv-desktop-lock' }),
      }),
      testEnv
    );
    expect(lockRes.status).toBe(201);
    const lockedRestore = await app.fetch(
      new Request(`${base}/versions/${v1.versionId}/restore`, {
        method: 'POST',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(lockedRestore.status).toBe(409);
    expect(((await lockedRestore.json()) as { code: string }).code).toBe('FILE_LOCKED');
    const unlockRes = await app.fetch(
      new Request(`${base}/lock`, {
        method: 'DELETE',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({ lockId: 'fv-desktop-lock' }),
      }),
      testEnv
    );
    expect(unlockRes.status).toBe(200);

    // WOPI collaborative lock blocks restore through the shared FileLockHub.
    const wopiSessionRes = await app.fetch(
      new Request(`${base}/wopi-session`, {
        method: 'POST',
        headers: authHeaders(EDITOR),
      }),
      testEnv
    );
    expect(wopiSessionRes.status).toBe(201);
    const wopiSession = (await wopiSessionRes.json()) as { accessToken: string };
    const wopiLockRes = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${v1.fileId}?access_token=${encodeURIComponent(wopiSession.accessToken)}`,
        {
          method: 'POST',
          headers: {
            'X-WOPI-Override': 'LOCK',
            'X-WOPI-Lock': 'fv-wopi-lock',
          },
        }
      ),
      testEnv
    );
    expect(wopiLockRes.status).toBe(200);
    const wopiLockedRestore = await app.fetch(
      new Request(`${base}/versions/${v1.versionId}/restore`, {
        method: 'POST',
        headers: authHeaders(EDITOR),
        body: JSON.stringify({}),
      }),
      testEnv
    );
    expect(wopiLockedRestore.status).toBe(409);
    expect(((await wopiLockedRestore.json()) as { code: string }).code).toBe(
      'FILE_LOCKED'
    );
    await app.fetch(
      new Request(
        `http://127.0.0.1:8787/wopi/files/${v1.fileId}?access_token=${encodeURIComponent(wopiSession.accessToken)}`,
        {
          method: 'POST',
          headers: {
            'X-WOPI-Override': 'UNLOCK',
            'X-WOPI-Lock': 'fv-wopi-lock',
          },
        }
      ),
      testEnv
    );
  });
});
