import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

function authHeaders(
  userId = 'fc-owner',
  role: 'sys_admin' | 'member' = 'sys_admin',
  tenantId = 'tenant-fc'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@example.com`,
    'Content-Type': 'application/json',
  };
}

function buildTestEnv(queueSpy?: { send: (msg: unknown) => Promise<void> }): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    STORAGE_MODE: 'local_proxy',
    ...(queueSpy ? { JOBS_QUEUE: queueSpy as unknown as Queue } : {}),
  } as OidcEnv;
}

describe('Folder Closure Hierarchy, Cycle Prevention, Move & Restore (TOM-11)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-fc', 'Closure Org', 'closure-org')"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES ('tenant-fc')"
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('fc-owner', 'tenant-fc', 'fc-owner@example.com', 'FC Owner', 'sys_admin', 'active'),
           ('fc-outsider', 'tenant-fc', 'fc-outsider@example.com', 'FC Outsider', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES ('tenant-fc', 'unset', 0, 0), ('tenant-fc', 'public', 0, 0), ('tenant-fc', 'internal', 0, 0), ('tenant-fc', 'confidential', 0, 0)`
      ),
    ]);
  });

  it('creates closures, enforces max depth 20, resolves breadcrumbs, and paginates via Keyset cursor', async () => {
    const testEnv = buildTestEnv();

    // Create depth 0 -> 1 -> 2 chain inheriting confidential label
    const r0 = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'TopConf', classification: 'confidential' }),
      }),
      testEnv
    );
    expect(r0.status).toBe(201);
    const f0 = ((await r0.json()) as { folder: { id: string; depth: number; classification: string } }).folder;
    expect(f0.depth).toBe(0);

    // Subfolder tries to specify 'public', must stay at parent's stricter 'confidential'
    const r1 = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'Sub1', parentId: f0.id, classification: 'public' }),
      }),
      testEnv
    );
    expect(r1.status).toBe(201);
    const f1 = ((await r1.json()) as { folder: { id: string; depth: number; classification: string } }).folder;
    expect(f1.depth).toBe(1);
    expect(f1.classification).toBe('confidential');

    // Breadcrumbs check
    const bcRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${f1.id}/breadcrumbs`, {
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(bcRes.status).toBe(200);
    const bcBody = (await bcRes.json()) as { breadcrumbs: Array<{ id: string; name: string }> };
    expect(bcBody.breadcrumbs.map((b) => b.name)).toEqual(['TopConf', 'Sub1']);

    // Outsider cannot read Sub1
    const outsiderRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${f1.id}/children`, {
        headers: authHeaders('fc-outsider', 'member'),
      }),
      testEnv
    );
    expect(outsiderRes.status).toBe(403);

    // Build chain up to depth 20 directly and confirm depth 21 is rejected
    let currentParentId = f1.id;
    for (let d = 2; d <= 20; d++) {
      const nextRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/folders', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ name: `Depth-${d}`, parentId: currentParentId }),
        }),
        testEnv
      );
      expect(nextRes.status).toBe(201);
      const created = ((await nextRes.json()) as { folder: { id: string; depth: number } }).folder;
      expect(created.depth).toBe(d);
      currentParentId = created.id;
    }

    const depth21Res = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'Depth-21', parentId: currentParentId }),
      }),
      testEnv
    );
    expect(depth21Res.status).toBe(400);

    // Keyset pagination check in f0: create 2 extra subfolders + 3 active files + 1 pending file
    for (const subName of ['AlphaDir', 'ZetaDir']) {
      await app.fetch(
        new Request('http://127.0.0.1:8787/api/folders', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ name: subName, parentId: f0.id }),
        }),
        testEnv
      );
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES
           ('fc-file-a', 'tenant-fc', ?, 'a.pdf', 'application/pdf', 100, 'active', 'confidential', 'fc-owner', 'fc-owner'),
           ('fc-file-b', 'tenant-fc', ?, 'b.pdf', 'application/pdf', 100, 'active', 'confidential', 'fc-owner', 'fc-owner'),
           ('fc-file-c', 'tenant-fc', ?, 'c.pdf', 'application/pdf', 100, 'active', 'confidential', 'fc-owner', 'fc-owner'),
           ('fc-file-pending', 'tenant-fc', ?, 'pending.pdf', 'application/pdf', 100, 'pending', 'confidential', 'fc-owner', 'fc-owner')`
      ).bind(f0.id, f0.id, f0.id, f0.id),
    ]);

    const seenFolders: string[] = [];
    const seenFiles: string[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL(`http://127.0.0.1:8787/api/folders/${f0.id}/children`);
      url.searchParams.set('limit', '2');
      if (cursor) url.searchParams.set('cursor', cursor);
      const pageRes = await app.fetch(new Request(url.toString(), { headers: authHeaders() }), testEnv);
      expect(pageRes.status).toBe(200);
      const page = (await pageRes.json()) as {
        folders: Array<{ name: string }>;
        files: Array<{ name: string }>;
        nextCursor: string | null;
      };
      seenFolders.push(...page.folders.map((f) => f.name));
      seenFiles.push(...page.files.map((f) => f.name));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seenFolders).toEqual(['AlphaDir', 'Sub1', 'ZetaDir']);
    expect(seenFiles).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
    expect(seenFiles).not.toContain('pending.pdf');
  });

  it('blocks circular moves, enforces optimistic lock, upgrades sensitivity inline or via queue (>100), and restores batches cleanly', async () => {
    const queueSend = vi.fn(async () => {});
    const testEnv = buildTestEnv({ send: queueSend });

    // Create two root branches: ConfRoot (confidential) and PubTree (public) -> ChildFolder -> LeafFolder
    const confRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'ConfDest', classification: 'confidential' }),
      }),
      testEnv
    );
    const confDest = ((await confRes.json()) as { folder: { id: string } }).folder;

    const pubRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'PubSrc', classification: 'public' }),
      }),
      testEnv
    );
    const pubSrc = ((await pubRes.json()) as { folder: { id: string; version: number } }).folder;

    const childRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'SubFolder', parentId: pubSrc.id }),
      }),
      testEnv
    );
    const subFolder = ((await childRes.json()) as { folder: { id: string } }).folder;

    // 1. Cycle detection: moving PubSrc into its descendant SubFolder must return 400 CYCLE_DETECTED
    const cycleRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${pubSrc.id}/move`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ targetParentId: subFolder.id }),
      }),
      testEnv
    );
    expect(cycleRes.status).toBe(400);
    expect(((await cycleRes.json()) as { code: string }).code).toBe('CYCLE_DETECTED');

    // 2. Optimistic version mismatch returns 409 VERSION_CONFLICT
    const staleVersionRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${pubSrc.id}/move`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ targetParentId: confDest.id, expectedVersion: 999 }),
      }),
      testEnv
    );
    expect(staleVersionRes.status).toBe(409);

    // Seed an active public file inside SubFolder so move raises it to confidential + syncs FTS & stats
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES ('move-f1', 'tenant-fc', ?, 'plan.txt', 'txt', 'text/plain', 250, 'active', 'public', 'fc-owner', 'fc-owner')`
      ).bind(subFolder.id),
      env.DB.prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES ('move-f1', 'tenant-fc', 'public', 'plan.txt', 'txt', '')`
      ),
      env.DB.prepare(
        `UPDATE tenant_storage_stats SET file_count = file_count + 1, total_bytes = total_bytes + 250
          WHERE tenant_id = 'tenant-fc' AND classification = 'public'`
      ),
    ]);

    // 3. Valid inline move under ConfDest
    const moveOk = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${pubSrc.id}/move`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ targetParentId: confDest.id, expectedVersion: pubSrc.version }),
      }),
      testEnv
    );
    expect(moveOk.status).toBe(200);
    const movedBody = (await moveOk.json()) as {
      folder: { depth: number; version: number; classification: string };
      classificationJobQueued: boolean;
    };
    expect(movedBody.classificationJobQueued).toBe(false);
    expect(movedBody.folder.depth).toBe(1);
    expect(movedBody.folder.classification).toBe('confidential');

    // Verify subfolder depth became 2, classification became confidential, and FTS + stats updated
    const subAfter = await env.DB.prepare('SELECT depth, classification FROM folders WHERE id = ?')
      .bind(subFolder.id)
      .first<{ depth: number; classification: string }>();
    expect(subAfter).toEqual({ depth: 2, classification: 'confidential' });

    const ftsHit = await env.DB.prepare(
      "SELECT file_id FROM files_fts WHERE files_fts MATCH 'classification : confidential AND plan*'"
    ).first<{ file_id: string }>();
    expect(ftsHit?.file_id).toBe('move-f1');

    // 4. Test >100 items move offloads classification propagation to JOBS_QUEUE
    const largeSrcRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'LargePublicFolder', classification: 'public' }),
      }),
      testEnv
    );
    const largeSrc = ((await largeSrcRes.json()) as { folder: { id: string } }).folder;
    const bulkFiles: D1PreparedStatement[] = [];
    for (let i = 0; i < 105; i++) {
      bulkFiles.push(
        env.DB.prepare(
          `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
           VALUES (?, 'tenant-fc', ?, ?, 'text/plain', 10, 'active', 'public', 'fc-owner', 'fc-owner')`
        ).bind(`large-f-${i}`, largeSrc.id, `doc-${i}.txt`)
      );
    }
    await env.DB.batch(bulkFiles.slice(0, 55));
    await env.DB.batch(bulkFiles.slice(55));

    const largeMoveRes = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${largeSrc.id}/move`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ targetParentId: confDest.id }),
      }),
      testEnv
    );
    expect(largeMoveRes.status).toBe(200);
    const largeMoveBody = (await largeMoveRes.json()) as { classificationJobQueued: boolean };
    expect(largeMoveBody.classificationJobQueued).toBe(true);
    expect(queueSend).toHaveBeenCalledTimes(1);

    // 5. Soft delete & restore batch timestamp preservation + name conflict rename
    const trashParentRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'TrashTarget' }),
      }),
      testEnv
    );
    const trashParent = ((await trashParentRes.json()) as { folder: { id: string } }).folder;

    const earlyDeletedChildRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'DeletedEarlier', parentId: trashParent.id }),
      }),
      testEnv
    );
    const earlyChild = ((await earlyDeletedChildRes.json()) as { folder: { id: string } }).folder;

    // Delete earlyChild FIRST at T1
    expect(
      (
        await app.fetch(
          new Request(`http://127.0.0.1:8787/api/folders/${earlyChild.id}`, {
            method: 'DELETE',
            headers: authHeaders(),
          }),
          testEnv
        )
      ).status
    ).toBe(200);

    // Add active file inside TrashTarget at T2
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, classification, created_by, updated_by)
         VALUES ('trash-f-t2', 'tenant-fc', ?, 'keepme.txt', 'text/plain', 50, 'active', 'unset', 'fc-owner', 'fc-owner')`
      ).bind(trashParent.id),
      env.DB.prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES ('trash-f-t2', 'tenant-fc', 'unset', 'keepme.txt', 'txt', '')`
      ),
    ]);

    // Ensure different timestamp by delaying 5ms
    await new Promise((r) => setTimeout(r, 5));

    // Soft delete TrashTarget at T2 -> FTS entry removed
    expect(
      (
        await app.fetch(
          new Request(`http://127.0.0.1:8787/api/folders/${trashParent.id}`, {
            method: 'DELETE',
            headers: authHeaders(),
          }),
          testEnv
        )
      ).status
    ).toBe(200);

    expect(
      await env.DB.prepare("SELECT file_id FROM files_fts WHERE file_id = 'trash-f-t2'").first()
    ).toBeNull();

    // Create colliding folder named "TrashTarget" at root
    await app.fetch(
      new Request('http://127.0.0.1:8787/api/folders', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ name: 'TrashTarget' }),
      }),
      testEnv
    );

    // Default restore returns 409 NAME_CONFLICT
    const conflictRestore = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/folders/${trashParent.id}/restore`, {
        method: 'POST',
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(conflictRestore.status).toBe(409);

    // conflictPolicy=rename restores with suffix, re-indexes T2 file, and leaves T1 child deleted!
    const renameRestore = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/folders/${trashParent.id}/restore?conflictPolicy=rename`,
        {
          method: 'POST',
          headers: authHeaders(),
        }
      ),
      testEnv
    );
    expect(renameRestore.status).toBe(200);
    const restored = (await renameRestore.json()) as { folder: { name: string } };
    expect(restored.folder.name).toBe('TrashTarget (Restored)');

    const ftsRestored = await env.DB.prepare(
      "SELECT file_id FROM files_fts WHERE files_fts MATCH 'keepme*'"
    ).first<{ file_id: string }>();
    expect(ftsRestored?.file_id).toBe('trash-f-t2');

    const earlyAfter = await env.DB.prepare('SELECT deleted_at FROM folders WHERE id = ?')
      .bind(earlyChild.id)
      .first<{ deleted_at: string | null }>();
    expect(earlyAfter?.deleted_at).toBeTruthy();
  });
});
