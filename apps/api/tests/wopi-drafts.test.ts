import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { runDailyMaintenance } from '../src/consumers/maintenance-cron';
import {
  finalizeWopiDraft,
  purgeExpiredWopiDrafts,
  saveWopiDraft,
} from '../src/services/wopi-drafts';
import {
  verifyWopiSessionToken,
  type WopiSessionRow,
} from '../src/services/wopi-token';
import type { OidcEnv } from '../src/types/oidc';

const TENANT_ID = 'tenant-wopi';
const EDITOR_ID = 'wopi-editor';
const VIEWER_ID = 'wopi-viewer';
const PREVIEWER_ID = 'wopi-previewer';
const OUTSIDER_ID = 'wopi-outsider';
const FILE_ID = 'wopi-file-1';
const ROUTE_FILE_ID = 'wopi-file-route';
const DELETED_FILE_ID = 'wopi-file-deleted';
const NO_CONTENT_FILE_ID = 'wopi-file-no-content';
const INITIAL_KEY = `tenants/${TENANT_ID}/objects/${FILE_ID}/v1`;
const ROUTE_INITIAL_KEY = `tenants/${TENANT_ID}/objects/${ROUTE_FILE_ID}/v1`;
const INITIAL_BYTES = 100;

function authHeaders(userId = EDITOR_ID): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': 'member',
    'X-Dev-Tenant-Id': TENANT_ID,
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
    LOCAL_PROXY_SECRET: 'wopi-test-secret',
    WOPI_TOKEN_SECRET: 'wopi-token-test-secret',
    // Keep unit tests independent of a developer's local .dev.vars, which may
    // point at a Collabora instance and enable local .docx seeding.
    COLLABORA_URL: undefined,
    JOBS_QUEUE: { send: async () => {} } as unknown as Queue,
    ...overrides,
  } as OidcEnv;
}

async function createSession(
  testEnv: OidcEnv,
  userId = EDITOR_ID,
  fileId = FILE_ID
): Promise<{
  sessionId: string;
  accessToken: string;
  canWrite: boolean;
  readOnly: boolean;
  readOnlyReason: 'desktop_lock' | 'dlp' | 'permission' | null;
}> {
  const res = await app.fetch(
    new Request(`http://127.0.0.1:8787/api/files/${fileId}/wopi-session`, {
      method: 'POST',
      headers: authHeaders(userId),
    }),
    testEnv
  );
  expect(res.status).toBe(201);
  return (await res.json()) as {
    sessionId: string;
    accessToken: string;
    canWrite: boolean;
    readOnly: boolean;
    readOnlyReason: 'desktop_lock' | 'dlp' | 'permission' | null;
  };
}

async function wopiHostRequest(
  testEnv: OidcEnv,
  fileId: string,
  token: string,
  init: RequestInit = {},
  suffix = ''
): Promise<Response> {
  return await app.fetch(
    new Request(
      `http://127.0.0.1:8787/wopi/files/${fileId}${suffix}?access_token=${encodeURIComponent(token)}`,
      init
    ),
    testEnv
  );
}

async function loadSession(
  testEnv: OidcEnv,
  sessionId: string
): Promise<WopiSessionRow> {
  const row = await testEnv.DB.prepare(
    'SELECT * FROM wopi_sessions WHERE id = ?'
  )
    .bind(sessionId)
    .first<WopiSessionRow>();
  expect(row).toBeTruthy();
  return row!;
}

