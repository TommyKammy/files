import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-lock';
const USER_ID = 'lock-owner';
const FILE_ID = 'lock-file-1';

function authHeaders(): Record<string, string> {
  return {
    'X-Dev-User-Id': USER_ID,
    'X-Dev-User-Role': 'sys_admin',
    'X-Dev-Tenant-Id': TENANT_ID,
    'X-Dev-User-Email': `${USER_ID}@example.com`,
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
    LOCAL_PROXY_SECRET: 'lock-sync-secret',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
    ...overrides,
  } as OidcEnv;
}

function lockStub(testEnv: OidcEnv, fileId: string) {
  const namespace = testEnv.FILE_LOCK_HUB!;
  return namespace.get(namespace.idFromName(fileId));
}

async function openSyncSocket(
  testEnv: OidcEnv
): Promise<{ ws: WebSocket; messages: string[] }> {
  const ticketRes = await app.fetch(
    new Request('http://127.0.0.1:8787/api/sync/ws-ticket', {
      method: 'POST',
      headers: authHeaders(),
    }),
    testEnv
  );
  expect(ticketRes.status).toBe(200);
  const ticketBody = (await ticketRes.json()) as { wsUrl: string };

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
  const ws = wsRes.webSocket!;
  const messages: string[] = [];
  ws.addEventListener('message', (event) => {
    messages.push(typeof event.data === 'string' ? event.data : String(event.data));
  });
  ws.accept();
  return { ws, messages };
}

async function waitForLockSignal(
  messages: string[],
  timeoutMs = 2000
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const raw of [...messages]) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.eventKind === 'file.lock_changed') return parsed;
      } catch {
        // Ignore ping/pong or malformed frames
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return null;
}

