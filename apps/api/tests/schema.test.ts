import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

describe('D1 schema & migrations (0001-0013)', () => {
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
    const [policyCols, policyRow, folderCols] = await Promise.all([
      env.DB.prepare('PRAGMA table_info(tenant_policies)').all<{ name: string }>(),
      env.DB.prepare(
        "SELECT folder_structure_mode, permission_inheritance_mode, invite_policy FROM tenant_policies WHERE tenant_id = 't1'"
      ).first<{
        folder_structure_mode: string;
        permission_inheritance_mode: string;
        invite_policy: string;
      }>(),
      env.DB.prepare('PRAGMA table_info(folders)').all<{ name: string }>(),
    ]);
    expect(policyCols.results.map((column) => column.name)).toContain(
      'folder_structure_mode'
    );
    // Migration 0009: permission inheritance mode (default additive).
    expect(policyCols.results.map((column) => column.name)).toContain(
      'permission_inheritance_mode'
    );
    // Migration 0010: invite policy (tenant default owners, folder nullable).
    expect(policyCols.results.map((column) => column.name)).toContain(
      'invite_policy'
    );
    expect(folderCols.results.map((column) => column.name)).toContain(
      'invite_policy'
    );
    expect(policyRow?.folder_structure_mode).toBe('open');
    expect(policyRow?.permission_inheritance_mode).toBe('additive');
    expect(policyRow?.invite_policy).toBe('owners');
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET folder_structure_mode = 'invalid' WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET permission_inheritance_mode = 'invalid' WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET invite_policy = 'invalid' WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE folders SET invite_policy = 'invalid' WHERE id = 'fld1'"
      ).run()
    ).rejects.toThrow();

    // Migration 0011: shared-link permission levels, edit policies and the
    // single-use preview stream nonce table.
    const [sharedLinkCols, policyCols0011, previewTable, previewIndex] =
      await Promise.all([
        env.DB.prepare('PRAGMA table_info(shared_links)').all<{ name: string }>(),
        env.DB.prepare('PRAGMA table_info(tenant_policies)').all<{ name: string }>(),
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preview_stream_tokens'"
        ).first<{ name: string }>(),
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_preview_stream_tokens_expires'"
        ).first<{ name: string }>(),
      ]);
    expect(sharedLinkCols.results.map((c) => c.name)).toContain(
      'permission_level'
    );
    const policyNames = policyCols0011.results.map((c) => c.name);
    expect(policyNames).toContain('allow_shared_link_edit');
    expect(policyNames).toContain('allow_public_edit_links');
    expect(policyNames).toContain('allow_viewer_share_links');
    expect(previewTable?.name).toBe('preview_stream_tokens');
    expect(previewIndex?.name).toBe('idx_preview_stream_tokens_expires');

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, created_by
         ) VALUES ('sl-legacy-view', 't1', 'hash-legacy-view', 'file', 'f1',
                   'company_only', 0, 'u1')`
      ),
      env.DB.prepare(
        `INSERT INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, created_by
         ) VALUES ('sl-legacy-download', 't1', 'hash-legacy-download', 'file', 'f1',
                   'company_only', 1, 'u1')`
      ),
    ]);
    const defaultLevel = await env.DB.prepare(
      "SELECT permission_level FROM shared_links WHERE id = 'sl-legacy-view'"
    ).first<{ permission_level: string }>();
    expect(defaultLevel?.permission_level).toBe('download');
    await env.DB.prepare(
      `UPDATE shared_links
          SET permission_level = CASE WHEN can_download = 0 THEN 'view' ELSE 'download' END`
    ).run();
    const backfilled = await env.DB.prepare(
      "SELECT id, permission_level FROM shared_links WHERE id LIKE 'sl-legacy-%' ORDER BY id"
    ).all<{ id: string; permission_level: string }>();
    expect(backfilled.results).toEqual([
      { id: 'sl-legacy-download', permission_level: 'download' },
      { id: 'sl-legacy-view', permission_level: 'view' },
    ]);
    await expect(
      env.DB.prepare(
        "UPDATE shared_links SET permission_level = 'share' WHERE id = 'sl-legacy-view'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET allow_shared_link_edit = 2 WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();

    // Migration 0012: durable admin bulk-operation idempotency.
    const [idempotencyCols, idempotencyTable, idempotencyIndex] =
      await Promise.all([
        env.DB.prepare(
          'PRAGMA table_info(admin_bulk_idempotency)'
        ).all<{ name: string; pk: number }>(),
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_bulk_idempotency'"
        ).first<{ name: string }>(),
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_admin_bulk_idempotency_operation'"
        ).first<{ name: string }>(),
      ]);
    expect(idempotencyTable?.name).toBe('admin_bulk_idempotency');
    expect(idempotencyIndex?.name).toBe(
      'idx_admin_bulk_idempotency_operation'
    );
    expect(idempotencyCols.results.map((c) => c.name)).toEqual([
      'tenant_id',
      'operation',
      'idempotency_key',
      'request_hash',
      'status',
      'response_json',
      'created_at',
      'updated_at',
    ]);
    expect(
      idempotencyCols.results
        .filter((c) => c.pk > 0)
        .map((c) => c.name)
        .sort()
    ).toEqual(['idempotency_key', 'tenant_id']);

    await env.DB.prepare(
      `INSERT INTO admin_bulk_idempotency (
         tenant_id, operation, idempotency_key, request_hash, status,
         response_json
       ) VALUES ('t1', 'admin.permission.bulk_grant', 'schema-key', 'hash',
                 'completed', '{"ok":true}')`
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO admin_bulk_idempotency (
           tenant_id, operation, idempotency_key, request_hash, status
         ) VALUES ('t1', 'admin.permission.bulk_grant', 'schema-bad', 'hash',
                   'unknown')`
      ).run()
    ).rejects.toThrow();

    // Migration 0013: external guest accounts, invitations, OTP challenges,
    // dev mail sink and the five tenant guest policies.
    const [userCols0013, policyCols0013, guestTables] = await Promise.all([
      env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>(),
      env.DB.prepare('PRAGMA table_info(tenant_policies)').all<{ name: string }>(),
      env.DB.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN ('guest_invitations', 'guest_otp_challenges', 'guest_mail_sink')
          ORDER BY name`
      ).all<{ name: string }>(),
    ]);
    const userColumnNames = userCols0013.results.map((c) => c.name);
    expect(userColumnNames).toEqual(
      expect.arrayContaining([
        'user_type',
        'external_org',
        'invited_by',
        'expires_at',
        'last_login_at',
      ])
    );
    const guestPolicyColumns = policyCols0013.results.map((c) => c.name);
    expect(guestPolicyColumns).toEqual(
      expect.arrayContaining([
        'allow_external_collaborators',
        'external_domain_allowlist_json',
        'guest_invitation_expiry_days',
        'guest_session_max_hours',
        'allow_guest_elevated_roles',
      ])
    );
    expect(guestTables.results.map((t) => t.name)).toEqual([
      'guest_invitations',
      'guest_mail_sink',
      'guest_otp_challenges',
    ]);

    const guestPolicyDefaults = await env.DB.prepare(
      `SELECT allow_external_collaborators,
              external_domain_allowlist_json,
              guest_invitation_expiry_days,
              guest_session_max_hours,
              allow_guest_elevated_roles
         FROM tenant_policies WHERE tenant_id = 't1'`
    ).first<{
      allow_external_collaborators: number;
      external_domain_allowlist_json: string;
      guest_invitation_expiry_days: number;
      guest_session_max_hours: number;
      allow_guest_elevated_roles: number;
    }>();
    expect(guestPolicyDefaults).toEqual({
      allow_external_collaborators: 0,
      external_domain_allowlist_json: '[]',
      guest_invitation_expiry_days: 14,
      guest_session_max_hours: 24,
      allow_guest_elevated_roles: 0,
    });

    const defaultUserType = await env.DB.prepare(
      "SELECT user_type FROM users WHERE id = 'u1'"
    ).first<{ user_type: string }>();
    expect(defaultUserType?.user_type).toBe('member');

    await env.DB.prepare(
      `INSERT INTO users (id, tenant_id, email, display_name, role, user_type, expires_at)
       VALUES ('guest-u1', 't1', 'guest@partner.example', 'Guest', 'member', 'guest',
               '2026-12-31T00:00:00.000Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO guest_invitations (
         id, tenant_id, user_id, email, display_name, invited_by, token_hash,
         target_type, target_id, role, status, expires_at, created_at, updated_at
       ) VALUES ('gi-1', 't1', 'guest-u1', 'guest@partner.example', 'Guest', 'u1',
                 'hash-gi-1', 'folder', 'fld1', 'viewer', 'pending',
                 '2026-12-31T00:00:00.000Z', '2026-11-17T00:00:00.000Z',
                 '2026-11-17T00:00:00.000Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO guest_otp_challenges (
         id, tenant_id, user_id, email, otp_hash, purpose, expires_at, created_at
       ) VALUES ('otp-1', 't1', 'guest-u1', 'guest@partner.example', 'hash',
                 'login', '2026-12-31T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`
    ).run();

    await expect(
      env.DB.prepare(
        "UPDATE users SET user_type = 'admin' WHERE id = 'guest-u1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE guest_invitations SET role = 'owner' WHERE id = 'gi-1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE guest_invitations SET status = 'unknown' WHERE id = 'gi-1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE guest_otp_challenges SET purpose = 'other' WHERE id = 'otp-1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET guest_session_max_hours = 169 WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
  });
});
