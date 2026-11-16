import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

describe('D1 schema & migrations (0001 + 0002 + 0003)', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it('applies 0001, 0002, and 0003 migrations including meta_version and sync_changes', async () => {
    const [versionCols, fileCols, tables] = await Promise.all([
      env.DB.prepare('PRAGMA table_info(file_versions)').all<{ name: string }>(),
      env.DB.prepare('PRAGMA table_info(files)').all<{ name: string }>(),
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sync_changes', 'tenant_sync_horizons')"
      ).all<{ name: string }>(),
    ]);
    expect(versionCols.results.map((c) => c.name)).toContain('r2_upload_id');
    expect(fileCols.results.map((c) => c.name)).toContain('meta_version');
    expect(tables.results.map((t) => t.name).sort()).toEqual([
      'sync_changes',
      'tenant_sync_horizons',
    ]);

    await env.DB.batch([
      env.DB.prepare("INSERT INTO tenants (id, name, slug) VALUES ('t1', 'Tenant 1', 't1')"),
      env.DB.prepare("INSERT INTO tenant_policies (tenant_id) VALUES ('t1')"),
      env.DB.prepare(
        "INSERT INTO users (id, tenant_id, email, display_name, role) VALUES ('u1', 't1', 'u1@example.com', 'U1', 'sys_admin')"
      ),
      env.DB.prepare(
        "INSERT INTO folders (id, tenant_id, name, depth, version, classification, created_by) VALUES ('fld1', 't1', 'Sec', 0, 1, 'confidential', 'u1')"
      ),
      env.DB.prepare(
        "INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by) VALUES ('f1', 't1', 'fld1', 'NDA_2026.pdf', 'pdf', 'application/pdf', 2048, 'active', 'confidential', 'u1', 'u1')"
      ),
      env.DB.prepare(
        "INSERT INTO files (id, tenant_id, folder_id, name, extension, mime_type, size_bytes, upload_state, classification, created_by, updated_by) VALUES ('f2', 't1', 'fld1', 'NDA_2026.pdf', 'pdf', 'application/pdf', 4096, 'pending', 'confidential', 'u1', 'u1')"
      ),
      env.DB.prepare(
        "INSERT INTO files_fts (file_id, tenant_id, classification, name, extension, ai_reason) VALUES ('f1', 't1', 'confidential', 'NDA_2026.pdf', 'pdf', 'Confidential agreement')"
      ),
    ]);

    // Partial index excludes pending upload from active listing and allows duplicate pending names
    const activeFiles = await env.DB.prepare(
      "SELECT id FROM files WHERE tenant_id = 't1' AND folder_id = 'fld1' AND deleted_at IS NULL AND upload_state = 'active'"
    ).all<{ id: string }>();
    expect(activeFiles.results.map((r) => r.id)).toEqual(['f1']);

    // FTS5 search hits confidential + token prefix
    const ftsHit = await env.DB.prepare(
      "SELECT file_id FROM files_fts WHERE files_fts MATCH 'classification : confidential AND nda*'"
    ).all<{ file_id: string }>();
    expect(ftsHit.results.map((r) => r.file_id)).toEqual(['f1']);

    // Folder depth > 20 constraint check
    await expect(
      env.DB.prepare(
        "INSERT INTO folders (id, tenant_id, parent_id, name, depth, created_by) VALUES ('fld-deep', 't1', 'fld1', 'TooDeep', 21, 'u1')"
      ).run()
    ).rejects.toThrow();

    // Migration 0004: workspace_jobs, non-unique r2_object_key + index for CoW copy
    const [jobsTable, r2Idx] = await Promise.all([
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_jobs'"
      ).first<{ name: string }>(),
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_file_versions_r2_key'"
      ).first<{ name: string }>(),
    ]);
    expect(jobsTable?.name).toBe('workspace_jobs');
    expect(r2Idx?.name).toBe('idx_file_versions_r2_key');

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by)
         VALUES ('fv-cow-1', 't1', 'f1', 1, 'tenants/t1/objects/shared-cow-v1', 2048, 'application/pdf', 'completed', 'u1')`
      ),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key, size_bytes, mime_type, upload_status, uploaded_by)
         VALUES ('fv-cow-2', 't1', 'f2', 1, 'tenants/t1/objects/shared-cow-v1', 2048, 'application/pdf', 'completed', 'u1')`
      ),
    ]);

    const sharedRefCount = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM file_versions WHERE r2_object_key = 'tenants/t1/objects/shared-cow-v1'"
    ).first<{ cnt: number }>();
    expect(sharedRefCount?.cnt).toBe(2);

    // Migration 0008: open / closed folder structure mode (default open).
    const [policyCols, policyRow] = await Promise.all([
      env.DB.prepare('PRAGMA table_info(tenant_policies)').all<{ name: string }>(),
      env.DB.prepare(
        "SELECT folder_structure_mode FROM tenant_policies WHERE tenant_id = 't1'"
      ).first<{ folder_structure_mode: string }>(),
    ]);
    expect(policyCols.results.map((column) => column.name)).toContain(
      'folder_structure_mode'
    );
    expect(policyRow?.folder_structure_mode).toBe('open');
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET folder_structure_mode = 'invalid' WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
  });
});
