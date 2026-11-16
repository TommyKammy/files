import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  ADVANCED_RESOURCE_ROLES,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  can,
  canRole,
  capabilitiesForRole,
  capabilitiesForRoles,
  filterFileTargetRoles,
  isAdvancedResourceRole,
  joinRoles,
  parseRoleList,
  rolesWithCapability,
  synthesizeEffectiveAccess,
  type Capability,
} from '../src/services/capabilities';
import { hasAtLeastRole } from '../src/services/authorization';
import type { ResourceRole } from '../src/types/api';

const ALL_ROLES: ResourceRole[] = [
  'owner',
  'co_owner',
  'editor',
  'viewer_uploader',
  'previewer_uploader',
  'viewer',
  'previewer',
  'uploader',
];

/**
 * Explicit expectation table for the eight-role capability matrix.
 * Kept literal on purpose: a mistake in `ROLE_CAPABILITIES` must fail here.
 */
const MATRIX: Record<ResourceRole, Capability[]> = {
  owner: [...CAPABILITIES],
  co_owner: CAPABILITIES.filter(
    (capability) =>
      capability !== 'owner.transfer' && capability !== 'folder.delete_root'
  ),
  editor: [
    'folder.list',
    'folder.traverse',
    'folder.create',
    'folder.rename',
    'folder.move',
    'folder.delete',
    'item.preview',
    'item.download',
    'item.upload_new',
    'item.upload_version',
    'item.edit_content',
    'item.rename',
    'item.move',
    'item.delete',
    'metadata.edit',
    'classification.edit',
    'permission.view',
    'share_link.create',
    'share_link.manage',
    'trash.restore',
  ],
  viewer_uploader: [
    'folder.list',
    'folder.traverse',
    'folder.create',
    'item.preview',
    'item.download',
    'item.upload_new',
    'item.upload_version',
    'item.edit_content',
    'permission.view',
    'share_link.create',
  ],
  previewer_uploader: [
    'folder.list',
    'folder.traverse',
    'folder.create',
    'item.preview',
    'item.upload_new',
  ],
  viewer: [
    'folder.list',
    'folder.traverse',
    'item.preview',
    'item.download',
    'permission.view',
  ],
  previewer: ['folder.list', 'folder.traverse', 'item.preview'],
  uploader: [
    'folder.list',
    'folder.traverse',
    'folder.create',
    'item.upload_new',
  ],
};

function expectSubset(subset: readonly Capability[], superset: readonly Capability[]): void {
  for (const capability of subset) {
    expect(
      superset.includes(capability),
      `expected superset to include ${capability}`
    ).toBe(true);
  }
}

