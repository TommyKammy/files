import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

describe('D1 schema & migrations (0001-0023)', () => {
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

    // Migration 0014: guest lifecycle governance. Offboarding is a logical
    // deactivation so existing `REFERENCES users(id)` foreign keys stay valid.
    const [userCols0014, policyCols0014, offboardIndex] = await Promise.all([
      env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>(),
      env.DB.prepare('PRAGMA table_info(tenant_policies)').all<{ name: string }>(),
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_guest_offboarded'"
      ).first<{ name: string }>(),
    ]);
    expect(userCols0014.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'offboarded_at',
        'offboarded_by',
        'expiring_notified_at',
      ])
    );
    expect(policyCols0014.results.map((column) => column.name)).toContain(
      'external_domain_existing_guest_mode'
    );
    expect(offboardIndex?.name).toBe('idx_users_guest_offboarded');

    const lifecycleDefaults = await env.DB.prepare(
      `SELECT external_domain_existing_guest_mode
         FROM tenant_policies WHERE tenant_id = 't1'`
    ).first<{ external_domain_existing_guest_mode: string }>();
    expect(lifecycleDefaults?.external_domain_existing_guest_mode).toBe(
      'reject_new_only'
    );
    await env.DB.prepare(
      "UPDATE tenant_policies SET external_domain_existing_guest_mode = 'suspend_existing' WHERE tenant_id = 't1'"
    ).run();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET external_domain_existing_guest_mode = 'delete_everything' WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare(
      "UPDATE tenant_policies SET external_domain_existing_guest_mode = 'reject_new_only' WHERE tenant_id = 't1'"
    ).run();

    // Offboarding markers are nullable and do not disturb existing guest rows.
    const offboardedGuest = await env.DB.prepare(
      "SELECT offboarded_at, expiring_notified_at FROM users WHERE id = 'guest-u1'"
    ).first<{
      offboarded_at: string | null;
      expiring_notified_at: string | null;
    }>();
    expect(offboardedGuest).toEqual({
      offboarded_at: null,
      expiring_notified_at: null,
    });

    // Migration 0015: internal member administration, personal storage quotas
    // and the O(1) per-user storage counter. `last_login_at` must not be
    // re-added by this migration.
    const [userCols0015, memberIndex, userStatsTable, userStatsCols] =
      await Promise.all([
        env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>(),
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_tenant_member_status'"
        ).first<{ name: string }>(),
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_storage_stats'"
        ).first<{ name: string }>(),
        env.DB.prepare('PRAGMA table_info(user_storage_stats)').all<{
          name: string;
          pk: number;
        }>(),
      ]);
    expect(userCols0015.results.map((column) => column.name)).toContain(
      'storage_quota_bytes'
    );
    expect(memberIndex?.name).toBe('idx_users_tenant_member_status');
    expect(userStatsTable?.name).toBe('user_storage_stats');
    expect(userStatsCols.results.map((column) => column.name)).toEqual([
      'tenant_id',
      'user_id',
      'file_count',
      'total_bytes',
      'updated_at',
    ]);
    expect(
      userStatsCols.results
        .filter((column) => column.pk > 0)
        .map((column) => column.name)
        .sort()
    ).toEqual(['tenant_id', 'user_id']);

    await expect(
      env.DB.prepare(
        "UPDATE users SET storage_quota_bytes = 0 WHERE id = 'u1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO user_storage_stats (tenant_id, user_id, file_count, total_bytes)
         VALUES ('t1', 'u1', -1, 0)`
      ).run()
    ).rejects.toThrow();

    // Migration 0016: admin content manager indexes, inspection policy and the
    // FileLockHub search shadow table.
    const [
      contentIndexes,
      policyCols0016,
      inspectPolicyRow,
      lockTable,
      lockCols,
      lockIndex,
    ] = await Promise.all([
      env.DB.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_files_active_recent',
              'idx_files_active_creator',
              'idx_folders_active_recent',
              'idx_shared_links_tenant_active'
            )
          ORDER BY name`
      ).all<{ name: string }>(),
      env.DB.prepare('PRAGMA table_info(tenant_policies)').all<{ name: string }>(),
      env.DB.prepare(
        "SELECT admin_content_inspect_policy FROM tenant_policies WHERE tenant_id = 't1'"
      ).first<{ admin_content_inspect_policy: string }>(),
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'active_file_locks'"
      ).first<{ name: string }>(),
      env.DB.prepare('PRAGMA table_info(active_file_locks)').all<{
        name: string;
        pk: number;
      }>(),
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_active_file_locks_tenant_exp'"
      ).first<{ name: string }>(),
    ]);
    expect(contentIndexes.results.map((row) => row.name)).toEqual([
      'idx_files_active_creator',
      'idx_files_active_recent',
      'idx_folders_active_recent',
      'idx_shared_links_tenant_active',
    ]);
    expect(policyCols0016.results.map((column) => column.name)).toContain(
      'admin_content_inspect_policy'
    );
    expect(inspectPolicyRow?.admin_content_inspect_policy).toBe(
      'watermark_confidential'
    );
    expect(lockTable?.name).toBe('active_file_locks');
    expect(lockCols.results.map((column) => column.name)).toEqual([
      'file_id',
      'tenant_id',
      'mode',
      'lock_id',
      'owner_id',
      'owner_name',
      'owner_email',
      'expires_at',
      'updated_at',
    ]);
    expect(
      lockCols.results
        .filter((column) => column.pk > 0)
        .map((column) => column.name)
    ).toEqual(['file_id']);
    expect(lockIndex?.name).toBe('idx_active_file_locks_tenant_exp');

    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET admin_content_inspect_policy = 'allow_all' WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();

    await env.DB.prepare(
      `INSERT INTO active_file_locks (
         file_id, tenant_id, mode, lock_id, owner_id, owner_name,
         owner_email, expires_at, updated_at
       ) VALUES ('f1', 't1', 'desktop_exclusive', 'schema-lock', 'u1', 'U1',
                 'u1@example.com', '2099-01-01T00:00:00.000Z',
                 '2026-11-17T00:00:00.000Z')`
    ).run();
    const shadowLock = await env.DB.prepare(
      "SELECT mode, lock_id FROM active_file_locks WHERE file_id = 'f1'"
    ).first<{ mode: string; lock_id: string }>();
    expect(shadowLock).toEqual({
      mode: 'desktop_exclusive',
      lock_id: 'schema-lock',
    });
    await expect(
      env.DB.prepare(
        "UPDATE active_file_locks SET mode = 'invalid' WHERE file_id = 'f1'"
      ).run()
    ).rejects.toThrow();
    await env.DB.prepare(
      "DELETE FROM active_file_locks WHERE file_id = 'f1'"
    ).run();

    // Migration 0017: active-session monitor index. The admin session list
    // filters by tenant/revocation/expiry and pages by created_at DESC.
    const sessionIndex = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_tenant_active'"
    ).first<{ name: string }>();
    expect(sessionIndex?.name).toBe('idx_sessions_tenant_active');
    const sessionIndexCols = await env.DB.prepare(
      'PRAGMA index_info(idx_sessions_tenant_active)'
    ).all<{ name: string }>();
    expect(sessionIndexCols.results.map((column) => column.name)).toEqual([
      'tenant_id',
      'revoked_at',
      'expires_at',
      'created_at',
      'id',
    ]);

    // Migration 0018: IP allowlist + OIDC SSO authentication controls.
    const policyCols0018 = await env.DB.prepare(
      'PRAGMA table_info(tenant_policies)'
    ).all<{ name: string }>();
    const policy0018 = await env.DB.prepare(
      `SELECT ip_allowlist_enabled, ip_allowlist_scope, ip_allowlist_json,
              require_sso_login, sso_allowed_domains_json
         FROM tenant_policies WHERE tenant_id = 't1'`
    ).first<{
      ip_allowlist_enabled: number;
      ip_allowlist_scope: string;
      ip_allowlist_json: string;
      require_sso_login: number;
      sso_allowed_domains_json: string;
    }>();
    expect(policyCols0018.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'ip_allowlist_enabled',
        'ip_allowlist_scope',
        'ip_allowlist_json',
        'require_sso_login',
        'sso_allowed_domains_json',
      ])
    );
    expect(policy0018).toEqual({
      ip_allowlist_enabled: 0,
      ip_allowlist_scope: 'admin_only',
      ip_allowlist_json: '[]',
      require_sso_login: 0,
      sso_allowed_domains_json: '[]',
    });
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET ip_allowlist_scope = 'everyone' WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET ip_allowlist_enabled = 2 WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();

    // Migration 0019: admin insights pre-aggregation and bounded-scan indexes.
    const [insightsTable, insightCols, insightIndexes] = await Promise.all([
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_daily_insights'"
      ).first<{ name: string }>(),
      env.DB.prepare('PRAGMA table_info(tenant_daily_insights)').all<{
        name: string;
        pk: number;
      }>(),
      env.DB.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'idx_files_active_created',
              'idx_shared_links_tenant_created'
            )
          ORDER BY name`
      ).all<{ name: string }>(),
    ]);
    expect(insightsTable?.name).toBe('tenant_daily_insights');
    expect(insightCols.results.map((column) => column.name)).toEqual([
      'tenant_id',
      'day_utc',
      'active_users_count',
      'active_guests_count',
      'new_files_count',
      'downloads_count',
      'shared_links_created_count',
      'blocked_audit_count',
      'used_bytes_snapshot',
      'total_files_snapshot',
      'updated_at',
    ]);
    expect(
      insightCols.results
        .filter((column) => column.pk > 0)
        .map((column) => column.name)
        .sort()
    ).toEqual(['day_utc', 'tenant_id']);
    expect(insightIndexes.results.map((row) => row.name)).toEqual([
      'idx_files_active_created',
      'idx_shared_links_tenant_created',
    ]);

    await env.DB.prepare(
      `INSERT INTO tenant_daily_insights (
         tenant_id, day_utc, active_users_count, active_guests_count,
         new_files_count, downloads_count, shared_links_created_count,
         blocked_audit_count, used_bytes_snapshot, total_files_snapshot,
         updated_at
       ) VALUES ('t1', '2026-11-17', 2, 1, 3, 4, 5, 6, 7000, 7,
                 '2026-11-17T00:00:00.000Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO tenant_daily_insights (
         tenant_id, day_utc, active_users_count, active_guests_count,
         new_files_count, downloads_count, shared_links_created_count,
         blocked_audit_count, used_bytes_snapshot, total_files_snapshot,
         updated_at
       ) VALUES ('t1', '2026-11-17', 99, 0, 0, 0, 0, 0, 0, 0,
                 '2026-11-18T00:00:00.000Z')
       ON CONFLICT(tenant_id, day_utc) DO UPDATE SET
         active_users_count = excluded.active_users_count,
         updated_at = excluded.updated_at`
    ).run();
    const insightRow = await env.DB.prepare(
      "SELECT active_users_count, updated_at FROM tenant_daily_insights WHERE tenant_id = 't1' AND day_utc = '2026-11-17'"
    ).first<{ active_users_count: number; updated_at: string }>();
    expect(insightRow).toEqual({
      active_users_count: 99,
      updated_at: '2026-11-18T00:00:00.000Z',
    });
    await expect(
      env.DB.prepare(
        "UPDATE tenant_daily_insights SET new_files_count = -1 WHERE tenant_id = 't1' AND day_utc = '2026-11-17'"
      ).run()
    ).rejects.toThrow();

    // Migration 0020: asynchronous & scheduled admin reports.
    const [reportJobsTable, reportSchedulesTable, reportJobCols, reportScheduleCols, reportIndexes] =
      await Promise.all([
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_report_jobs'"
        ).first<{ name: string }>(),
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_report_schedules'"
        ).first<{ name: string }>(),
        env.DB.prepare('PRAGMA table_info(admin_report_jobs)').all<{
          name: string;
        }>(),
        env.DB.prepare('PRAGMA table_info(admin_report_schedules)').all<{
          name: string;
        }>(),
        env.DB.prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'idx_admin_report_jobs_tenant_created',
                'idx_admin_report_jobs_expires',
                'idx_admin_report_schedules_due'
              )
            ORDER BY name`
        ).all<{ name: string }>(),
      ]);
    expect(reportJobsTable?.name).toBe('admin_report_jobs');
    expect(reportSchedulesTable?.name).toBe('admin_report_schedules');
    expect(reportJobCols.results.map((column) => column.name)).toEqual([
      'id',
      'tenant_id',
      'schedule_id',
      'report_type',
      'status',
      'filters_json',
      'r2_object_key',
      'row_count',
      'byte_size',
      'error_message',
      'created_by',
      'created_by_email',
      'expires_at',
      'started_at',
      'completed_at',
      'created_at',
      'updated_at',
    ]);
    expect(reportScheduleCols.results.map((column) => column.name)).toEqual([
      'id',
      'tenant_id',
      'name',
      'report_type',
      'cadence',
      'enabled',
      'filters_json',
      'retention_days',
      'next_run_at',
      'last_run_at',
      'last_job_id',
      'created_by',
      'created_at',
      'updated_at',
    ]);
    expect(reportIndexes.results.map((row) => row.name)).toEqual([
      'idx_admin_report_jobs_expires',
      'idx_admin_report_jobs_tenant_created',
      'idx_admin_report_schedules_due',
    ]);

    await env.DB.prepare(
      `INSERT INTO admin_report_jobs (
         id, tenant_id, schedule_id, report_type, status, filters_json,
         created_by, created_by_email, expires_at, created_at, updated_at
       ) VALUES (
         'report-job-schema', 't1', NULL, 'user_activity', 'queued', '{}',
         'u1', 'u1@example.com', '2099-01-01T00:00:00.000Z',
         '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z'
       )`
    ).run();
    await expect(
      env.DB.prepare(
        "UPDATE admin_report_jobs SET status = 'unknown' WHERE id = 'report-job-schema'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE admin_report_jobs SET report_type = 'unknown' WHERE id = 'report-job-schema'"
      ).run()
    ).rejects.toThrow();

    await env.DB.prepare(
      `INSERT INTO admin_report_schedules (
         id, tenant_id, name, report_type, cadence, enabled, filters_json,
         retention_days, next_run_at, created_by, created_at, updated_at
       ) VALUES (
         'report-schedule-schema', 't1', 'Weekly', 'users_and_guests',
         'weekly', 1, '{}', 30, '2026-11-24T00:00:00.000Z', 'u1',
         '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z'
       )`
    ).run();
    await expect(
      env.DB.prepare(
        "UPDATE admin_report_schedules SET cadence = 'daily' WHERE id = 'report-schedule-schema'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE admin_report_schedules SET enabled = 2 WHERE id = 'report-schedule-schema'"
      ).run()
    ).rejects.toThrow();

    // Migration 0021: custom ToS acceptance, file-request governance,
    // branding, SIEM webhook and quota warning thresholds.
    const [tosTable, acceptanceTable, acceptanceIndexes, policyCols0021] =
      await Promise.all([
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tenant_tos_policies'"
        ).first<{ name: string }>(),
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_tos_acceptances'"
        ).first<{ name: string }>(),
        env.DB.prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'idx_user_tos_acceptances_tenant_user',
                'idx_user_tos_acceptances_tenant_accepted'
              )
            ORDER BY name`
        ).all<{ name: string }>(),
        env.DB.prepare('PRAGMA table_info(tenant_policies)').all<{
          name: string;
        }>(),
      ]);
    expect(tosTable?.name).toBe('tenant_tos_policies');
    expect(acceptanceTable?.name).toBe('user_tos_acceptances');
    expect(acceptanceIndexes.results.map((row) => row.name)).toEqual([
      'idx_user_tos_acceptances_tenant_accepted',
      'idx_user_tos_acceptances_tenant_user',
    ]);
    expect(policyCols0021.results.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'allow_file_requests',
        'file_request_max_size_bytes',
        'file_request_enforce_allowed_extensions',
        'branding_org_name',
        'branding_contact_info',
        'branding_footer_note',
        'siem_webhook_enabled',
        'siem_webhook_url',
        'siem_webhook_secret_encrypted',
        'siem_events_json',
        'quota_warn_threshold_pct',
        'quota_critical_threshold_pct',
      ])
    );

    const governanceDefaults = await env.DB.prepare(
      `SELECT allow_file_requests, file_request_max_size_bytes,
              file_request_enforce_allowed_extensions, branding_org_name,
              siem_webhook_enabled, siem_webhook_url,
              siem_webhook_secret_encrypted, siem_events_json,
              quota_warn_threshold_pct, quota_critical_threshold_pct
         FROM tenant_policies WHERE tenant_id = 't1'`
    ).first<{
      allow_file_requests: number;
      file_request_max_size_bytes: number;
      file_request_enforce_allowed_extensions: number;
      branding_org_name: string | null;
      siem_webhook_enabled: number;
      siem_webhook_url: string | null;
      siem_webhook_secret_encrypted: string | null;
      siem_events_json: string;
      quota_warn_threshold_pct: number;
      quota_critical_threshold_pct: number;
    }>();
    expect(governanceDefaults).toEqual({
      allow_file_requests: 1,
      file_request_max_size_bytes: 104857600,
      file_request_enforce_allowed_extensions: 0,
      branding_org_name: null,
      siem_webhook_enabled: 0,
      siem_webhook_url: null,
      siem_webhook_secret_encrypted: null,
      siem_events_json: '["security_blocked","admin_mutation"]',
      quota_warn_threshold_pct: 80,
      quota_critical_threshold_pct: 90,
    });

    await env.DB.prepare(
      `INSERT INTO tenant_tos_policies (
         tenant_id, enabled, version, target_audience, title, body_markdown, updated_at
       ) VALUES ('t1', 1, 3, 'guests_only', '利用規約', '本文', '2026-11-17T00:00:00.000Z')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO user_tos_acceptances (
         id, tenant_id, user_id, version, accepted_at
       ) VALUES ('tos-accept-schema', 't1', 'u1', 3, '2026-11-17T00:00:00.000Z')`
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO user_tos_acceptances (
           id, tenant_id, user_id, version, accepted_at
         ) VALUES ('tos-accept-dup', 't1', 'u1', 3, '2026-11-17T00:00:00.000Z')`
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_tos_policies SET target_audience = 'everyone' WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET allow_file_requests = 2 WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET quota_warn_threshold_pct = 40 WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "UPDATE tenant_policies SET quota_critical_threshold_pct = 101 WHERE tenant_id = 't1'"
      ).run()
    ).rejects.toThrow();

    // Migration 0022: Co-Admin delegations with optional group / root-folder
    // scopes, one active grant per (tenant, user).
    const [delegationTable, delegationCols, delegationIndexes] =
      await Promise.all([
        env.DB.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_delegations'"
        ).first<{ name: string }>(),
        env.DB.prepare('PRAGMA table_info(admin_delegations)').all<{
          name: string;
          pk: number;
        }>(),
        env.DB.prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'index'
              AND name IN (
                'idx_admin_delegations_tenant_user',
                'idx_admin_delegations_tenant_created'
              )
            ORDER BY name`
        ).all<{ name: string }>(),
      ]);
    expect(delegationTable?.name).toBe('admin_delegations');
    expect(delegationCols.results.map((column) => column.name)).toEqual([
      'id',
      'tenant_id',
      'user_id',
      'preset',
      'permissions_json',
      'scope_group_id',
      'scope_root_folder_id',
      'note',
      'granted_by',
      'created_at',
      'updated_at',
    ]);
    expect(
      delegationCols.results
        .filter((column) => column.pk > 0)
        .map((column) => column.name)
        .sort()
    ).toEqual(['id']);
    expect(delegationIndexes.results.map((row) => row.name)).toEqual([
      'idx_admin_delegations_tenant_created',
      'idx_admin_delegations_tenant_user',
    ]);

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users (id, tenant_id, email, display_name, role) VALUES ('delegated-member', 't1', 'delegated@example.com', 'Delegated', 'member')"
      ),
      env.DB.prepare(
        "INSERT INTO groups (id, tenant_id, name) VALUES ('delegation-group', 't1', 'Delegation Group')"
      ),
    ]);
    await env.DB.prepare(
      `INSERT INTO admin_delegations (
         id, tenant_id, user_id, preset, permissions_json, scope_group_id,
         scope_root_folder_id, note, granted_by, created_at, updated_at
       ) VALUES (
         'delegation-schema', 't1', 'delegated-member', 'auditor',
         '["admin.insights.read","admin.audit.read"]', 'delegation-group',
         'fld1', 'schema test', 'u1',
         '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z'
       )`
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO admin_delegations (
           id, tenant_id, user_id, permissions_json, granted_by, created_at, updated_at
         ) VALUES ('delegation-duplicate', 't1', 'delegated-member', '[]', 'u1',
                   '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z')`
      ).run()
    ).rejects.toThrow();

    // Deleting the scoped group restricts the delegation, it never deletes it.
    await env.DB.prepare(
      "DELETE FROM groups WHERE id = 'delegation-group'"
    ).run();
    const scopedDelegation = await env.DB.prepare(
      "SELECT scope_group_id, permissions_json FROM admin_delegations WHERE id = 'delegation-schema'"
    ).first<{ scope_group_id: string | null; permissions_json: string }>();
    expect(scopedDelegation).toEqual({
      scope_group_id: null,
      permissions_json: '["admin.insights.read","admin.audit.read"]',
    });

    // Migration 0023: O(1) root_folder_stats pre-aggregation
    const [statsTable, statsCols, statsIndexes] = await Promise.all([
      env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'root_folder_stats'"
      ).first<{ name: string }>(),
      env.DB.prepare('PRAGMA table_info(root_folder_stats)').all<{
        name: string;
        pk: number;
      }>(),
      env.DB.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index' AND name = 'idx_root_folder_stats_tenant_bytes'`
      ).all<{ name: string }>(),
    ]);
    expect(statsTable?.name).toBe('root_folder_stats');
    expect(statsCols.results.map((c) => c.name)).toEqual([
      'tenant_id',
      'root_folder_id',
      'file_count',
      'total_bytes',
      'updated_at',
    ]);
    expect(
      statsCols.results
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name)
    ).toEqual(['tenant_id', 'root_folder_id']);
    expect(statsIndexes.results.map((r) => r.name)).toEqual([
      'idx_root_folder_stats_tenant_bytes',
    ]);

    await expect(
      env.DB.prepare(
        `INSERT INTO root_folder_stats (tenant_id, root_folder_id, file_count, total_bytes)
         VALUES ('t1', 'fld1', -1, 0)`
      ).run()
    ).rejects.toThrow();

    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
       SELECT root_folder_id, file_count, total_bytes
         FROM root_folder_stats
        WHERE tenant_id = 't1' AND root_folder_id IN ('fld1')`
    ).all<{ detail: string }>();
    const planText = plan.results.map((r) => r.detail).join('\n');
    expect(planText).not.toContain('SCAN files');
    expect(planText).not.toContain('folder_closures');
    expect(planText).toContain('root_folder_stats');
  });
});