describe('WOPI sessions, draft autosave and version finalization', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug, storage_quota_bytes)
         VALUES (?, 'WOPI Org', 'wopi-org', 5000000)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)`
      ).bind(TENANT_ID),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           (?, ?, 'editor@example.com', 'Editor', 'member', 'active'),
           (?, ?, 'viewer@example.com', 'Viewer', 'member', 'active'),
           (?, ?, 'previewer@example.com', 'Previewer', 'member', 'active'),
           (?, ?, 'outsider@example.com', 'Outsider', 'member', 'active')`
      ).bind(
        EDITOR_ID,
        TENANT_ID,
        VIEWER_ID,
        TENANT_ID,
        PREVIEWER_ID,
        TENANT_ID,
        OUTSIDER_ID,
        TENANT_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_id, current_version_num, classification,
           created_by, updated_by, deleted_at
         ) VALUES
           (?, ?, NULL, 'collab.docx', 'docx',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             ?, 'active', 'wopi-v1', 1, 'internal', ?, ?, NULL),
           (?, ?, NULL, 'route.docx', 'docx',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             ?, 'active', 'wopi-route-v1', 1, 'internal', ?, ?, NULL),
           (?, ?, NULL, 'trashed.docx', 'docx',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             50, 'active', NULL, 1, 'internal', ?, ?, '2026-01-01T00:00:00.000Z'),
           (?, ?, NULL, 'no-content.docx', 'docx',
             'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
             50, 'active', 'missing-version', 1, 'internal', ?, ?, NULL)`
      ).bind(
        FILE_ID,
        TENANT_ID,
        INITIAL_BYTES,
        EDITOR_ID,
        EDITOR_ID,
        ROUTE_FILE_ID,
        TENANT_ID,
        INITIAL_BYTES,
        EDITOR_ID,
        EDITOR_ID,
        DELETED_FILE_ID,
        TENANT_ID,
        EDITOR_ID,
        EDITOR_ID,
        NO_CONTENT_FILE_ID,
        TENANT_ID,
        EDITOR_ID,
        EDITOR_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_versions (
           id, tenant_id, file_id, version_num, r2_object_key, size_bytes,
           mime_type, upload_status, uploaded_by
         ) VALUES
           ('wopi-v1', ?, ?, 1, ?, ?, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'completed', ?),
           ('wopi-route-v1', ?, ?, 1, ?, ?, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'completed', ?)`
      ).bind(
        TENANT_ID,
        FILE_ID,
        INITIAL_KEY,
        INITIAL_BYTES,
        EDITOR_ID,
        TENANT_ID,
        ROUTE_FILE_ID,
        ROUTE_INITIAL_KEY,
        INITIAL_BYTES,
        EDITOR_ID
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by
         ) VALUES
           ('wopi-perm-editor', ?, 'file', ?, 'user', ?, 'editor', ?),
           ('wopi-perm-viewer', ?, 'file', ?, 'user', ?, 'viewer', ?),
           ('wopi-perm-previewer', ?, 'file', ?, 'user', ?, 'previewer', ?),
           ('wopi-perm-deleted', ?, 'file', ?, 'user', ?, 'editor', ?),
           ('wopi-perm-no-content', ?, 'file', ?, 'user', ?, 'editor', ?),
           ('wopi-perm-route', ?, 'file', ?, 'user', ?, 'editor', ?)`
      ).bind(
        TENANT_ID,
        FILE_ID,
        EDITOR_ID,
        EDITOR_ID,
        TENANT_ID,
        FILE_ID,
        VIEWER_ID,
        EDITOR_ID,
        TENANT_ID,
        FILE_ID,
        PREVIEWER_ID,
        EDITOR_ID,
        TENANT_ID,
        DELETED_FILE_ID,
        EDITOR_ID,
        EDITOR_ID,
        TENANT_ID,
        NO_CONTENT_FILE_ID,
        EDITOR_ID,
        EDITOR_ID,
        TENANT_ID,
        ROUTE_FILE_ID,
        EDITOR_ID,
        EDITOR_ID
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (
           tenant_id, classification, file_count, total_bytes
         ) VALUES (?, 'internal', 1, ?)`
      ).bind(TENANT_ID, INITIAL_BYTES),
    ]);
    await env.BUCKET.put(INITIAL_KEY, 'initial-document');
    await env.BUCKET.put(ROUTE_INITIAL_KEY, 'route-initial-document');
  });

  it('issues read/write tokens by RBAC and rejects outsiders and trashed files', async () => {
    const testEnv = buildTestEnv();

    const editor = await createSession(testEnv, EDITOR_ID);
    expect(editor.canWrite).toBe(true);
    expect(editor.readOnly).toBe(false);
    expect(editor.readOnlyReason).toBeNull();
    expect(editor.accessToken.startsWith('v1.')).toBe(true);

    const viewer = await createSession(testEnv, VIEWER_ID);
    expect(viewer.canWrite).toBe(false);
    expect(viewer.readOnly).toBe(true);
    expect(viewer.readOnlyReason).toBe('permission');

    const previewer = await createSession(testEnv, PREVIEWER_ID);
    expect(previewer.canWrite).toBe(false);
    expect(previewer.readOnly).toBe(true);
    expect(previewer.readOnlyReason).toBe('dlp');

    const outsider = await app.fetch(
      new Request(`http://127.0.0.1:8787/api/files/${FILE_ID}/wopi-session`, {
        method: 'POST',
        headers: authHeaders(OUTSIDER_ID),
      }),
      testEnv
    );
    expect(outsider.status).toBe(403);

    const trashed = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${DELETED_FILE_ID}/wopi-session`,
        { method: 'POST', headers: authHeaders() }
      ),
      testEnv
    );
    expect(trashed.status).toBe(404);

    const verified = await verifyWopiSessionToken(
      testEnv.DB,
      testEnv,
      editor.accessToken
    );
    expect(verified?.session.id).toBe(editor.sessionId);
    expect(
      await verifyWopiSessionToken(
        testEnv.DB,
        testEnv,
        `${editor.accessToken.slice(0, -2)}xx`
      )
    ).toBeNull();
  });

  it('rejects WOPI sessions for files whose current version has no stored content', async () => {
    const testEnv = buildTestEnv();
    const res = await app.fetch(
      new Request(
        `http://127.0.0.1:8787/api/files/${NO_CONTENT_FILE_ID}/wopi-session`,
        { method: 'POST', headers: authHeaders() }
      ),
      testEnv
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('WOPI_CONTENT_NOT_FOUND');
  });

  it('keeps 10 autosaves out of file_versions and finalizes exactly one version on unlock', async () => {
    const testEnv = buildTestEnv();
    const issued = await createSession(testEnv, EDITOR_ID);
    const session = await loadSession(testEnv, issued.sessionId);

    let previousKey: string | null = null;
    let lastDraftKey = '';
    for (let i = 1; i <= 12; i += 1) {
      const content = new TextEncoder().encode(`draft-${i}`).buffer as ArrayBuffer;
      const saved = await saveWopiDraft({
        env: testEnv,
        session,
        content,
        mimeType: session.role === 'editor' ? 'application/msword' : 'text/plain',
      });
      expect(saved.draft.is_active).toBe(1);
      previousKey = saved.previousObjectKey;
      lastDraftKey = saved.draft.r2_object_key;
      if (previousKey) {
        await testEnv.BUCKET.delete(previousKey);
      }
    }

    const beforeFinalize = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM file_versions WHERE tenant_id = ? AND file_id = ?'
    )
      .bind(TENANT_ID, FILE_ID)
      .first<{ cnt: number }>();
    expect(beforeFinalize?.cnt).toBe(1);

    const activeDraft = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM wopi_drafts
        WHERE tenant_id = ? AND file_id = ? AND is_active = 1`
    )
      .bind(TENANT_ID, FILE_ID)
      .first<{ cnt: number }>();
    expect(activeDraft?.cnt).toBe(1);

    const finalized = await finalizeWopiDraft({
      env: testEnv,
      session,
      actor: {
        id: EDITOR_ID,
        email: 'editor@example.com',
        ipAddress: '127.0.0.1',
      },
    });
    expect(finalized).not.toBeNull();
    expect(finalized?.version.version_num).toBe(2);
    expect(finalized?.file.current_version_num).toBe(2);
    expect(finalized?.file.size_bytes).toBe('draft-12'.length);
    expect(finalized?.version.r2_object_key).toBe(lastDraftKey);

    const afterFinalize = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM file_versions WHERE tenant_id = ? AND file_id = ?'
    )
      .bind(TENANT_ID, FILE_ID)
      .first<{ cnt: number }>();
    expect(afterFinalize?.cnt).toBe(2);

    const promoted = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM wopi_drafts
        WHERE tenant_id = ? AND file_id = ? AND promoted_version_id = ?`
    )
      .bind(TENANT_ID, FILE_ID, finalized!.version.id)
      .first<{ cnt: number }>();
    expect(promoted?.cnt).toBe(1);

    const stats = await testEnv.DB.prepare(
      `SELECT file_count, total_bytes FROM tenant_storage_stats
        WHERE tenant_id = ? AND classification = 'internal'`
    )
      .bind(TENANT_ID)
      .first<{ file_count: number; total_bytes: number }>();
    expect(stats?.file_count).toBe(1);
    expect(stats?.total_bytes).toBe('draft-12'.length);

    // The promoted draft key is referenced by file_versions and must survive purge.
    await testEnv.DB.prepare(
      `UPDATE wopi_drafts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`
    )
      .bind(finalized!.draft.id)
      .run();
    const purge = await purgeExpiredWopiDrafts(testEnv, Date.now());
    expect(purge.draftsPurged).toBe(0);
    expect(await testEnv.BUCKET.head(lastDraftKey)).not.toBeNull();
  });

  it('purges abandoned drafts and their unreferenced R2 objects', async () => {
    const testEnv = buildTestEnv();
    const issued = await createSession(testEnv, EDITOR_ID);
    const session = await loadSession(testEnv, issued.sessionId);
    const saved = await saveWopiDraft({
      env: testEnv,
      session,
      content: new TextEncoder().encode('abandoned').buffer as ArrayBuffer,
      mimeType: 'application/msword',
    });

    await testEnv.DB.prepare(
      `UPDATE wopi_drafts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`
    )
      .bind(saved.draft.id)
      .run();

    const purge = await purgeExpiredWopiDrafts(testEnv, Date.now());
    expect(purge.draftsPurged).toBe(1);
    expect(await testEnv.BUCKET.head(saved.draft.r2_object_key)).toBeNull();
  });

  it('routes 12 autosaves through PutFile, finalizes on UNLOCK, and keeps the promoted R2 object after purge', async () => {
    const testEnv = buildTestEnv();
    const issued = await createSession(testEnv, EDITOR_ID, ROUTE_FILE_ID);
    const token = issued.accessToken;

    const locked = await wopiHostRequest(testEnv, ROUTE_FILE_ID, token, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'LOCK', 'X-WOPI-Lock': 'route-lock' },
    });
    expect(locked.status).toBe(200);

    for (let i = 1; i <= 12; i += 1) {
      const put = await wopiHostRequest(
        testEnv,
        ROUTE_FILE_ID,
        token,
        {
          method: 'POST',
          headers: { 'X-WOPI-Lock': 'route-lock' },
          body: `route-draft-${i}`,
        },
        '/contents'
      );
      expect(put.status).toBe(200);
    }

    const beforeUnlock = await testEnv.DB.prepare(
      'SELECT size_bytes, current_version_num FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, ROUTE_FILE_ID)
      .first<{ size_bytes: number; current_version_num: number }>();
    expect(beforeUnlock?.current_version_num).toBe(1);
    expect(beforeUnlock?.size_bytes).toBe(INITIAL_BYTES);

    const activeDraft = await testEnv.DB.prepare(
      `SELECT * FROM wopi_drafts
        WHERE tenant_id = ? AND file_id = ? AND is_active = 1
        ORDER BY updated_at DESC LIMIT 1`
    )
      .bind(TENANT_ID, ROUTE_FILE_ID)
      .first<{
        id: string;
        r2_object_key: string;
        size_bytes: number;
      }>();
    expect(activeDraft?.size_bytes).toBe('route-draft-12'.length);

    const unlocked = await wopiHostRequest(testEnv, ROUTE_FILE_ID, token, {
      method: 'POST',
      headers: { 'X-WOPI-Override': 'UNLOCK', 'X-WOPI-Lock': 'route-lock' },
    });
    expect(unlocked.status).toBe(200);

    const detail = await testEnv.DB.prepare(
      'SELECT size_bytes, current_version_num, current_version_id FROM files WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, ROUTE_FILE_ID)
      .first<{
        size_bytes: number;
        current_version_num: number;
        current_version_id: string;
      }>();
    expect(detail?.current_version_num).toBe(2);
    expect(detail?.size_bytes).toBe('route-draft-12'.length);

    const promoted = await testEnv.DB.prepare(
      `SELECT * FROM wopi_drafts
        WHERE tenant_id = ? AND file_id = ? AND promoted_version_id = ?
        LIMIT 1`
    )
      .bind(TENANT_ID, ROUTE_FILE_ID, detail!.current_version_id)
      .first<{
        id: string;
        r2_object_key: string;
        promoted_at: string | null;
      }>();
    expect(promoted).toBeTruthy();
    expect(promoted!.promoted_at).not.toBeNull();
    expect(await testEnv.BUCKET.head(promoted!.r2_object_key)).not.toBeNull();

    const getFile = await wopiHostRequest(
      testEnv,
      ROUTE_FILE_ID,
      token,
      {},
      '/contents'
    );
    expect(new TextDecoder().decode(await getFile.arrayBuffer())).toBe(
      'route-draft-12'
    );

    await testEnv.DB.prepare(
      `UPDATE wopi_drafts SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`
    )
      .bind(promoted!.id)
      .run();
    const cronSummary = await runDailyMaintenance(testEnv);
    expect(cronSummary.wopiDraftsPurged).toBe(0);
    expect(await testEnv.BUCKET.head(promoted!.r2_object_key)).not.toBeNull();

    const versionRow = await testEnv.DB.prepare(
      'SELECT r2_object_key FROM file_versions WHERE tenant_id = ? AND id = ?'
    )
      .bind(TENANT_ID, detail!.current_version_id)
      .first<{ r2_object_key: string }>();
    expect(versionRow?.r2_object_key).toBe(promoted!.r2_object_key);
  });

  it('rejects draft persistence for a previewer read-only session', async () => {
    const testEnv = buildTestEnv();
    const previewer = await createSession(testEnv, PREVIEWER_ID);
    const session = await loadSession(testEnv, previewer.sessionId);
    await expect(
      saveWopiDraft({
        env: testEnv,
        session,
        content: new TextEncoder().encode('previewer-write').buffer as ArrayBuffer,
        mimeType: 'application/msword',
      })
    ).rejects.toThrow('WOPI session is read-only');

    const drafts = await testEnv.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM wopi_drafts WHERE tenant_id = ? AND session_id = ?'
    )
      .bind(TENANT_ID, previewer.sessionId)
      .first<{ cnt: number }>();
    expect(drafts?.cnt).toBe(0);
  });
});
