import {
  applyD1Migrations,
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker, { app } from '../src/index';
import type { CopySubtreeQueueMessage } from '../src/types/classification';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-ws';

function authHeaders(
  userId = 'ws-owner',
  role: 'sys_admin' | 'member' = 'member',
  tenantId = TENANT_ID
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@ws.example.com`,
    'Content-Type': 'application/json',
  };
}

function makeQueueHarness() {
  const queued: CopySubtreeQueueMessage[] = [];
  const queue = {
    send: vi.fn(async (msg: CopySubtreeQueueMessage) => {
      queued.push(msg);
    }),
  } as unknown as Queue;

  function buildEnv(): OidcEnv {
    return {
      ...env,
      ENVIRONMENT: 'local',
      ALLOW_DEV_AUTH: 'true',
      APP_ORIGIN: 'http://127.0.0.1:8787',
      STORAGE_MODE: 'local_proxy',
      LOCAL_PROXY_SECRET: 'test-hmac-ws-secret-001',
      SESSION_SECRET: 'test-session-ws-secret-001',
      JOBS_QUEUE: queue,
    } as OidcEnv;
  }

  async function drainCopyQueue(maxTurns = 30): Promise<number> {
    let turns = 0;
    const testEnv = buildEnv();
    while (queued.length > 0) {
      turns += 1;
      if (turns > maxTurns) {
        throw new Error(`Queue drain exceeded ${maxTurns} turns`);
      }
      const chunk = queued.splice(0, 2);
      const msgs = chunk.map((body) => ({
        id: crypto.randomUUID(),
        timestamp: new Date(),
        body,
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      }));
      const ctx = createExecutionContext();
      await worker.queue!(
        {
          queue: 'files-jobs',
          messages: msgs,
          metadata: {
            metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: new Date() },
          },
          ackAll: vi.fn(),
          retryAll: vi.fn(),
        },
        testEnv,
        ctx
      );
      await waitOnExecutionContext(ctx);
      for (const m of msgs) {
        expect(m.ack).toHaveBeenCalledTimes(1);
      }
    }
    return turns;
  }

  return { queued, queue, buildEnv, drainCopyQueue };
}

async function createFolder(
  testEnv: OidcEnv,
  userId: string,
  name: string,
  parentId: string | null = null,
  classification: 'unset' | 'public' | 'internal' | 'confidential' = 'unset'
) {
  const res = await app.fetch(
    new Request('http://127.0.0.1:8787/api/folders', {
      method: 'POST',
      headers: authHeaders(userId, userId === 'ws-admin' ? 'sys_admin' : 'member'),
      body: JSON.stringify({ name, parentId, classification }),
    }),
    testEnv
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as {
    folder: {
      id: string;
      name: string;
      parent_id: string | null;
      depth: number;
      version: number;
      classification: string;
    };
  }).folder;
}

async function uploadActiveFile(
  testEnv: OidcEnv,
  userId: string,
  folderId: string | null,
  fileName: string,
  content: string,
  mimeType = 'text/plain'
) {
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
      }),
    }),
    testEnv
  );
  expect(initRes.status).toBe(201);
  const initBody = (await initRes.json()) as {
    fileId: string;
    versionId: string;
    r2ObjectKey: string;
    uploadUrl: string;
  };

  const putRes = await app.fetch(
    new Request(`http://127.0.0.1:8787${initBody.uploadUrl}`, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: bytes,
    }),
    testEnv
  );
  expect(putRes.status).toBe(200);

  const compRes = await app.fetch(
    new Request('http://127.0.0.1:8787/api/files/upload-complete', {
      method: 'POST',
      headers: authHeaders(userId),
      body: JSON.stringify({ fileId: initBody.fileId, versionId: initBody.versionId }),
    }),
    testEnv
  );
  expect(compRes.status).toBe(200);
  const compBody = (await compRes.json()) as {
    file: {
      id: string;
      name: string;
      folder_id: string | null;
      classification: string;
      meta_version: number;
      size_bytes: number;
    };
  };
  return { ...initBody, file: compBody.file };
}