describe('Capability model (TOM-52)', () => {
  it('defines exactly the eight documented roles with the documented capability sets', () => {
    expect([...ALL_ROLES].sort()).toEqual(
      Object.keys(ROLE_CAPABILITIES).sort()
    );

    for (const role of ALL_ROLES) {
      expect(new Set(capabilitiesForRole(role))).toEqual(
        new Set(MATRIX[role])
      );
    }

    // Canonical list has no duplicates and every capability is reachable.
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
    const union = new Set(capabilitiesForRoles(ALL_ROLES));
    expect([...CAPABILITIES].every((capability) => union.has(capability))).toBe(true);
  });

  it('keeps preview / download / upload boundaries strict for the advanced roles', () => {
    // uploader: never preview/download/edit/rename/move/delete/share/permissions
    for (const capability of [
      'item.preview',
      'item.download',
      'item.upload_version',
      'item.edit_content',
      'item.rename',
      'item.move',
      'item.delete',
      'metadata.edit',
      'classification.edit',
      'permission.view',
      'permission.invite',
      'permission.manage',
      'share_link.create',
      'share_link.manage',
      'trash.restore',
      'trash.purge',
    ] as Capability[]) {
      expect(canRole('uploader', capability), `uploader must not have ${capability}`).toBe(false);
    }
    expect(canRole('uploader', 'folder.create')).toBe(true);
    expect(canRole('uploader', 'item.upload_new')).toBe(true);

    // previewer_uploader: preview + new upload only
    expect(canRole('previewer_uploader', 'item.download')).toBe(false);
    expect(canRole('previewer_uploader', 'item.upload_version')).toBe(false);
    expect(canRole('previewer_uploader', 'item.edit_content')).toBe(false);
    expect(canRole('previewer_uploader', 'share_link.create')).toBe(false);
    expect(canRole('previewer_uploader', 'permission.view')).toBe(false);

    // viewer_uploader: viewer + uploader, but no lifecycle/admin/share manage
    expect(canRole('viewer_uploader', 'item.preview')).toBe(true);
    expect(canRole('viewer_uploader', 'item.download')).toBe(true);
    expect(canRole('viewer_uploader', 'item.upload_version')).toBe(true);
    expect(canRole('viewer_uploader', 'item.edit_content')).toBe(true);
    expect(canRole('viewer_uploader', 'share_link.create')).toBe(true);
    expect(canRole('viewer_uploader', 'share_link.manage')).toBe(false);
    expect(canRole('viewer_uploader', 'permission.invite')).toBe(false);
    expect(canRole('viewer_uploader', 'permission.manage')).toBe(false);
    expect(canRole('viewer_uploader', 'item.rename')).toBe(false);
    expect(canRole('viewer_uploader', 'trash.restore')).toBe(false);
    expect(canRole('viewer_uploader', 'folder.settings')).toBe(false);

    // Only owner holds the owner-exclusive capabilities.
    expect(rolesWithCapability('owner.transfer')).toEqual(['owner']);
    expect(rolesWithCapability('folder.delete_root')).toEqual(['owner']);
  });

  it('is monotonic for the documented role chains', () => {
    const chains: ResourceRole[][] = [
      ['viewer', 'viewer_uploader', 'editor', 'co_owner', 'owner'],
      ['uploader', 'previewer_uploader', 'viewer_uploader'],
      ['previewer', 'previewer_uploader'],
      ['previewer', 'viewer', 'viewer_uploader'],
    ];
    for (const chain of chains) {
      for (let i = 0; i < chain.length - 1; i += 1) {
        expectSubset(
          capabilitiesForRole(chain[i]!),
          capabilitiesForRole(chain[i + 1]!)
        );
      }
    }
  });

  it('composes roles non-linearly and order-independently', () => {
    expect(joinRoles([])).toBeNull();
    for (const role of ALL_ROLES) {
      expect(joinRoles([role])).toBe(role);
    }

    expect(joinRoles(['viewer', 'uploader'])).toBe('viewer_uploader');
    expect(joinRoles(['uploader', 'viewer'])).toBe('viewer_uploader');
    expect(joinRoles(['previewer', 'uploader'])).toBe('previewer_uploader');
    expect(joinRoles(['uploader', 'previewer'])).toBe('previewer_uploader');
    expect(joinRoles(['viewer', 'previewer'])).toBe('viewer');
    expect(joinRoles(['previewer', 'viewer'])).toBe('viewer');
    expect(joinRoles(['viewer', 'previewer', 'uploader'])).toBe('viewer_uploader');
    expect(joinRoles(['previewer', 'uploader', 'viewer_uploader'])).toBe(
      'viewer_uploader'
    );

    // Linear precedence for management roles.
    expect(joinRoles(['viewer', 'editor'])).toBe('editor');
    expect(joinRoles(['uploader', 'co_owner'])).toBe('co_owner');
    expect(joinRoles(['editor', 'owner'])).toBe('owner');
    expect(joinRoles(['owner', 'uploader', 'previewer'])).toBe('owner');

    // Every pair is commutative and idempotent.
    for (const a of ALL_ROLES) {
      expect(joinRoles([a, a])).toBe(a);
      for (const b of ALL_ROLES) {
        expect(joinRoles([a, b])).toBe(joinRoles([b, a]));
      }
    }
  });

  it('synthesizes capabilities that are a monotonic superset of every grant', () => {
    const combos: ResourceRole[][] = [
      [],
      ['viewer'],
      ['uploader'],
      ['viewer', 'uploader'],
      ['previewer', 'uploader'],
      ['previewer', 'viewer'],
      ['viewer_uploader'],
      ['uploader', 'viewer', 'previewer'],
    ];

    for (const roles of combos) {
      const access = synthesizeEffectiveAccess(roles);
      const union = new Set(capabilitiesForRoles(roles));
      if (roles.length === 0) {
        expect(access.effectiveRole).toBeNull();
        expect(access.capabilities).toEqual([]);
        continue;
      }
      expect(access.effectiveRole).toBe(joinRoles(roles));
      expect(new Set(access.capabilities)).toEqual(
        new Set(capabilitiesForRole(access.effectiveRole!))
      );
      // capabilities are consistent with, and never weaker than, the grants.
      expectSubset([...union], access.capabilities);

      // Adding another grant can only grow the capability set.
      const extended = synthesizeEffectiveAccess([...roles, 'viewer']);
      expectSubset(access.capabilities, extended.capabilities);
    }

    // viewer + uploader must expose the full viewer_uploader surface.
    const combined = synthesizeEffectiveAccess(['viewer', 'uploader']);
    expect(combined.effectiveRole).toBe('viewer_uploader');
    for (const capability of [
      'item.preview',
      'item.download',
      'item.upload_new',
      'item.upload_version',
      'item.edit_content',
    ] as Capability[]) {
      expect(can(combined.capabilities, capability)).toBe(true);
    }
  });

  it('is monotonic for every one of the 256 role subsets', () => {
    for (let mask = 0; mask < 1 << ALL_ROLES.length; mask += 1) {
      const roles = ALL_ROLES.filter((_, index) => (mask & (1 << index)) !== 0);
      const access = synthesizeEffectiveAccess(roles);
      if (roles.length === 0) {
        expect(access.effectiveRole).toBeNull();
        expect(access.capabilities).toEqual([]);
        continue;
      }
      expect(access.effectiveRole).not.toBeNull();
      for (const role of roles) {
        expectSubset(capabilitiesForRole(role), access.capabilities);
      }
      for (const extra of ALL_ROLES) {
        const extended = synthesizeEffectiveAccess([...roles, extra]);
        // Adding a grant can never revoke a capability.
        expectSubset(access.capabilities, extended.capabilities);
      }
    }
  });

  it('parses SQL role lists defensively', () => {
    expect(parseRoleList(null)).toEqual([]);
    expect(parseRoleList('')).toEqual([]);
    expect(parseRoleList('viewer,uploader,viewer')).toEqual(['viewer', 'uploader']);
    expect(parseRoleList('viewer,superuser,uploader')).toEqual([
      'viewer',
      'uploader',
    ]);
    expect(new Set(parseRoleList('owner,co_owner,editor,viewer_uploader'))).toEqual(
      new Set(['owner', 'co_owner', 'editor', 'viewer_uploader'])
    );

    expect(isAdvancedResourceRole('uploader')).toBe(true);
    expect(isAdvancedResourceRole('viewer_uploader')).toBe(true);
    expect(isAdvancedResourceRole('previewer_uploader')).toBe(true);
    expect(isAdvancedResourceRole('editor')).toBe(false);
    expect(isAdvancedResourceRole(null)).toBe(false);
    expect([...ADVANCED_RESOURCE_ROLES].sort()).toEqual([
      'previewer_uploader',
      'uploader',
      'viewer_uploader',
    ]);

    // Advanced roles are folder-only: direct file grants are dropped.
    expect(
      filterFileTargetRoles(['owner', 'uploader', 'viewer_uploader', 'viewer'])
    ).toEqual(['owner', 'viewer']);
  });

  it('keeps hasAtLeastRole a safe compatibility adapter', () => {
    // Legacy ordering is preserved exactly.
    const legacy: ResourceRole[] = ['previewer', 'viewer', 'editor', 'co_owner', 'owner'];
    for (let i = 0; i < legacy.length; i += 1) {
      for (let j = 0; j < legacy.length; j += 1) {
        expect(hasAtLeastRole(legacy[i]!, legacy[j]!)).toBe(i >= j);
      }
    }

    // Advanced roles must never be mistaken for a linear "at least" rank.
    expect(hasAtLeastRole('viewer_uploader', 'editor')).toBe(false);
    expect(hasAtLeastRole('viewer_uploader', 'co_owner')).toBe(false);
    expect(hasAtLeastRole('viewer_uploader', 'viewer')).toBe(true);
    expect(hasAtLeastRole('viewer_uploader', 'previewer')).toBe(true);
    expect(hasAtLeastRole('uploader', 'previewer')).toBe(false);
    expect(hasAtLeastRole('uploader', 'viewer')).toBe(false);
    expect(hasAtLeastRole('previewer_uploader', 'viewer')).toBe(false);
    expect(hasAtLeastRole('previewer_uploader', 'previewer')).toBe(true);
    expect(hasAtLeastRole(null, 'previewer')).toBe(false);
    expect(hasAtLeastRole('uploader', 'uploader')).toBe(true);
  });
});