describe('FileLockHub Durable Object & unified file lock guard', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'Lock Org', 'lock-org', 5000000)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES (?, ?, 'lock-owner@example.com', 'Lock Owner', 'sys_admin', 'active')`
      ).bind(USER_ID, TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, classification,
           created_by, updated_by
         ) VALUES (?, ?, NULL, 'locked.docx', 'docx',
           'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           128, 'active', NULL, 1, 'internal', ?, ?)`
      ).bind(FILE_ID, TENANT_ID, USER_ID, USER_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by
         ) VALUES ('lock-perm-1', ?, 'file', ?, 'user', ?, 'owner', ?)`
      ).bind(TENANT_ID, FILE_ID, USER_ID, USER_ID),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (
           tenant_id, classification, file_count, total_bytes
         ) VALUES (?, 'internal', 1, 128)`
      ).bind(TENANT_ID),
    ]);
  });

  it('serializes WOPI locks and rejects mismatched lock tokens with the current lock', async () => {
    const testEnv = buildTestEnv();
    const stub = lockStub(testEnv, 'lock-serial');

    const acquired = await stub.lockFile({
      fileId: 'lock-serial',
      tenantId: TENANT_ID,
      mode: 'wopi_collab',
      lockId: 'lock-a',
      ownerId: USER_ID,
      ownerName: 'Lock Owner',
      ownerEmail: 'lock-owner@example.com',
      ttlSeconds: 300,
    });
    expect(acquired.ok).toBe(true);

    const conflict = await stub.lockFile({
      fileId: 'lock-serial',
      tenantId: TENANT_ID,
      mode: 'wopi_collab',
      lockId: 'lock-b',
      ownerId: 'another-user',
      ownerName: 'Another User',
      ttlSeconds: 300,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.lock?.lockId).toBe('lock-a');
      expect(conflict.lock?.mode).toBe('wopi_collab');
    }

    const wrongUnlock = await stub.unlockFile({
      fileId: 'lock-serial',
      lockId: 'lock-b',
    });
    expect(wrongUnlock.ok).toBe(false);

    const relocked = await stub.unlockAndRelock({
      fileId: 'lock-serial',
      lockId: 'lock-a',
      newLockId: 'lock-b',
      ttlSeconds: 300,
    });
    expect(relocked.ok).toBe(true);
    if (relocked.ok) expect(relocked.lock.lockId).toBe('lock-b');

    const released = await stub.unlockFile({
      fileId: 'lock-serial',
      lockId: 'lock-b',
    });
    expect(released).toEqual({ ok: true, released: true });
    expect((await stub.getLock({ fileId: 'lock-serial' })).lock).toBeNull();
  });

  it('keeps WOPI and desktop-exclusive modes mutually exclusive', async () => {
    const testEnv = buildTestEnv();
    const stub = lockStub(testEnv, 'lock-mode');

    const desktop = await stub.lockFile({
      fileId: 'lock-mode',
      tenantId: TENANT_ID,
      mode: 'desktop_exclusive',
      lockId: 'desktop-a',
      ownerId: USER_ID,
      ownerName: 'Desktop User',
      ttlSeconds: 300,
    });
    expect(desktop.ok).toBe(true);

    const wopi = await stub.lockFile({
      fileId: 'lock-mode',
      tenantId: TENANT_ID,
      mode: 'wopi_collab',
      lockId: 'wopi-a',
      ownerId: 'wopi-user',
      ownerName: 'WOPI User',
      ttlSeconds: 300,
    });
    expect(wopi.ok).toBe(false);
    if (!wopi.ok) {
      expect(wopi.lock?.mode).toBe('desktop_exclusive');
      expect(wopi.lock?.lockId).toBe('desktop-a');
    }

    await stub.unlockFile({ fileId: 'lock-mode', lockId: 'desktop-a' });
  });

  it('auto-expires timed-out locks and releases them deterministically', async () => {
    const testEnv = buildTestEnv();
    const stub = lockStub(testEnv, 'lock-ttl');

    const acquired = await stub.lockFile({
      fileId: 'lock-ttl',
      tenantId: TENANT_ID,
      mode: 'wopi_collab',
      lockId: 'ttl-lock',
      ownerId: USER_ID,
      ownerName: 'TTL User',
      ttlSeconds: 1,
    });
    expect(acquired.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // The DO alarm may release the lock before purgeExpired runs, so assert the
    // observable state after the TTL instead of the purge return flag.
    expect((await stub.getLock({ fileId: 'lock-ttl' })).lock).toBeNull();
    const purged = await stub.purgeExpired();
    expect(purged.lock).toBeNull();
  });

  it('broadcasts file.lock_changed to TenantSyncHub clients', async () => {
    const testEnv = buildTestEnv();
    const client = await openSyncSocket(testEnv);
    try {
      const stub = lockStub(testEnv, 'lock-notify');
      const acquired = await stub.lockFile({
        fileId: 'lock-notify',
        tenantId: TENANT_ID,
        mode: 'wopi_collab',
        lockId: 'notify-lock',
        ownerId: USER_ID,
        ownerName: 'Notify User',
        ttlSeconds: 300,
      });
      expect(acquired.ok).toBe(true);

      const signal = await waitForLockSignal(client.messages);
      expect(signal).not.toBeNull();
      expect(signal?.eventKind).toBe('file.lock_changed');
      const metadata = signal?.metadata as
        | { fileId?: string; reason?: string; lock?: { lockId?: string } }
        | undefined;
      expect(metadata?.fileId).toBe('lock-notify');
      expect(metadata?.reason).toBe('acquired');
      expect(metadata?.lock?.lockId).toBe('notify-lock');
    } finally {
      try {
        client.ws.close(1000, 'test_cleanup');
      } catch {
        // Already closed
      }
    }
  });

  it('blocks DELETE /api/files/:id while locked and allows it after unlock', async () => {
    const testEnv = buildTestEnv();
    const stub = lockStub(testEnv, FILE_ID);
    const acquired = await stub.lockFile({
      fileId: FILE_ID,
      tenantId: TENANT_ID,
      mode: 'desktop_exclusive',
      lockId: 'delete-lock',
      ownerId: USER_ID,
      ownerName: 'Lock Owner',
      ttlSeconds: 300,
    });
    expect(acquired.ok).toBe(true);

    const blocked = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_ID}`, {
        method: 'DELETE',
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as {
      code?: string;
      lock?: { lockId?: string };
    };
    expect(blockedBody.code).toBe('FILE_LOCKED');
    expect(blockedBody.lock?.lockId).toBe('delete-lock');

    const released = await stub.unlockFile({
      fileId: FILE_ID,
      lockId: 'delete-lock',
    });
    expect(released).toEqual({ ok: true, released: true });

    const allowed = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_ID}`, {
        method: 'DELETE',
        headers: authHeaders(),
      }),
      testEnv
    );
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { ok: boolean }).ok).toBe(true);
  });
});
