import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sha256Hex } from '../src/services/crypto-utils';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-rt';
const ZERO_CLIENT_TENANT_ID = 'tenant-rt-empty';

function authHeaders(
  userId = 'rt-owner',
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

function buildTestEnv(overrides: Partial<OidcEnv> = {}): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN: 'http://127.0.0.1:8787',
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'rt-sync-secret',
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
    ...overrides,
  } as OidcEnv;
}

async function openWsWithTicket(
  testEnv: OidcEnv,
  userId: string,
  role: 'sys_admin' | 'member' = 'member',
  origin = 'http://127.0.0.1:8787'
): Promise<{
  ws: WebSocket;
  ticket: string;
  messages: string[];
  closeEvents: Array<{ code: number; reason: string }>;
  waitForMessages: (minCount: number, timeoutMs?: number) => Promise<string[]>;
  waitForClose: (timeoutMs?: number) => Promise<{ code: number; reason: string }>;
}> {
  const ticketRes = await app.fetch(
    new Request('http://127.0.0.1:8787/api/sync/ws-ticket', {
      method: 'POST',
      headers: authHeaders(userId, role),
    }),
    testEnv
  );
  expect(ticketRes.status).toBe(200);
  const ticketBody = (await ticketRes.json()) as { ticket: string; wsUrl: string };

  const wsRes = await app.fetch(
    new Request(ticketBody.wsUrl.replace('ws://', 'http://'), {
      headers: {
        Upgrade: 'websocket',
        Origin: origin,
      },
    }),
    testEnv
  );
  expect(wsRes.status).toBe(101);
  const ws = wsRes.webSocket;
  expect(ws).toBeTruthy();

  const messages: string[] = [];
  const closeEvents: Array<{ code: number; reason: string }> = [];
  ws!.addEventListener('message', (event) => {
    messages.push(typeof event.data === 'string' ? event.data : String(event.data));
  });
  ws!.addEventListener('close', (event) => {
    closeEvents.push({ code: event.code, reason: event.reason });
  });
  ws!.accept();

  const waitForMessages = async (minCount: number, timeoutMs = 2000): Promise<string[]> => {
    const deadline = Date.now() + timeoutMs;
    while (messages.length < minCount && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    return messages;
  };

  const waitForClose = async (
    timeoutMs = 2000
  ): Promise<{ code: number; reason: string }> => {
    const deadline = Date.now() + timeoutMs;
    while (closeEvents.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(closeEvents.length).toBeGreaterThan(0);
    return closeEvents[0];
  };

  return {
    ws: ws!,
    ticket: ticketBody.ticket,
    messages,
    closeEvents,
    waitForMessages,
    waitForClose,
  };
}

async function closeWsQuietly(ws: WebSocket | undefined): Promise<void> {
  if (!ws) return;
  try {
    ws.close(1000, 'test_cleanup');
  } catch {
    // Already closed
  }
  await new Promise((r) => setTimeout(r, 20));
}

describe('TenantSyncHub Durable Object & Zero-Trust WebSocket Real-time Sync', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const scimHash = await sha256Hex('rt-scim-token');
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES
           ('tenant-rt', 'Realtime Org', 'rt-org', 5000000),
           ('tenant-rt-empty', 'Empty Org', 'empty-org', 5000000)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id)
         VALUES ('tenant-rt'), ('tenant-rt-empty')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO scim_tokens (id, tenant_id, idp_issuer, name, token_hash, last_used_at, revoked_at)
         VALUES ('rt-scim-1', 'tenant-rt', 'https://idp.rt.example', 'RT SCIM', ?, NULL, NULL)`
      ).bind(scimHash),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           ('rt-owner', 'tenant-rt', 'rt-owner@example.com', 'RT Owner', 'sys_admin', 'active'),
           ('rt-collab', 'tenant-rt', 'rt-collab@example.com', 'RT Collab', 'member', 'active'),
           ('rt-outsider', 'tenant-rt', 'rt-outsider@example.com', 'RT Outsider', 'member', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES
           ('tenant-rt', 'unset', 0, 0),
           ('tenant-rt', 'public', 0, 0),
           ('tenant-rt', 'internal', 0, 0),
           ('tenant-rt', 'confidential', 0, 0)`
      ),
    ]);
  });

  it('enforces WebSocket Upgrade headers, CSWSH Origin validation, and single-use ticket consumption', async () => {
    const testEnv = buildTestEnv();

    const noAuthTicketRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/sync/ws-ticket', { method: 'POST' }),
      testEnv
    );
    expect(noAuthTicketRes.status).toBe(401);

    const nonWsRes = await app.fetch(
      new Request('http://127.0.0.1:8787/api/sync/ws'),
      testEnv
    );
    expect(nonWsRes.status).toBe(426);

    const client = await openWsWithTicket(testEnv, 'rt-owner', 'sys_admin');
    try {
      // Mismatched Origin is blocked (403 CSWSH defense)
      const badOriginRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/sync/ws?ticket=${encodeURIComponent(client.ticket)}`, {
          headers: {
            Upgrade: 'websocket',
            Origin: 'https://evil.attacker.example',
          },
        }),
        testEnv
      );
      expect(badOriginRes.status).toBe(403);

      // Missing Origin in non-local staging/production environment is blocked (403)
      const prodEnv = buildTestEnv({
        ENVIRONMENT: 'production',
        ALLOW_DEV_AUTH: 'false',
        APP_ORIGIN: 'https://files.example.com',
      });
      const prodNoOriginRes = await app.fetch(
        new Request('https://files.example.com/api/sync/ws?ticket=unused', {
          headers: { Upgrade: 'websocket' },
        }),
        prodEnv
      );
      expect(prodNoOriginRes.status).toBe(403);

      // Replaying an already-consumed single-use ticket is rejected (401)
      const replayRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/sync/ws?ticket=${encodeURIComponent(client.ticket)}`, {
          headers: {
            Upgrade: 'websocket',
            Origin: 'http://127.0.0.1:8787',
          },
        }),
        testEnv
      );
      expect(replayRes.status).toBe(401);
    } finally {
      await closeWsQuietly(client.ws);
    }
  });

  it('short-circuits at 0 connected clients, supports hibernatable ping/pong, and preserves Zero-Trust RBAC isolation', async () => {
    const testEnv = buildTestEnv();

    // 0-client short-circuit avoids DO WebSocket iteration overhead
    const emptyStub = testEnv.SYNC_HUB!.get(
      testEnv.SYNC_HUB!.idFromName(ZERO_CLIENT_TENANT_ID)
    );
    const emptyPublish = await emptyStub.publishSignal({
      tenantId: ZERO_CLIENT_TENANT_ID,
      seq: 1,
      eventKind: 'file.update',
      scopeFolderIds: ['f-empty'],
    });
    expect(emptyPublish).toEqual({ skipped: true, recipientCount: 0 });

    const ownerWs = await openWsWithTicket(testEnv, 'rt-owner', 'sys_admin');
    const collabWs = await openWsWithTicket(testEnv, 'rt-collab', 'member');

    try {
      // Auto-response ping/pong operates inside Hibernation layer without JS wakeups
      ownerWs.ws.send('ping');
      const pongFrames = await ownerWs.waitForMessages(1);
      expect(pongFrames[0]).toBe('pong');

      // Record collab's starting sync seq before confidential vs shared writes
      const bootstrapRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/sync/bootstrap', {
          headers: authHeaders('rt-collab', 'member'),
        }),
        testEnv
      );
      expect(bootstrapRes.status).toBe(200);
      const startSeq = ((await bootstrapRes.json()) as { currentSeq: number }).currentSeq;

      // 1) Owner creates Confidential folder & uploads secret file (NOT shared with collab)
      const secretFolderRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/folders', {
          method: 'POST',
          headers: authHeaders('rt-owner', 'sys_admin'),
          body: JSON.stringify({
            name: 'SecretConfidentialVault',
            classification: 'confidential',
          }),
        }),
        testEnv
      );
      expect(secretFolderRes.status).toBe(201);
      const secretFolderId = ((await secretFolderRes.json()) as { folder: { id: string } })
        .folder.id;

      const initRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/files/upload-init', {
          method: 'POST',
          headers: authHeaders('rt-owner', 'sys_admin'),
          body: JSON.stringify({
            folderId: secretFolderId,
            fileName: 'board_secret_plan.txt',
            mimeType: 'text/plain',
            sizeBytes: 17,
            classification: 'confidential',
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
        new Request(new URL(initData.uploadUrl, 'http://127.0.0.1:8787').toString(), {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: 'top secret cipher',
        }),
        testEnv
      );
      expect(putRes.status).toBe(200);
      const completeRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/files/upload-complete', {
          method: 'POST',
          headers: authHeaders('rt-owner', 'sys_admin'),
          body: JSON.stringify({ fileId: initData.fileId, versionId: initData.versionId }),
        }),
        testEnv
      );
      expect(completeRes.status).toBe(200);

      // 2) Owner creates Shared folder and grants collab access
      const sharedFolderRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/folders', {
          method: 'POST',
          headers: authHeaders('rt-owner', 'sys_admin'),
          body: JSON.stringify({
            name: 'SharedTeamWorkspace',
            classification: 'internal',
          }),
        }),
        testEnv
      );
      expect(sharedFolderRes.status).toBe(201);
      const sharedFolderId = ((await sharedFolderRes.json()) as { folder: { id: string } })
        .folder.id;

      const grantRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/permissions', {
          method: 'POST',
          headers: authHeaders('rt-owner', 'sys_admin'),
          body: JSON.stringify({
            targetType: 'folder',
            targetId: sharedFolderId,
            granteeType: 'user',
            granteeId: 'rt-collab',
            role: 'editor',
          }),
        }),
        testEnv
      );
      expect(grantRes.status).toBe(201);
      const permissionId = ((await grantRes.json()) as { permission: { id: string } })
        .permission.id;

      // Collab received WS invalidation signals, and NO confidential file/folder names ever crossed WS!
      const collabFrames = await collabWs.waitForMessages(4);
      expect(collabFrames.length).toBeGreaterThanOrEqual(4);
      const allRawFrames = collabFrames.join('\n');
      expect(allRawFrames).not.toContain('SecretConfidentialVault');
      expect(allRawFrames).not.toContain('board_secret_plan.txt');
      expect(allRawFrames).not.toContain('rt-owner@example.com');

      const parsedFrames = collabFrames.map(
        (raw) => JSON.parse(raw) as Record<string, unknown>
      );
      for (const frame of parsedFrames) {
        expect(Object.keys(frame).sort()).toEqual(
          ['eventKind', 'scopeFolderIds', 'seq', 'timestamp', 'type'].sort()
        );
      }

      // Collab pulls RBAC-filtered delta: sees ONLY SharedTeamWorkspace, never ConfidentialVault or secret file
      const deltaRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/sync/delta?sinceSeq=${startSeq}`, {
          headers: authHeaders('rt-collab', 'member'),
        }),
        testEnv
      );
      expect(deltaRes.status).toBe(200);
      const deltaBody = (await deltaRes.json()) as {
        changes: Array<{ entityId: string; action: string; payload: unknown }>;
      };
      const deltaJson = JSON.stringify(deltaBody);
      expect(deltaJson).toContain('SharedTeamWorkspace');
      expect(deltaJson).not.toContain('SecretConfidentialVault');
      expect(deltaJson).not.toContain('board_secret_plan.txt');

      // 3) Scoped permission.revoke notifies ONLY target user (rt-collab), not rt-outsider/rt-owner
      const ownerCountBeforeRevoke = ownerWs.messages.length;
      const collabCountBeforeRevoke = collabWs.messages.length;
      const revokeRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/permissions/${permissionId}`, {
          method: 'DELETE',
          headers: authHeaders('rt-owner', 'sys_admin'),
        }),
        testEnv
      );
      expect(revokeRes.status).toBe(200);

      await collabWs.waitForMessages(collabCountBeforeRevoke + 1);
      const revokeFrame = JSON.parse(
        collabWs.messages[collabWs.messages.length - 1]
      ) as { eventKind: string; revoked?: boolean; scopeFolderIds: string[] };
      expect(revokeFrame.eventKind).toBe('permission.revoke');
      expect(revokeFrame.revoked).toBe(true);
      expect(revokeFrame.scopeFolderIds).toContain(sharedFolderId);
      expect(ownerWs.messages.length).toBe(ownerCountBeforeRevoke);
    } finally {
      await Promise.all([closeWsQuietly(ownerWs.ws), closeWsQuietly(collabWs.ws)]);
    }
  });

  it('pushes instant user.suspended signal and closes WebSocket 4001 on SCIM suspension without disconnecting other users', async () => {
    const testEnv = buildTestEnv();
    const ownerWs = await openWsWithTicket(testEnv, 'rt-owner', 'sys_admin');
    const outsiderWs = await openWsWithTicket(testEnv, 'rt-outsider', 'member');

    try {
      const ownerMessagesBefore = ownerWs.messages.length;
      const t0 = performance.now();
      const scimDeleteRes = await app.fetch(
        new Request('http://127.0.0.1:8787/scim/v2/Users/rt-outsider', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer rt-scim-token' },
        }),
        testEnv
      );
      expect(scimDeleteRes.status).toBe(204);

      const outsiderMessages = await outsiderWs.waitForMessages(1);
      const closeInfo = await outsiderWs.waitForClose();
      const pushLatencyMs = performance.now() - t0;

      const securityFrame = JSON.parse(outsiderMessages[0]) as {
        type: string;
        eventKind: string;
        revoked?: boolean;
      };
      expect(securityFrame.type).toBe('sync.security_revoke');
      expect(securityFrame.eventKind).toBe('user.suspended');
      expect(securityFrame.revoked).toBe(true);
      expect(closeInfo.code).toBe(4001);
      expect(pushLatencyMs).toBeLessThan(1000);

      // Owner socket stays unaffected & open
      expect(ownerWs.closeEvents.length).toBe(0);
      expect(ownerWs.messages.length).toBe(ownerMessagesBefore);

      // Suspended user cannot reconnect even with dev-bypass headers
      const blockedWsRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/sync/ws', {
          headers: {
            Upgrade: 'websocket',
            Origin: 'http://127.0.0.1:8787',
            'X-Dev-User-Id': 'rt-outsider',
            'X-Dev-Tenant-Id': TENANT_ID,
          },
        }),
        testEnv
      );
      expect(blockedWsRes.status).toBe(401);
    } finally {
      await Promise.all([closeWsQuietly(ownerWs.ws), closeWsQuietly(outsiderWs.ws)]);
    }
  });

  it('executes single-batch /api/sync/bootstrap, /api/sync/delta, and TenantSyncHub fan-out within low-latency edge budget', async () => {
    const testEnv = buildTestEnv();
    const ownerWs = await openWsWithTicket(testEnv, 'rt-owner', 'sys_admin');

    try {
      const tBoot0 = performance.now();
      const bootRes = await app.fetch(
        new Request('http://127.0.0.1:8787/api/sync/bootstrap', {
          headers: authHeaders('rt-owner', 'sys_admin'),
        }),
        testEnv
      );
      const bootMs = performance.now() - tBoot0;
      expect(bootRes.status).toBe(200);
      const bootBody = (await bootRes.json()) as { currentSeq: number };

      const stub = testEnv.SYNC_HUB!.get(testEnv.SYNC_HUB!.idFromName(TENANT_ID));
      const tPub0 = performance.now();
      const pubRes = await stub.publishSignal({
        tenantId: TENANT_ID,
        seq: bootBody.currentSeq + 1,
        eventKind: 'file.update',
        scopeFolderIds: [],
      });
      const pubMs = performance.now() - tPub0;
      expect(pubRes.skipped).toBe(false);
      expect(pubRes.recipientCount).toBeGreaterThanOrEqual(1);

      const tDelta0 = performance.now();
      const deltaRes = await app.fetch(
        new Request(`http://127.0.0.1:8787/api/sync/delta?sinceSeq=${bootBody.currentSeq}`, {
          headers: authHeaders('rt-owner', 'sys_admin'),
        }),
        testEnv
      );
      const deltaMs = performance.now() - tDelta0;
      expect(deltaRes.status).toBe(200);

      expect(bootMs).toBeLessThan(250);
      expect(pubMs).toBeLessThan(250);
      expect(deltaMs).toBeLessThan(250);
    } finally {
      await closeWsQuietly(ownerWs.ws);
    }
  });
});