describe('Migration 0007: eight roles, WOPI draft FK and policy gate', () => {
  const TENANT = 'tenant-cap-mig';
  const USER = 'cap-mig-user';
  const FOLDER = 'cap-mig-folder';
  const FILE = 'cap-mig-file';

  beforeAll(async () => {
    // Apply 0001-0006 first, seed legacy 5-role data, then apply 0007 on top
    // so the table rebuild is exercised against real pre-existing rows.
    const legacyMigrations = env.TEST_MIGRATIONS.filter(
      (migration) => migration.name < '0007'
    );
    expect(legacyMigrations.length).toBe(6);
    await applyD1Migrations(env.DB, legacyMigrations);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tenants (id, name, slug) VALUES (?, 'Capability Org', 'capability-org')`
      ).bind(TENANT),
      env.DB.prepare('INSERT INTO tenant_policies (tenant_id) VALUES (?)').bind(TENANT),
      env.DB.prepare(
        `INSERT INTO users (id, tenant_id, email, display_name, role, status)
         VALUES (?, ?, 'mig@example.com', 'Migration User', 'member', 'active')`
      ).bind(USER, TENANT),
      env.DB.prepare(
        `INSERT INTO folders (id, tenant_id, name, depth, version, classification, created_by)
         VALUES (?, ?, 'Legacy', 0, 1, 'internal', ?)`
      ).bind(FOLDER, TENANT, USER),
      env.DB.prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, ?, ?, 0)`
      ).bind(TENANT, FOLDER, FOLDER),
      env.DB.prepare(
        `INSERT INTO files (id, tenant_id, folder_id, name, mime_type, size_bytes, upload_state,
                            current_version_id, current_version_num, classification, created_by, updated_by)
         VALUES (?, ?, ?, 'legacy.txt', 'text/plain', 5, 'active', 'cap-mig-v1', 1, 'internal', ?, ?)`
      ).bind(FILE, TENANT, FOLDER, USER, USER),
      env.DB.prepare(
        `INSERT INTO file_versions (id, tenant_id, file_id, version_num, r2_object_key,
                                    size_bytes, mime_type, upload_status, uploaded_by)
         VALUES ('cap-mig-v1', ?, ?, 1, 'tenants/cap-mig/objects/legacy/v1', 5, 'text/plain', 'completed', ?)`
      ).bind(TENANT, FILE, USER),
      // One permission row per legacy role: all five must survive the rebuild.
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES
           ('cap-mig-p-owner', ?, 'folder', ?, 'user', ?, 'owner', ?),
           ('cap-mig-p-coowner', ?, 'folder', ?, 'user', ?, 'co_owner', ?),
           ('cap-mig-p-editor', ?, 'folder', ?, 'user', ?, 'editor', ?),
           ('cap-mig-p-viewer', ?, 'folder', ?, 'user', ?, 'viewer', ?),
           ('cap-mig-p-previewer', ?, 'folder', ?, 'user', ?, 'previewer', ?)`
      ).bind(
        TENANT, FOLDER, 'cap-mig-grantee-owner', USER,
        TENANT, FOLDER, 'cap-mig-grantee-coowner', USER,
        TENANT, FOLDER, 'cap-mig-grantee-editor', USER,
        TENANT, FOLDER, 'cap-mig-grantee-viewer', USER,
        TENANT, FOLDER, 'cap-mig-grantee-previewer', USER
      ),
      // One WOPI session per legacy role plus a child draft for each session.
      env.DB.prepare(
        `INSERT INTO wopi_sessions (id, tenant_id, file_id, user_id, role, can_write,
                                    access_token_hash, is_active, expires_at)
         VALUES
           ('cap-mig-ws-owner', ?, ?, ?, 'owner', 1, 'h1', 1, '2099-01-01T00:00:00.000Z'),
           ('cap-mig-ws-coowner', ?, ?, ?, 'co_owner', 1, 'h2', 1, '2099-01-01T00:00:00.000Z'),
           ('cap-mig-ws-editor', ?, ?, ?, 'editor', 1, 'h3', 1, '2099-01-01T00:00:00.000Z'),
           ('cap-mig-ws-viewer', ?, ?, ?, 'viewer', 0, 'h4', 1, '2099-01-01T00:00:00.000Z'),
           ('cap-mig-ws-previewer', ?, ?, ?, 'previewer', 0, 'h5', 1, '2099-01-01T00:00:00.000Z')`
      ).bind(
        TENANT, FILE, USER,
        TENANT, FILE, USER,
        TENANT, FILE, USER,
        TENANT, FILE, USER,
        TENANT, FILE, USER
      ),
      env.DB.prepare(
        `INSERT INTO wopi_drafts (id, session_id, tenant_id, file_id, r2_object_key,
                                  size_bytes, mime_type, last_saved_by, is_active, expires_at)
         VALUES
           ('cap-mig-d-owner', 'cap-mig-ws-owner', ?, ?, 'k/owner', 1, 'text/plain', ?, 1, '2099-01-01T00:00:00.000Z'),
           ('cap-mig-d-coowner', 'cap-mig-ws-coowner', ?, ?, 'k/coowner', 1, 'text/plain', ?, 1, '2099-01-01T00:00:00.000Z'),
           ('cap-mig-d-editor', 'cap-mig-ws-editor', ?, ?, 'k/editor', 1, 'text/plain', ?, 1, '2099-01-01T00:00:00.000Z'),
           ('cap-mig-d-viewer', 'cap-mig-ws-viewer', ?, ?, 'k/viewer', 1, 'text/plain', ?, 1, '2099-01-01T00:00:00.000Z'),
           ('cap-mig-d-previewer', 'cap-mig-ws-previewer', ?, ?, 'k/previewer', 1, 'text/plain', ?, 1, '2099-01-01T00:00:00.000Z')`
      ).bind(
        TENANT, FILE, USER,
        TENANT, FILE, USER,
        TENANT, FILE, USER,
        TENANT, FILE, USER,
        TENANT, FILE, USER
      ),
    ]);

    // Apply the full chain; 0001-0006 are already recorded and skipped.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it('preserves every legacy permission and WOPI session/draft row', async () => {
    const permissions = await env.DB.prepare(
      'SELECT id, role FROM permissions WHERE tenant_id = ? ORDER BY id'
    )
      .bind(TENANT)
      .all<{ id: string; role: string }>();
    expect(permissions.results).toHaveLength(5);
    expect(permissions.results.map((row) => row.role).sort()).toEqual([
      'co_owner',
      'editor',
      'owner',
      'previewer',
      'viewer',
    ]);

    const sessions = await env.DB.prepare(
      'SELECT id, role FROM wopi_sessions WHERE tenant_id = ? ORDER BY id'
    )
      .bind(TENANT)
      .all<{ id: string; role: string }>();
    expect(sessions.results).toHaveLength(5);

    const drafts = await env.DB.prepare(
      'SELECT id, session_id FROM wopi_drafts WHERE tenant_id = ? ORDER BY id'
    )
      .bind(TENANT)
      .all<{ id: string; session_id: string }>();
    expect(drafts.results).toHaveLength(5);
    for (const draft of drafts.results) {
      expect(draft.session_id).toBe(`cap-mig-ws-${draft.id.replace('cap-mig-d-', '')}`);
    }

    // Indexes are recreated on the rebuilt tables.
    const indexes = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index'
         AND name IN (
           'idx_permissions_target', 'idx_permissions_grantee',
           'idx_wopi_sessions_file_active', 'idx_wopi_sessions_expiry',
           'idx_wopi_drafts_file_active', 'idx_wopi_drafts_expiry',
           'idx_wopi_drafts_session'
         ) ORDER BY name`
    ).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual([
      'idx_permissions_grantee',
      'idx_permissions_target',
      'idx_wopi_drafts_expiry',
      'idx_wopi_drafts_file_active',
      'idx_wopi_drafts_session',
      'idx_wopi_sessions_expiry',
      'idx_wopi_sessions_file_active',
    ]);
  });

  it('accepts all eight roles and still rejects unknown roles', async () => {
    const roles: ResourceRole[] = [...ALL_ROLES];
    for (const [index, role] of roles.entries()) {
      await env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES (?, ?, 'folder', ?, 'user', ?, ?, ?)`
      )
        .bind(
          `cap-mig-role-${index}`,
          TENANT,
          FOLDER,
          `cap-mig-grantee-${index}`,
          role,
          USER
        )
        .run();
    }
    const stored = await env.DB.prepare(
      "SELECT role FROM permissions WHERE tenant_id = ? AND id LIKE 'cap-mig-role-%'"
    )
      .bind(TENANT)
      .all<{ role: string }>();
    expect(new Set(stored.results.map((row) => row.role))).toEqual(new Set(ALL_ROLES));

    await expect(
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by)
         VALUES ('cap-mig-bad', ?, 'folder', ?, 'user', 'cap-mig-bad-user', 'superuser', ?)`
      )
        .bind(TENANT, FOLDER, USER)
        .run()
    ).rejects.toThrow();

    for (const [index, role] of roles.entries()) {
      await env.DB.prepare(
        `INSERT INTO wopi_sessions (id, tenant_id, file_id, user_id, role, can_write,
                                    access_token_hash, is_active, expires_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, 1, '2099-01-01T00:00:00.000Z')`
      )
        .bind(
          `cap-mig-role-ws-${index}`,
          TENANT,
          FILE,
          USER,
          role,
          `hash-${index}`
        )
        .run();
    }
    await expect(
      env.DB.prepare(
        `INSERT INTO wopi_sessions (id, tenant_id, file_id, user_id, role, can_write,
                                    access_token_hash, is_active, expires_at)
         VALUES ('cap-mig-bad-ws', ?, ?, ?, 'superuser', 0, 'bad', 1, '2099-01-01T00:00:00.000Z')`
      )
        .bind(TENANT, FILE, USER)
        .run()
    ).rejects.toThrow();
  });

  it('keeps the wopi_drafts foreign key working (cascade delete)', async () => {
    await env.DB.prepare(
      "DELETE FROM wopi_sessions WHERE id = 'cap-mig-ws-editor'"
    ).run();
    const draft = await env.DB.prepare(
      "SELECT id FROM wopi_drafts WHERE id = 'cap-mig-d-editor'"
    ).first();
    expect(draft).toBeNull();

    const surviving = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM wopi_drafts WHERE tenant_id = ? AND id LIKE 'cap-mig-d-%'"
    )
      .bind(TENANT)
      .first<{ cnt: number }>();
    expect(surviving?.cnt).toBe(4);

    // The FK still points at the rebuilt wopi_sessions table.
    await expect(
      env.DB.prepare(
        `INSERT INTO wopi_drafts (id, session_id, tenant_id, file_id, r2_object_key,
                                  size_bytes, mime_type, last_saved_by, is_active, expires_at)
         VALUES ('cap-mig-orphan', 'missing-session', ?, ?, 'k/orphan', 1, 'text/plain', ?, 1, '2099-01-01T00:00:00.000Z')`
      )
        .bind(TENANT, FILE, USER)
        .run()
    ).rejects.toThrow();
  });

  it('adds advanced_roles_enabled with default 0 and a 0/1 CHECK', async () => {
    const policy = await env.DB.prepare(
      'SELECT advanced_roles_enabled FROM tenant_policies WHERE tenant_id = ?'
    )
      .bind(TENANT)
      .first<{ advanced_roles_enabled: number }>();
    expect(policy?.advanced_roles_enabled).toBe(0);

    await expect(
      env.DB.prepare(
        'UPDATE tenant_policies SET advanced_roles_enabled = 2 WHERE tenant_id = ?'
      )
        .bind(TENANT)
        .run()
    ).rejects.toThrow();

    await env.DB.prepare(
      'UPDATE tenant_policies SET advanced_roles_enabled = 1 WHERE tenant_id = ?'
    )
      .bind(TENANT)
      .run();
    const enabled = await env.DB.prepare(
      'SELECT advanced_roles_enabled FROM tenant_policies WHERE tenant_id = ?'
    )
      .bind(TENANT)
      .first<{ advanced_roles_enabled: number }>();
    expect(enabled?.advanced_roles_enabled).toBe(1);
  });
});
