import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { runDailyMaintenance } from '../src/consumers/maintenance-cron';
import type { OidcEnv } from '../src/types/oidc';

function buildCronTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    STORAGE_MODE: 'local_proxy',
  } as OidcEnv;
}

describe('Daily Maintenance Cron (sessions, pending uploads, trash retention)', () => {
  const fixedNow = new Date('2026-11-15T03:00:00.000Z');
  const stale48hIso = '2026-11-13T02:00:00.000Z';
  const fresh2hIso = '2026-11-15T01:00:00.000Z';
  const expired10dIso = '2026-11-05T00:00:00.000Z';
  const recent3dIso = '2026-11-12T00:00:00.000Z';

  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-cron', 'Cron Corp', 'cron-corp')"
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_policies (tenant_id, trash_retention_days)
         VALUES ('tenant-cron', 7)`
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES ('cron-u1', 'tenant-cron', 'cron@example.com', 'Cron User', 'sys_admin', 'active')`
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes)
         VALUES ('tenant-cron', 'confidential', 2, 3000), ('tenant-cron', 'internal', 1, 500)`
      ),
    ]);
  });

  it('purges expired/revoked sessions, >24h pending uploads & R2 objects, and expired trash cleanly', async () => {
    // 1. Sessions: 1 expired, 1 revoked, 1 active valid
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (id, tenant_id, user_id, token_hash, expires_at, revoked_at)
         VALUES ('s-expired', 'tenant-cron', 'cron-u1', 'h-exp', ?, NULL)`
      ).bind(fresh2hIso),
      env.DB.prepare(
        `INSERT INTO sessions (id, tenant_id, user_id, token_hash, expires_at, revoked_at)
         VALUES ('s-revoked', 'tenant-cron', 'cron-u1', 'h-rev', '2099-01-01T00:00:00Z', ?)`
      ).bind(fresh2hIso),
      env.DB.prepare(
        `INSERT INTO sessions (id, tenant_id, user_id, token_hash, expires_at, revoked_at)
         VALUES ('s-valid', 'tenant-cron', 'cron-u1', 'h-val', '2099-01-01T00:00:00Z', NULL)`
      ),
    ]);

    // 2. R2 objects
    await env.BUCKET.put('tenant-cron/pending-old/v1', 'stale-bytes');
    await env.BUCKET.put('tenant-cron/pending-fresh/v1', 'fresh-bytes');
    await env.BUCKET.put('tenant-cron/active-with-orphan/v1', 'active-v1');
    await env.BUCKET.put('tenant-cron/active-with-orphan/v2', 'orphan-v2');
    await env.BUCKET.put('tenant-cron/trash-expired/v1', 'trash-old');
    await env.BUCKET.put('tenant-cron/trash-recent/v1', 'trash-new');

    // Folders: 1 expired trashed folder + 1 active root folder
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by, deleted_at)
         VALUES ('f-trash-folder', 'tenant-cron', NULL, 'Old Folder', 0, 1, 'confidential', 'cron-u1', ?)`
      ).bind(expired10dIso),
      env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES ('tenant-cron', 'f-trash-folder', 'f-trash-folder', 0)`
      ),
    ]);

    // Files & versions
    await env.DB.batch([
      // Stale pending file (>24h)
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, current_version_id, created_by, updated_by, created_at)
         VALUES ('file-pending-old', 'tenant-cron', NULL, 'stale.bin', 'application/octet-stream', 100, 'pending', 'ver-pending-old', 'cron-u1', 'cron-u1', ?)`
      ).bind(stale48hIso),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES ('ver-pending-old', 'tenant-cron', 'file-pending-old', 1, 'tenant-cron/pending-old/v1', 100, 'application/octet-stream', 'pending', 'cron-u1', ?)`
      ).bind(stale48hIso),

      // Recent pending file (<24h -> keep)
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, current_version_id, created_by, updated_by, created_at)
         VALUES ('file-pending-fresh', 'tenant-cron', NULL, 'fresh.bin', 'application/octet-stream', 200, 'pending', 'ver-pending-fresh', 'cron-u1', 'cron-u1', ?)`
      ).bind(fresh2hIso),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES ('ver-pending-fresh', 'tenant-cron', 'file-pending-fresh', 1, 'tenant-cron/pending-fresh/v1', 200, 'application/octet-stream', 'pending', 'cron-u1', ?)`
      ).bind(fresh2hIso),

      // Active file with 1 completed current version + 1 orphan pending replacement version (>24h)
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, classification, current_version_id, current_version_num, created_by, updated_by, created_at)
         VALUES ('file-active-orphan', 'tenant-cron', NULL, 'report.pdf', 'application/pdf', 500, 'active', 'internal', 'ver-active-v1', 1, 'cron-u1', 'cron-u1', ?)`
      ).bind(stale48hIso),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES ('ver-active-v1', 'tenant-cron', 'file-active-orphan', 1, 'tenant-cron/active-with-orphan/v1', 500, 'application/pdf', 'completed', 'cron-u1', ?)`
      ).bind(stale48hIso),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES ('ver-orphan-v2', 'tenant-cron', 'file-active-orphan', 2, 'tenant-cron/active-with-orphan/v2', 600, 'application/pdf', 'pending', 'cron-u1', ?)`
      ).bind(stale48hIso),

      // Expired trashed file (deleted 10d ago > 7d policy; inside expired folder)
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, classification, current_version_id, created_by, updated_by, deleted_at, created_at)
         VALUES ('file-trash-expired', 'tenant-cron', 'f-trash-folder', 'secret-old.pdf', 'application/pdf', 2000, 'active', 'confidential', 'ver-trash-exp', 'cron-u1', 'cron-u1', ?, ?)`
      ).bind(expired10dIso, expired10dIso),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES ('ver-trash-exp', 'tenant-cron', 'file-trash-expired', 1, 'tenant-cron/trash-expired/v1', 2000, 'application/pdf', 'completed', 'cron-u1', ?)`
      ).bind(expired10dIso),
      env.DB.prepare(
        `INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason)
         VALUES ('file-trash-expired', 'tenant-cron', 'confidential', 'secret-old.pdf', 'pdf', 'expired test')`
      ),
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES ('perm-trash-exp', 'tenant-cron', 'file', 'file-trash-expired', 'user', 'cron-u1', 'owner', 'cron-u1')`
      ),
      env.DB.prepare(
        `INSERT INTO shared_links (id, tenant_id, token_hash, target_type, target_id, created_by)
         VALUES ('sl-trash-exp', 'tenant-cron', 'sl-hash-exp', 'file', 'file-trash-expired', 'cron-u1')`
      ),

      // Recent trashed file (deleted 3d ago < 7d policy -> keep!)
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, classification, current_version_id, created_by, updated_by, deleted_at, created_at)
         VALUES ('file-trash-recent', 'tenant-cron', NULL, 'secret-recent.pdf', 'application/pdf', 1000, 'active', 'confidential', 'ver-trash-rec', 'cron-u1', 'cron-u1', ?, ?)`
      ).bind(recent3dIso, recent3dIso),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES ('ver-trash-rec', 'tenant-cron', 'file-trash-recent', 1, 'tenant-cron/trash-recent/v1', 1000, 'application/pdf', 'completed', 'cron-u1', ?)`
      ).bind(recent3dIso),
    ]);

    const summary = await runDailyMaintenance(buildCronTestEnv(), fixedNow);

    expect(summary.sessionsDeleted).toBe(2);
    expect(summary.pendingFilesDeleted).toBe(1);
    expect(summary.pendingVersionsDeleted).toBe(1);
    expect(summary.trashedFilesPurged).toBe(1);
    expect(summary.trashedFoldersPurged).toBe(1);

    // Valid session stays intact
    const validSess = await env.DB.prepare("SELECT id FROM sessions WHERE id = 's-valid'").first();
    expect(validSess).toBeTruthy();

    // Fresh pending & active file remain, stale pending & orphan version & expired trash are gone
    expect(await env.BUCKET.head('tenant-cron/pending-old/v1')).toBeNull();
    expect(await env.BUCKET.head('tenant-cron/pending-fresh/v1')).not.toBeNull();
    expect(await env.BUCKET.head('tenant-cron/active-with-orphan/v1')).not.toBeNull();
    expect(await env.BUCKET.head('tenant-cron/active-with-orphan/v2')).toBeNull();
    expect(await env.BUCKET.head('tenant-cron/trash-expired/v1')).toBeNull();
    expect(await env.BUCKET.head('tenant-cron/trash-recent/v1')).not.toBeNull();

    // Orphan FTS / permissions / shared_links / folder rows were cleaned up
    expect(
      await env.DB.prepare("SELECT file_id FROM files_fts WHERE file_id = 'file-trash-expired'").first()
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM permissions WHERE id = 'perm-trash-exp'").first()
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM shared_links WHERE id = 'sl-trash-exp'").first()
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM folders WHERE id = 'f-trash-folder'").first()
    ).toBeNull();

    // tenant_storage_stats confidential decremented from (2, 3000) -> (1, 1000), internal unchanged (1, 500)
    const confStats = await env.DB.prepare(
      "SELECT file_count, total_bytes FROM tenant_storage_stats WHERE tenant_id = 'tenant-cron' AND classification = 'confidential'"
    ).first<{ file_count: number; total_bytes: number }>();
    expect(confStats).toEqual({ file_count: 1, total_bytes: 1000 });

    const intStats = await env.DB.prepare(
      "SELECT file_count, total_bytes FROM tenant_storage_stats WHERE tenant_id = 'tenant-cron' AND classification = 'internal'"
    ).first<{ file_count: number; total_bytes: number }>();
    expect(intStats).toEqual({ file_count: 1, total_bytes: 500 });

    // Worker scheduled() handler runs cleanly
    const ctx = createExecutionContext();
    await expect(
      worker.scheduled?.(
        { cron: '0 3 * * *', scheduledTime: fixedNow.getTime(), noRetry: () => {} },
        buildCronTestEnv(),
        ctx
      )
    ).resolves.toBeUndefined();
    await waitOnExecutionContext(ctx);
  });

  it('preserves CoW-shared R2 objects until the last referencing file version is purged', async () => {
    const now = new Date('2026-06-15T03:00:00.000Z');
    const expired10dIso = new Date(now.getTime() - 10 * 86_400_000).toISOString();
    const freshIso = new Date(now.getTime() - 3_600_000).toISOString();
    const sharedKey = 'tenant-cron-cow/shared/v1';

    await env.BUCKET.put(sharedKey, 'shared-cow-payload');

    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES ('tenant-cron-cow', 'CoW Cron Org', 'cow-cron-org')"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id, trash_retention_days) VALUES ('tenant-cron-cow', 7)"
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status) VALUES ('cow-u1', 'tenant-cron-cow', 'cow-u1@example.com', 'CoW U1', 'sys_admin', 'active')"
      ),
      env.DB.prepare(
        "INSERT OR REPLACE INTO tenant_storage_stats (tenant_id, classification, file_count, total_bytes) VALUES ('tenant-cron-cow', 'internal', 2, 3072)"
      ),
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, classification, current_version_id, created_by, updated_by, deleted_at, created_at)
         VALUES ('file-cow-expired', 'tenant-cron-cow', NULL, 'orig.pdf', 'application/pdf', 1536, 'active', 'internal', 'ver-cow-exp', 'cow-u1', 'cow-u1', ?, ?)`
      ).bind(expired10dIso, expired10dIso),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES ('ver-cow-exp', 'tenant-cron-cow', 'file-cow-expired', 1, ?, 1536, 'application/pdf', 'completed', 'cow-u1', ?)`
      ).bind(sharedKey, expired10dIso),
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state, classification, current_version_id, created_by, updated_by, created_at)
         VALUES ('file-cow-active', 'tenant-cron-cow', NULL, 'copy.pdf', 'application/pdf', 1536, 'active', 'internal', 'ver-cow-act', 'cow-u1', 'cow-u1', ?)`
      ).bind(freshIso),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by, created_at)
         VALUES ('ver-cow-act', 'tenant-cron-cow', 'file-cow-active', 1, ?, 1536, 'application/pdf', 'completed', 'cow-u1', ?)`
      ).bind(sharedKey, freshIso),
    ]);

    // Purge 1: expired original removed from D1, but R2 object MUST stay because copy references it
    await runDailyMaintenance(buildCronTestEnv(), now);

    expect(
      await env.DB.prepare("SELECT id FROM files WHERE id = 'file-cow-expired'").first()
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM files WHERE id = 'file-cow-active'").first()
    ).toBeTruthy();
    expect(await env.BUCKET.head(sharedKey)).not.toBeNull();

    const midStats = await env.DB.prepare(
      "SELECT file_count, total_bytes FROM tenant_storage_stats WHERE tenant_id = 'tenant-cron-cow' AND classification = 'internal'"
    ).first<{ file_count: number; total_bytes: number }>();
    expect(midStats).toEqual({ file_count: 1, total_bytes: 1536 });

    // Purge 2: now expire the copy too -> zero references remain -> R2 object MUST be deleted
    await env.DB.prepare(
      "UPDATE files SET deleted_at = ? WHERE id = 'file-cow-active'"
    )
      .bind(expired10dIso)
      .run();

    await runDailyMaintenance(buildCronTestEnv(), now);

    expect(
      await env.DB.prepare("SELECT id FROM files WHERE id = 'file-cow-active'").first()
    ).toBeNull();
    expect(await env.BUCKET.head(sharedKey)).toBeNull();

    const endStats = await env.DB.prepare(
      "SELECT file_count, total_bytes FROM tenant_storage_stats WHERE tenant_id = 'tenant-cron-cow' AND classification = 'internal'"
    ).first<{ file_count: number; total_bytes: number }>();
    expect(endStats).toEqual({ file_count: 0, total_bytes: 0 });
  });
});