describe('Phase 6 Workspace Operations: Batch Move, CoW Copy, Duplicate & Async Subtree Jobs (TOM-27)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES ('${TENANT_ID}', 'Workspace Ops Org', 'ws-ops-org', 10000)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id, trash_retention_days)
         VALUES ('${TENANT_ID}', 7)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('ws-admin', '${TENANT_ID}', 'ws-admin@ws.example.com', 'WS Admin', 'sys_admin', 'active'),
           ('ws-owner', '${TENANT_ID}', 'ws-owner@ws.example.com', 'WS Owner', 'member', 'active'),
           ('ws-editor', '${TENANT_ID}', 'ws-editor@ws.example.com', 'WS Editor', 'member', 'active'),
           ('ws-viewer', '${TENANT_ID}', 'ws-viewer@ws.example.com', 'WS Viewer', 'member', 'active'),
           ('ws-previewer', '${TENANT_ID}', 'ws-previewer@ws.example.com', 'WS Previewer', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES
           ('${TENANT_ID}', 'unset', 0, 0),
           ('${TENANT_ID}', 'public', 0, 0),
           ('${TENANT_ID}', 'internal', 0, 0),
           ('${TENANT_ID}', 'confidential', 0, 0)`
      ),
    ]);
  });

  it('batch-move handles mixed files+folders, prunes redundant descendants, checks versions/conflicts/cycles/depth, and preserves permissions/DLP', async () => {
    const harness = makeQueueHarness();
    const testEnv = harness.buildEnv();

    // Build source & target workspaces owned by ws-owner
    const srcRoot = await createFolder(testEnv, 'ws-owner', 'BatchSrcRoot', null, 'internal');
    const srcSub = await createFolder(testEnv, 'ws-owner', 'SrcSub', srcRoot.id, 'internal');
    const srcSiblingFile = await uploadActiveFile(
      testEnv,
      'ws-owner',
      srcRoot.id,
      'loose.txt',
      'loose-body'
    );
    const childInsideSub = await uploadActiveFile(
      testEnv,
      'ws-owner',
      srcSub.id,
      'inside-sub.txt',
      'inside-sub-body'
    );

    const destConf = await createFolder(
      testEnv,
      'ws-owner',
      'BatchDestConf',
      null,
      'confidential'
    );

    // Grant ws-editor 'editor' on srcRoot, srcSub, destConf
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-bm-1', '${TENANT_ID}', 'folder', ?, 'user', 'ws-editor', 'editor', 'ws-owner'),
           ('perm-bm-2', '${TENANT_ID}', 'folder', ?, 'user', 'ws-editor', 'editor', 'ws-owner')`
      ).bind(srcRoot.id, destConf.id),
      // Create public + internal shared_links on srcSiblingFile to verify confidential tightening on move
      env.DB.prepare(
        `INSERT INTO shared_links (id, tenant_id, token_hash, target_type, target_id, access_scope, can_download, require_watermark, created_by)
         VALUES
           ('sl-bm-pub', '${TENANT_ID}', 'hash-bm-pub', 'file', ?, 'public', 1, 0, 'ws-owner'),
           ('sl-bm-int', '${TENANT_ID}', 'hash-bm-int', 'file', ?, 'company_only', 1, 0, 'ws-owner')`
      ).bind(srcSiblingFile.file.id, srcSiblingFile.file.id),
    ]);

    // 1. Cycle check: moving srcRoot into srcSub must fail 400 CYCLE_DETECTED
    const cycleRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-owner'),
        body: JSON.stringify({
          items: [{ type: 'folder', id: srcRoot.id }],
          targetParentId: srcSub.id,
        }),
      }),
      testEnv
    );
    expect(cycleRes.status).toBe(400);
    expect(((await cycleRes.json()) as { code: string }).code).toBe('CYCLE_DETECTED');

    // 2. Version conflict check: stale expectedVersion returns 409 VERSION_CONFLICT
    const verConflictRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-owner'),
        body: JSON.stringify({
          items: [{ type: 'file', id: srcSiblingFile.file.id, expectedVersion: 999 }],
          targetParentId: destConf.id,
        }),
      }),
      testEnv
    );
    expect(verConflictRes.status).toBe(409);
    expect(((await verConflictRes.json()) as { code: string }).code).toBe('VERSION_CONFLICT');

    // 3. Name conflict check: fail vs rename
    const collisionInDest = await uploadActiveFile(
      testEnv,
      'ws-owner',
      destConf.id,
      'loose.txt',
      'existing-dest-loose'
    );
    expect(collisionInDest.file.name).toBe('loose.txt');

    const nameFailRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-owner'),
        body: JSON.stringify({
          items: [{ type: 'file', id: srcSiblingFile.file.id }],
          targetParentId: destConf.id,
          conflictPolicy: 'fail',
        }),
      }),
      testEnv
    );
    expect(nameFailRes.status).toBe(409);
    expect(((await nameFailRes.json()) as { code: string }).code).toBe('NAME_CONFLICT');

    // 4. Descendant pruning + conflictPolicy='rename' + confidential upward promotion + shared_links tightening
    // Select both srcSub AND childInsideSub (and srcSiblingFile), moving into destConf.
    // childInsideSub must stay inside srcSub (pruned), NOT moved directly to destConf!
    const moveOkRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-owner'),
        body: JSON.stringify({
          items: [
            { type: 'folder', id: srcSub.id, expectedVersion: srcSub.version },
            { type: 'file', id: childInsideSub.file.id },
            { type: 'file', id: srcSiblingFile.file.id, expectedVersion: srcSiblingFile.file.meta_version },
          ],
          targetParentId: destConf.id,
          conflictPolicy: 'rename',
        }),
      }),
      testEnv
    );
    expect(moveOkRes.status).toBe(200);
    const moveBody = (await moveOkRes.json()) as {
      ok: boolean;
      movedFolders: Array<{ id: string; parent_id: string | null; classification: string }>;
      movedFiles: Array<{ id: string; name: string; folder_id: string | null; classification: string }>;
      skippedIds: string[];
    };
    expect(moveBody.ok).toBe(true);
    expect(moveBody.movedFolders.map((f) => f.id)).toEqual([srcSub.id]);
    expect(moveBody.movedFiles.map((f) => f.id)).toEqual([srcSiblingFile.file.id]);
    expect(moveBody.movedFiles[0]?.name).toBe('loose (コピー).txt');
    expect(moveBody.movedFiles[0]?.classification).toBe('confidential');

    // childInsideSub remained inside srcSub AND was promoted to confidential when srcSub moved into destConf
    const childAfter = await env.DB.prepare(
      'SELECT folder_id, classification FROM files WHERE id = ?'
    )
      .bind(childInsideSub.file.id)
      .first<{ folder_id: string; classification: string }>();
    expect(childAfter).toEqual({ folder_id: srcSub.id, classification: 'confidential' });

    // Shared links on srcSiblingFile: public revoked, internal restricted to no download + watermark
    const pubLink = await env.DB.prepare(
      "SELECT revoked_at FROM shared_links WHERE id = 'sl-bm-pub'"
    ).first<{ revoked_at: string | null }>();
    const intLink = await env.DB.prepare(
      "SELECT can_download, require_watermark FROM shared_links WHERE id = 'sl-bm-int'"
    ).first<{ can_download: number; require_watermark: number }>();
    expect(pubLink?.revoked_at).not.toBeNull();
    expect(intLink).toEqual({ can_download: 0, require_watermark: 1 });

    // 5. No-op skippedIds check when moving srcSub into destConf again
    const noopRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-owner'),
        body: JSON.stringify({
          items: [{ type: 'folder', id: srcSub.id }],
          targetParentId: destConf.id,
        }),
      }),
      testEnv
    );
    expect(noopRes.status).toBe(200);
    expect(((await noopRes.json()) as { skippedIds: string[] }).skippedIds).toEqual([srcSub.id]);

    // 6. Root promotion guards:
    // - Folder promoted to root by 'editor' (not 'owner') MUST fail 403
    const editorRootPromoteRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-editor'),
        body: JSON.stringify({
          items: [{ type: 'folder', id: srcSub.id }],
          targetParentId: null,
        }),
      }),
      testEnv
    );
    expect(editorRootPromoteRes.status).toBe(403);

    // - File promoted to root by 'ws-editor' (who has folder editor role, no explicit file row yet) MUST succeed
    //   and preserve explicit permission row on the file at root!
    const rootEligibleFile = await uploadActiveFile(
      testEnv,
      'ws-owner',
      srcRoot.id,
      'promote-me.txt',
      'promote-body'
    );
    const editorPromoteFileRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-editor'),
        body: JSON.stringify({
          items: [{ type: 'file', id: rootEligibleFile.file.id }],
          targetParentId: null,
        }),
      }),
      testEnv
    );
    expect(editorPromoteFileRes.status).toBe(200);

    // ws-editor still can read the root file directly
    const rootReadRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${rootEligibleFile.file.id}/content-url?intent=download`, {
        headers: authHeaders('ws-editor'),
      }),
      testEnv
    );
    expect(rootReadRes.status).toBe(200);

    // 7. Max depth 20 enforcement on batch-move
    let tailId = (await createFolder(testEnv, 'ws-owner', 'Depth0', null)).id;
    for (let d = 1; d <= 18; d++) {
      tailId = (await createFolder(testEnv, 'ws-owner', `Depth${d}`, tailId)).id;
    }
    const twoLevelParent = await createFolder(testEnv, 'ws-owner', 'TwoRoot', null);
    const twoLevelChild = await createFolder(testEnv, 'ws-owner', 'TwoChild', twoLevelParent.id);
    // Moving TwoRoot (max_sub_depth=1) into Depth18 (depth=18) -> new child depth = 20 OK? Wait: newRoot=19, child=20 OK; let's create Depth19 so 20+1 = 21 > 20!
    const depth19 = await createFolder(testEnv, 'ws-owner', 'Depth19', tailId);
    const tooDeepRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-owner'),
        body: JSON.stringify({
          items: [{ type: 'folder', id: twoLevelParent.id }],
          targetParentId: depth19.id,
        }),
      }),
      testEnv
    );
    expect(tooDeepRes.status).toBe(400);
    expect(((await tooDeepRes.json()) as { code: string }).code).toBe('MAX_DEPTH_EXCEEDED');
    expect(twoLevelChild.depth).toBe(1);
  });

  it('enforces DLP on CoW copy (blocks previewer + audits, allows viewer->editor), strips AI/shared_links, and survives source purge', async () => {
    const harness = makeQueueHarness();
    const testEnv = harness.buildEnv();

    const dlpSrc = await createFolder(testEnv, 'ws-owner', 'DLPSource', null, 'unset');
    const dlpDestConf = await createFolder(testEnv, 'ws-owner', 'DLPDestConf', null, 'confidential');

    const payload = 'Quarterly financials confidential payload 2026';
    const srcFile = await uploadActiveFile(testEnv, 'ws-owner', dlpSrc.id, 'q1.txt', payload);

    // Seed AI suggestion + shared_link on source file to prove copy strips both
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE files
            SET ai_suggested_label = 'internal', ai_confidence = 0.88, ai_reason = 'Financial keywords'
          WHERE id = ?`
      ).bind(srcFile.file.id),
      env.DB.prepare(
        `INSERT INTO shared_links (id, tenant_id, token_hash, target_type, target_id, access_scope, created_by)
         VALUES ('sl-cow-src', '${TENANT_ID}', 'hash-cow-src', 'file', ?, 'company_only', 'ws-owner')`
      ).bind(srcFile.file.id),
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-dlp-1', '${TENANT_ID}', 'folder', ?, 'user', 'ws-previewer', 'previewer', 'ws-owner'),
           ('perm-dlp-2', '${TENANT_ID}', 'folder', ?, 'user', 'ws-previewer', 'editor', 'ws-owner'),
           ('perm-dlp-3', '${TENANT_ID}', 'folder', ?, 'user', 'ws-viewer', 'viewer', 'ws-owner'),
           ('perm-dlp-4', '${TENANT_ID}', 'folder', ?, 'user', 'ws-viewer', 'editor', 'ws-owner')`
      ).bind(dlpSrc.id, dlpDestConf.id, dlpSrc.id, dlpDestConf.id),
    ]);

    // 1. Previewer blocked with 403 DLP_COPY_FORBIDDEN + blocked audit log
    const previewerCopyRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/copy', {
        method: 'POST',
        headers: authHeaders('ws-previewer'),
        body: JSON.stringify({
          items: [{ type: 'file', id: srcFile.file.id }],
          targetParentId: dlpDestConf.id,
        }),
      }),
      testEnv
    );
    expect(previewerCopyRes.status).toBe(403);
    expect(((await previewerCopyRes.json()) as { code: string }).code).toBe('DLP_COPY_FORBIDDEN');

    const blockedAudit = await env.DB.prepare(
      `SELECT status, target_id FROM audit_logs
        WHERE tenant_id = ? AND actor_id = 'ws-previewer' AND action = 'workspace.copy_denied'`
    )
      .bind(TENANT_ID)
      .first<{ status: string; target_id: string }>();
    expect(blockedAudit).toEqual({ status: 'blocked', target_id: srcFile.file.id });

    // 2. Viewer on source -> Editor on destination succeeds via CoW
    const viewerCopyRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/copy', {
        method: 'POST',
        headers: authHeaders('ws-viewer'),
        body: JSON.stringify({
          items: [{ type: 'file', id: srcFile.file.id }],
          targetParentId: dlpDestConf.id,
        }),
      }),
      testEnv
    );
    expect(viewerCopyRes.status).toBe(201);
    const copyBody = (await viewerCopyRes.json()) as {
      ok: boolean;
      queued: boolean;
      copiedFiles: Array<{ id: string; classification: string }>;
    };
    expect(copyBody.queued).toBe(false);
    expect(copyBody.copiedFiles).toHaveLength(1);
    const copiedId = copyBody.copiedFiles[0]!.id;
    expect(copyBody.copiedFiles[0]!.classification).toBe('confidential');

    // Shares R2 key, strips AI suggestions & shared_links
    const [origVer, copyMeta] = await Promise.all([
      env.DB.prepare('SELECT r2_object_key FROM file_versions WHERE file_id = ?')
        .bind(srcFile.file.id)
        .first<{ r2_object_key: string }>(),
      env.DB.prepare(
        `SELECT fl.ai_suggested_label, fl.ai_confidence, fl.ai_reason, fv.r2_object_key
           FROM files fl
           JOIN file_versions fv ON fv.id = fl.current_version_id
          WHERE fl.id = ?`
      )
        .bind(copiedId)
        .first<{
          ai_suggested_label: string | null;
          ai_confidence: number | null;
          ai_reason: string | null;
          r2_object_key: string;
        }>(),
    ]);
    expect(copyMeta?.r2_object_key).toBe(origVer?.r2_object_key);
    expect(copyMeta?.ai_suggested_label).toBeNull();
    expect(copyMeta?.ai_confidence).toBeNull();
    expect(copyMeta?.ai_reason).toBeNull();

    const copyLinks = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM shared_links WHERE target_id = ?"
    )
      .bind(copiedId)
      .first<{ cnt: number }>();
    expect(copyLinks?.cnt).toBe(0);

    // 3. Soft-delete & permanently delete original file DB rows (CoW test simulating post-purge state)
    await env.DB.batch([
      env.DB.prepare("DELETE FROM file_versions WHERE file_id = ?").bind(srcFile.file.id),
      env.DB.prepare("DELETE FROM files WHERE id = ?").bind(srcFile.file.id),
    ]);

    // Download CoW copy via GET /api/files/:id/content-url -> must still return exact R2 bytes
    const contentUrlRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${copiedId}/content-url?intent=download`, {
        headers: authHeaders('ws-viewer'),
      }),
      testEnv
    );
    expect(contentUrlRes.status).toBe(200);
    const urlBody = (await contentUrlRes.json()) as { url: string };
    const dlRes = await app.fetch(
      new Request(`http://127.0.0.1:8787${urlBody.url}`),
      testEnv
    );
    expect(dlRes.status).toBe(200);
    expect(await dlRes.text()).toBe(payload);
  });

  it('supports duplicate in-place naming, self-copy without infinite loop, and logical storage quota', async () => {
    const harness = makeQueueHarness();
    const testEnv = harness.buildEnv();

    // Isolated sub-tenant with tight quota (200 bytes) for deterministic quota assertion
    const qTenant = 'tenant-ws-quota';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES ('${qTenant}', 'Quota Org', 'ws-quota-org', 200)`
      ),
      env.DB.prepare(`INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES ('${qTenant}')`),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES ('q-owner', '${qTenant}', 'q-owner@ws.example.com', 'Q Owner', 'sys_admin', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES ('${qTenant}', 'unset', 0, 0), ('${qTenant}', 'internal', 0, 0), ('${qTenant}', 'confidential', 0, 0)`
      ),
    ]);

    const folderA = await (async () => {
      const res = await app.fetch(
        new Request('http://127.0.0.1:8787/api/folders', {
          method: 'POST',
          headers: authHeaders('q-owner', 'sys_admin', qTenant),
          body: JSON.stringify({ name: 'FolderA', classification: 'internal' }),
        }),
        testEnv
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { folder: { id: string } }).folder;
    })();

    // Upload 80-byte file inside FolderA via upload-init + upload-complete
    const body80 = 'A'.repeat(80);
    const bytes80 = new TextEncoder().encode(body80);
    const initRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/upload-init', {
        method: 'POST',
        headers: authHeaders('q-owner', 'sys_admin', qTenant),
        body: JSON.stringify({
          folderId: folderA.id,
          fileName: 'spec.txt',
          mimeType: 'text/plain',
          sizeBytes: 80,
        }),
      }),
      testEnv
    );
    const init = (await initRes.json()) as { fileId: string; versionId: string; uploadUrl: string };
    await app.fetch(
      new Request(`http://127.0.0.1:8787${init.uploadUrl}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: bytes80,
      }),
      testEnv
    );
    await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/upload-complete', {
        method: 'POST',
        headers: authHeaders('q-owner', 'sys_admin', qTenant),
        body: JSON.stringify({ fileId: init.fileId, versionId: init.versionId }),
      }),
      testEnv
    );

    // 1. Self-copy FolderA into FolderA (80 + 80 = 160 <= 200) -> succeeds without infinite recursion!
    const selfCopyRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/copy', {
        method: 'POST',
        headers: authHeaders('q-owner', 'sys_admin', qTenant),
        body: JSON.stringify({
          items: [{ type: 'folder', id: folderA.id }],
          targetParentId: folderA.id,
        }),
      }),
      testEnv
    );
    expect(selfCopyRes.status).toBe(201);
    const selfCopyBody = (await selfCopyRes.json()) as {
      copiedFolders: Array<{ id: string; name: string; parent_id: string | null }>;
      copiedFiles: Array<{ id: string; name: string }>;
    };
    expect(selfCopyBody.copiedFolders).toHaveLength(1);
    expect(selfCopyBody.copiedFolders[0]!.name).toBe('FolderA');
    expect(selfCopyBody.copiedFolders[0]!.parent_id).toBe(folderA.id);
    expect(selfCopyBody.copiedFiles).toHaveLength(1);
    expect(selfCopyBody.copiedFiles[0]!.name).toBe('spec.txt');

    // Verify logical stats incremented to 2 files / 160 bytes
    const statsAfterSelfCopy = await env.DB.prepare(
      `SELECT file_count, total_bytes FROM tenant_storage_stats WHERE tenant_id = ? AND classification = 'internal'`
    )
      .bind(qTenant)
      .first<{ file_count: number; total_bytes: number }>();
    expect(statsAfterSelfCopy).toEqual({ file_count: 2, total_bytes: 160 });

    // 2. Copying another 80-byte file exceeds 200-byte quota -> 413 QUOTA_EXCEEDED
    const quotaFailRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/duplicate', {
        method: 'POST',
        headers: authHeaders('q-owner', 'sys_admin', qTenant),
        body: JSON.stringify({
          items: [{ type: 'file', id: init.fileId }],
        }),
      }),
      testEnv
    );
    expect(quotaFailRes.status).toBe(413);
    expect(((await quotaFailRes.json()) as { code: string }).code).toBe('QUOTA_EXCEEDED');

    // 3. Raise quota to 1000 and verify duplicate naming `'spec (コピー).txt'`
    await env.DB.prepare('UPDATE tenants SET storage_quota_bytes = 1000 WHERE id = ?')
      .bind(qTenant)
      .run();

    const dupOkRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/duplicate', {
        method: 'POST',
        headers: authHeaders('q-owner', 'sys_admin', qTenant),
        body: JSON.stringify({
          items: [{ type: 'file', id: init.fileId }],
        }),
      }),
      testEnv
    );
    expect(dupOkRes.status).toBe(201);
    const dupBody = (await dupOkRes.json()) as {
      copiedFiles: Array<{ name: string }>;
    };
    expect(dupBody.copiedFiles.map((f) => f.name)).toEqual(['spec (コピー).txt']);
  });

  it('offloads >100-node subtree copy to JOBS_QUEUE (202) and drains chunks to completed status', async () => {
    const harness = makeQueueHarness();
    const testEnv = harness.buildEnv();

    // Seed 1 parent folder + 55 child folders + 55 files (111 nodes > 100 SYNC_COPY_NODE_LIMIT)
    const nowIso = new Date().toISOString();
    const bigRootId = 'big-src-root';
    const setupStmts: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by, created_at, updated_at)
         VALUES (?, ?, NULL, 'BigSubtreeRoot', 0, 1, 'internal', 'ws-owner', ?, ?)`
      ).bind(bigRootId, TENANT_ID, nowIso, nowIso),
      env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, ?, ?, 0)`
      ).bind(TENANT_ID, bigRootId, bigRootId),
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES ('perm-big-root', ?, 'folder', ?, 'user', 'ws-owner', 'owner', 'ws-owner')`
      ).bind(TENANT_ID, bigRootId),
    ];

    const r2Key = `tenants/${TENANT_ID}/objects/big-shared/v1`;
    await env.BUCKET.put(r2Key, 'x');

    for (let i = 1; i <= 55; i++) {
      const subId = `big-sub-${i}`;
      const fId = `big-file-${i}`;
      const vId = `big-ver-${i}`;
      setupStmts.push(
        env.DB.prepare(
          `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 1, 'internal', 'ws-owner', ?, ?)`
        ).bind(subId, TENANT_ID, bigRootId, `Sub_${i}`, nowIso, nowIso),
        env.DB.prepare(
          `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
           VALUES (?, ?, ?, 0), (?, ?, ?, 1)`
        ).bind(TENANT_ID, subId, subId, TENANT_ID, bigRootId, subId),
        env.DB.prepare(
          `INSERT INTO files (
             id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
             upload_state, current_version_id, current_version_num, meta_version,
             classification, created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'txt', 'text/plain', 1, 'active', ?, 1, 1, 'internal', 'ws-owner', 'ws-owner', ?, ?)`
        ).bind(fId, TENANT_ID, subId, `item_${i}.txt`, vId, nowIso, nowIso),
        env.DB.prepare(
          `INSERT INTO file_versions (
             id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at
           ) VALUES (?, ?, ?, 1, ?, 1, 'text/plain', 'completed', 'ws-owner', ?)`
        ).bind(vId, TENANT_ID, fId, r2Key, nowIso)
      );
    }

    // Batch in 40-statement slices cleanly
    for (let i = 0; i < setupStmts.length; i += 40) {
      await env.DB.batch(setupStmts.slice(i, i + 40));
    }

    const destParent = await createFolder(testEnv, 'ws-owner', 'AsyncCopyDest', null, 'confidential');

    const copyRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/copy', {
        method: 'POST',
        headers: authHeaders('ws-owner', 'sys_admin'),
        body: JSON.stringify({
          items: [{ type: 'folder', id: bigRootId }],
          targetParentId: destParent.id,
        }),
      }),
      testEnv
    );
    expect(copyRes.status).toBe(202);
    const copyBody = (await copyRes.json()) as {
      ok: boolean;
      queued: boolean;
      jobId: string;
      totalItems: number;
    };
    expect(copyBody.ok).toBe(true);
    expect(copyBody.queued).toBe(true);
    expect(copyBody.totalItems).toBe(111);
    expect(copyBody.jobId).toBeTruthy();

    // Drain chunked queue messages until completion (111 items / 15 chunk -> ~8 chunks)
    const turns = await harness.drainCopyQueue();
    expect(turns).toBeGreaterThanOrEqual(7);

    // Poll job status endpoint -> completed with 111 / 111
    const statusRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/workspace/jobs/${copyBody.jobId}`, {
        headers: authHeaders('ws-owner'),
      }),
      testEnv
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      job: { status: string; totalItems: number; processedItems: number };
    };
    expect(statusBody.job.status).toBe('completed');
    expect(statusBody.job.totalItems).toBe(111);
    expect(statusBody.job.processedItems).toBe(111);

    // Verify copied subtree in destParent inherited 'confidential' classification and has 55 copied child folders + 55 copied files
    const copiedRoot = await env.DB.prepare(
      'SELECT id, depth, classification FROM folders WHERE tenant_id = ? AND parent_id = ? AND deleted_at IS NULL'
    )
      .bind(TENANT_ID, destParent.id)
      .first<{ id: string; depth: number; classification: string }>();
    expect(copiedRoot).toMatchObject({ depth: 1, classification: 'confidential' });

    const copiedCounts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM folder_closures fc JOIN folders f ON f.id = fc.descendant_id
           WHERE fc.tenant_id = ? AND fc.ancestor_id = ? AND fc.depth > 0 AND f.deleted_at IS NULL) AS child_folders,
         (SELECT COUNT(*) FROM files fl
           JOIN folder_closures fc ON fc.descendant_id = fl.folder_id
          WHERE fc.tenant_id = ? AND fc.ancestor_id = ? AND fl.deleted_at IS NULL AND fl.classification = 'confidential') AS child_files`
    )
      .bind(TENANT_ID, copiedRoot!.id, TENANT_ID, copiedRoot!.id)
      .first<{ child_folders: number; child_files: number }>();
    expect(copiedCounts).toEqual({ child_folders: 55, child_files: 55 });
  });

  it('validates 50-item mixed batch-move, confidential non-downgrade, inactive upload move block, and previewer-descendant subtree copy block (TOM-32)', async () => {
    const harness = makeQueueHarness();
    const testEnv = harness.buildEnv();

    // 1. 50-item mixed batch-move (25 folders + 25 files) from confidential src to public dest (verifies non-downgrade too)
    const src50 = await createFolder(testEnv, 'ws-owner', 'Mixed50Src', null, 'confidential');
    const dst50 = await createFolder(testEnv, 'ws-owner', 'Mixed50Dest', null, 'public');
    const mixedItems: Array<{ type: 'folder' | 'file'; id: string }> = [];
    const nowIso = new Date().toISOString();
    const insertStmts: D1PreparedStatement[] = [];

    for (let i = 0; i < 25; i++) {
      const fldId = `m50-fld-${i}`;
      const filId = `m50-fil-${i}`;
      const verId = `m50-ver-${i}`;
      mixedItems.push({ type: 'folder', id: fldId }, { type: 'file', id: filId });
      insertStmts.push(
        env.DB.prepare(
          `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 1, 'confidential', 'ws-owner', ?, ?)`
        ).bind(fldId, TENANT_ID, src50.id, `F50_${i}`, nowIso, nowIso),
        env.DB.prepare(
          `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
           VALUES (?, ?, ?, 0), (?, ?, ?, 1)`
        ).bind(TENANT_ID, fldId, fldId, TENANT_ID, src50.id, fldId),
        env.DB.prepare(
          `INSERT INTO files (
             id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
             upload_state, current_version_id, current_version_num, meta_version,
             classification, created_by, updated_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'txt', 'text/plain', 1, 'active', ?, 1, 1, 'confidential', 'ws-owner', 'ws-owner', ?, ?)`
        ).bind(filId, TENANT_ID, src50.id, `f50_${i}.txt`, verId, nowIso, nowIso),
        env.DB.prepare(
          `INSERT INTO file_versions (
             id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at
           ) VALUES (?, ?, ?, 1, ?, 1, 'text/plain', 'completed', 'ws-owner', ?)`
        ).bind(verId, TENANT_ID, filId, `${TENANT_ID}/m50/${filId}`, nowIso)
      );
    }

    for (let i = 0; i < insertStmts.length; i += 40) {
      await env.DB.batch(insertStmts.slice(i, i + 40));
    }

    const batch50Res = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-owner'),
        body: JSON.stringify({
          items: mixedItems,
          targetParentId: dst50.id,
        }),
      }),
      testEnv
    );
    expect(batch50Res.status).toBe(200);
    const batch50Body = (await batch50Res.json()) as {
      ok: boolean;
      movedFolders: Array<{ id: string; classification: string }>;
      movedFiles: Array<{ id: string; classification: string }>;
    };
    expect(batch50Body.ok).toBe(true);
    expect(batch50Body.movedFolders).toHaveLength(25);
    expect(batch50Body.movedFiles).toHaveLength(25);

    // Confidential classification MUST NOT downgrade when moved into 'public' target folder
    const movedCheck = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM folders WHERE tenant_id = ? AND parent_id = ? AND classification = 'confidential' AND deleted_at IS NULL) AS conf_folders,
         (SELECT COUNT(*) FROM files WHERE tenant_id = ? AND folder_id = ? AND classification = 'confidential' AND deleted_at IS NULL) AS conf_files`
    )
      .bind(TENANT_ID, dst50.id, TENANT_ID, dst50.id)
      .first<{ conf_folders: number; conf_files: number }>();
    expect(movedCheck).toEqual({ conf_folders: 25, conf_files: 25 });

    // 2. Reject moving an inactive ('pending') upload file
    const pendingInitRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/files/upload-init', {
        method: 'POST',
        headers: authHeaders('ws-owner'),
        body: JSON.stringify({
          folderId: src50.id,
          fileName: 'still-uploading.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: 128,
        }),
      }),
      testEnv
    );
    expect(pendingInitRes.status).toBe(201);
    const { fileId: pendingFileId } = (await pendingInitRes.json()) as { fileId: string };

    const movePendingRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/batch-move', {
        method: 'POST',
        headers: authHeaders('ws-owner'),
        body: JSON.stringify({
          items: [{ type: 'file', id: pendingFileId }],
          targetParentId: dst50.id,
        }),
      }),
      testEnv
    );
    expect(movePendingRes.status).toBeGreaterThanOrEqual(400);
    expect(movePendingRes.status).toBeLessThan(500);

    // 3. Reject copying a previewer-role folder + reject duplicating a previewer-role file with audit_logs entries
    const previewOnlyFolder = await createFolder(testEnv, 'ws-owner', 'PreviewOnlyFolder', null, 'internal');
    const previewFile = await uploadActiveFile(testEnv, 'ws-owner', previewOnlyFolder.id, 'hidden.txt', 'secret');
    const copyOutDest = await createFolder(testEnv, 'ws-owner', 'CopyOutDest', null, 'internal');

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('perm-sub-1', '${TENANT_ID}', 'folder', ?, 'user', 'ws-previewer', 'previewer', 'ws-owner'),
           ('perm-sub-2', '${TENANT_ID}', 'folder', ?, 'user', 'ws-previewer', 'editor', 'ws-owner')`
      ).bind(previewOnlyFolder.id, copyOutDest.id),
    ]);

    const subDlpCopyRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/copy', {
        method: 'POST',
        headers: authHeaders('ws-previewer'),
        body: JSON.stringify({
          items: [{ type: 'folder', id: previewOnlyFolder.id }],
          targetParentId: copyOutDest.id,
        }),
      }),
      testEnv
    );
    expect(subDlpCopyRes.status).toBe(403);
    expect(((await subDlpCopyRes.json()) as { code: string }).code).toBe('DLP_COPY_FORBIDDEN');

    const subAudit = await env.DB.prepare(
      `SELECT status FROM audit_logs
        WHERE tenant_id = ? AND actor_id = 'ws-previewer' AND target_id = ? AND action = 'workspace.copy_denied'`
    )
      .bind(TENANT_ID, previewOnlyFolder.id)
      .first<{ status: string }>();
    expect(subAudit).toEqual({ status: 'blocked' });

    const dupPreviewerRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/workspace/duplicate', {
        method: 'POST',
        headers: authHeaders('ws-previewer'),
        body: JSON.stringify({
          items: [{ type: 'file', id: previewFile.file.id }],
        }),
      }),
      testEnv
    );
    expect(dupPreviewerRes.status).toBe(403);
  });
});
