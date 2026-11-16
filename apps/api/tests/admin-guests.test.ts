import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sha256Hex } from '../src/services/crypto-utils';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-admin-guests';
const OTHER_TENANT = 'tenant-admin-guests-other';
const ADMIN = 'ag-sys';
const SEC_ADMIN = 'ag-sec';
const MEMBER = 'ag-member';
const OTHER_ADMIN = 'ag-other-sys';
const APP_ORIGIN = 'http://127.0.0.1:8787';

type UserRole = 'sys_admin' | 'sec_admin' | 'member';
type UserType = 'member' | 'guest';

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

function buildTestEnv(): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN,
    STORAGE_MODE: 'local_proxy',
    DEFAULT_TENANT_ID: TENANT,
  } as OidcEnv;
}

function headers(
  userId: string,
  role: UserRole = 'member',
  tenantId = TENANT,
  userType: UserType = 'member'
): Record<string, string> {
  return {
    'X-Dev-User-Id': userId,
    'X-Dev-User-Role': role,
    'X-Dev-Tenant-Id': tenantId,
    'X-Dev-User-Email': `${userId}@example.com`,
    'X-Dev-User-Type': userType,
    'Content-Type': 'application/json',
    Origin: APP_ORIGIN,
  };
}

async function call<T = Record<string, unknown>>(
  path: string,
  userId: string,
  options: {
    method?: string;
    body?: unknown;
    role?: UserRole;
    tenantId?: string;
    userType?: UserType;
    extraHeaders?: Record<string, string>;
  } = {}
): Promise<ApiResponse<T>> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...headers(
          userId,
          options.role ?? 'member',
          options.tenantId ?? TENANT,
          options.userType ?? 'member'
        ),
        ...(options.extraHeaders ?? {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }),
    buildTestEnv()
  );
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body: body as T, headers: response.headers };
}

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

async function seedGuest(
  id: string,
  email: string,
  options: {
    status?: 'active' | 'suspended';
    expiresAt?: string | null;
    lastLoginAt?: string | null;
    offboardedAt?: string | null;
    invitedBy?: string | null;
    displayName?: string;
    externalOrg?: string | null;
    tenantId?: string;
    createdAt?: string;
  } = {}
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (
       id, tenant_id, email, display_name, role, status, user_type,
       external_org, invited_by, expires_at, last_login_at, offboarded_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'member', ?, 'guest', ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.tenantId ?? TENANT,
      email,
      options.displayName ?? `Guest ${id}`,
      options.status ?? 'active',
      options.externalOrg ?? 'Partner A',
      options.invitedBy ?? ADMIN,
      options.expiresAt === undefined ? isoDaysFromNow(30) : options.expiresAt,
      options.lastLoginAt ?? null,
      options.offboardedAt ?? null,
      options.createdAt ?? isoDaysFromNow(-10),
      isoDaysFromNow(-10)
    )
    .run();
}

async function seedInvitation(input: {
  id: string;
  userId: string;
  email: string;
  status?: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt?: string;
  role?: 'viewer' | 'editor';
  targetType?: 'folder' | 'file';
  targetId?: string;
  invitedBy?: string;
  tenantId?: string;
  createdAt?: string;
}): Promise<void> {
  const tokenHash = await sha256Hex(`${input.id}-token`);
  await env.DB.prepare(
    `INSERT INTO guest_invitations (
       id, tenant_id, user_id, email, display_name, external_org, invited_by,
       token_hash, target_type, target_id, role, status, expires_at,
       resend_count, last_sent_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 'Partner A', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  )
    .bind(
      input.id,
      input.tenantId ?? TENANT,
      input.userId,
      input.email,
      `Guest ${input.userId}`,
      input.invitedBy ?? ADMIN,
      tokenHash,
      input.targetType ?? 'folder',
      input.targetId ?? 'ag-parent',
      input.role ?? 'viewer',
      input.status ?? 'pending',
      input.expiresAt ?? isoDaysFromNow(7),
      isoDaysFromNow(-1),
      input.createdAt ?? isoDaysFromNow(-1),
      isoDaysFromNow(-1)
    )
    .run();
}

describe('P10-3 / TOM-61 admin guest lifecycle governance', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?, 'Admin Guests', 'admin-guests'), (?, 'Other Guests', 'admin-guests-other')"
      ).bind(TENANT, OTHER_TENANT),
      env.DB.prepare(
        `INSERT OR REPLACE INTO tenant_policies (
           tenant_id, allow_external_collaborators,
           external_domain_allowlist_json, guest_invitation_expiry_days,
           guest_session_max_hours, allow_guest_elevated_roles,
           external_domain_existing_guest_mode, advanced_roles_enabled
         ) VALUES (?, 1, ?, 14, 24, 1, 'reject_new_only', 1)`
      ).bind(
        TENANT,
        JSON.stringify([
          'partner.example',
          'keep.example',
          'dropped.example',
          'allowed.example',
        ])
      ),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)"
      ).bind(OTHER_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status)
         VALUES
           (?, ?, 'ag-sys@example.com', 'Admin Guests Sys', 'sys_admin', 'active'),
           (?, ?, 'ag-sec@example.com', 'Admin Guests Sec', 'sec_admin', 'active'),
           (?, ?, 'ag-member@example.com', 'Admin Guests Member', 'member', 'active'),
           (?, ?, 'ag-other-sys@example.com', 'Other Sys', 'sys_admin', 'active')`
      ).bind(
        ADMIN,
        TENANT,
        SEC_ADMIN,
        TENANT,
        MEMBER,
        TENANT,
        OTHER_ADMIN,
        OTHER_TENANT
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (id, tenant_id, parent_id, name, depth, version, classification, created_by)
         VALUES ('ag-parent', ?, NULL, 'Partner Parent', 0, 1, 'internal', ?),
                ('ag-child', ?, 'ag-parent', 'Partner Child', 1, 1, 'internal', ?)`
      ).bind(TENANT, ADMIN, TENANT, ADMIN),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, 'ag-parent', 'ag-parent', 0),
                (?, 'ag-parent', 'ag-child', 1),
                (?, 'ag-child', 'ag-child', 0)`
      ).bind(TENANT, TENANT, TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, classification, created_by, updated_by, created_at, updated_at
         ) VALUES (
           'ag-file-conf', ?, 'ag-child', 'board-secret.pdf', 'pdf',
           'application/pdf', 2048, 'active', 'confidential', ?, ?, ?, ?
         )`
      ).bind(TENANT, ADMIN, ADMIN, isoDaysFromNow(-3), isoDaysFromNow(-3)),
    ]);

    await seedGuest('ag-guest-1', 'guest-one@partner.example', {
      lastLoginAt: isoDaysFromNow(-2),
      displayName: 'Guest One',
      createdAt: isoDaysFromNow(-8),
    });
    await seedGuest('ag-guest-2', 'guest-two@dropped.example', {
      lastLoginAt: null,
      displayName: 'Guest Two',
      createdAt: isoDaysFromNow(-6),
    });
    await seedGuest('ag-guest-expired', 'expired@partner.example', {
      expiresAt: isoDaysFromNow(-2),
      lastLoginAt: isoDaysFromNow(-10),
      displayName: 'Guest Expired',
    });
    await seedGuest('ag-guest-suspended', 'suspended@partner.example', {
      status: 'suspended',
      lastLoginAt: isoDaysFromNow(-20),
      displayName: 'Guest Suspended',
    });
    await seedGuest('ag-guest-offboard', 'offboard@partner.example', {
      lastLoginAt: isoDaysFromNow(-5),
      displayName: 'Guest Offboard',
    });
    await seedGuest('ag-guest-offboarded', 'already-offboarded@partner.example', {
      status: 'suspended',
      offboardedAt: isoDaysFromNow(-1),
      displayName: 'Guest Already Offboarded',
    });
    await seedGuest('ag-guest-domain-keep', 'keep@keep.example', {
      lastLoginAt: isoDaysFromNow(-1),
      displayName: 'Guest Keep',
    });
    await seedGuest('ag-guest-domain-drop', 'drop@dropped.example', {
      lastLoginAt: isoDaysFromNow(-1),
      displayName: 'Guest Drop',
    });
    await seedGuest('ag-guest-formula', 'formula@partner.example', {
      displayName: '=SUM(1,1)',
      lastLoginAt: isoDaysFromNow(-1),
    });
    await seedGuest('ag-other-guest', 'other@partner.example', {
      tenantId: OTHER_TENANT,
      invitedBy: OTHER_ADMIN,
      lastLoginAt: isoDaysFromNow(-1),
    });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO permissions (id, tenant_id, target_type, target_id, grantee_type, grantee_id, role, granted_by, created_at)
         VALUES ('ag-perm-parent', ?, 'folder', 'ag-parent', 'user', 'ag-guest-1', 'viewer', ?, ?),
                ('ag-perm-child', ?, 'folder', 'ag-child', 'user', 'ag-guest-1', 'editor', ?, ?),
                ('ag-perm-file', ?, 'file', 'ag-file-conf', 'user', 'ag-guest-1', 'viewer', ?, ?)`
      ).bind(
        TENANT,
        ADMIN,
        isoDaysFromNow(-8),
        TENANT,
        ADMIN,
        isoDaysFromNow(-8),
        TENANT,
        ADMIN,
        isoDaysFromNow(-8)
      ),
      env.DB.prepare(
        `INSERT INTO sessions (id, tenant_id, user_id, token_hash, expires_at, revoked_at)
         VALUES ('ag-sess-1', ?, 'ag-guest-1', 'hash-sess-1', ?, NULL),
                ('ag-sess-offboard', ?, 'ag-guest-offboard', 'hash-sess-offboard', ?, NULL),
                ('ag-sess-domain-drop', ?, 'ag-guest-domain-drop', 'hash-sess-drop', ?, NULL)`
      ).bind(
        TENANT,
        isoDaysFromNow(5),
        TENANT,
        isoDaysFromNow(5),
        TENANT,
        isoDaysFromNow(5)
      ),
      env.DB.prepare(
        `INSERT INTO guest_otp_challenges (
           id, tenant_id, user_id, email, otp_hash, purpose, expires_at, consumed_at, created_at
         ) VALUES (
           'ag-otp-offboard', ?, 'ag-guest-offboard', 'offboard@partner.example',
           'otp-hash', 'login', ?, NULL, ?
         )`
      ).bind(TENANT, isoDaysFromNow(1), isoDaysFromNow(-1)),
      env.DB.prepare(
        `INSERT INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, classification, created_by, updated_by, created_at, updated_at
         ) VALUES (
           'ag-guest-created-file', ?, 'ag-parent', 'guest-upload.txt', 'txt',
           'text/plain', 128, 'active', 'internal', 'ag-guest-offboard', ?, ?, ?
         )`
      ).bind(TENANT, ADMIN, isoDaysFromNow(-2), isoDaysFromNow(-2)),
    ]);

    await seedInvitation({
      id: 'ag-inv-1-pending',
      userId: 'ag-guest-1',
      email: 'guest-one@partner.example',
      targetId: 'ag-child',
      role: 'editor',
    });
    await seedInvitation({
      id: 'ag-inv-1-accepted',
      userId: 'ag-guest-1',
      email: 'guest-one@partner.example',
      targetId: 'ag-parent',
      status: 'accepted',
      createdAt: isoDaysFromNow(-8),
    });
    await seedInvitation({
      id: 'ag-inv-2-pending',
      userId: 'ag-guest-2',
      email: 'guest-two@dropped.example',
      targetId: 'ag-parent',
      createdAt: isoDaysFromNow(-1),
    });
    await seedInvitation({
      id: 'ag-inv-offboard-pending',
      userId: 'ag-guest-offboard',
      email: 'offboard@partner.example',
      targetId: 'ag-child',
      role: 'editor',
    });

    // Detail audit timeline rows (target id + guest metadata are both matched).
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_email, actor_ip, action, target_type, target_id, status, metadata_json, created_at)
         VALUES ('ag-audit-1', ?, ?, 'ag-sys@example.com', '127.0.0.1', 'guest.invite',
                 'guest_invitation', 'ag-inv-1-pending', 'allowed', ?, ?)`
      ).bind(
        TENANT,
        ADMIN,
        JSON.stringify({ guestUserId: 'ag-guest-1' }),
        isoDaysFromNow(-1)
      ),
      env.DB.prepare(
        `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_email, actor_ip, action, target_type, target_id, status, metadata_json, created_at)
         VALUES ('ag-audit-2', ?, ?, 'ag-sys@example.com', '127.0.0.1', 'admin.guest.suspend',
                 'user', 'ag-guest-suspended', 'allowed', '{}', ?)`
      ).bind(TENANT, ADMIN, isoDaysFromNow(-2)),
    ]);
  });

  it('lists guests with filters, sorting, paging, aggregations and CSV injection defence', async () => {
    const all = await call<{
      guests: Array<Record<string, unknown>>;
      total: number;
      nextOffset: number | null;
      summary: {
        total: number;
        byStatus: Record<string, number>;
        byDomain: Array<Record<string, unknown>>;
        byInviter: Array<Record<string, unknown>>;
      };
      aggregations: Record<string, unknown>;
    }>('/api/admin/guests?limit=200', SEC_ADMIN, { role: 'sec_admin' });
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThanOrEqual(9);
    expect(all.body.guests.every((guest) => guest.id !== 'ag-other-guest')).toBe(true);
    expect(all.body.summary.byStatus.all).toBe(all.body.total);
    expect(all.body.summary.byStatus.offboarded).toBe(1);
    expect(all.body.summary.byStatus.expired).toBeGreaterThanOrEqual(1);
    expect(all.body.summary.byStatus.pending_invite).toBeGreaterThanOrEqual(1);
    expect(all.body.aggregations).toEqual(all.body.summary);

    const partnerDomain = all.body.summary.byDomain.find(
      (row) => row.domain === 'partner.example'
    );
    expect(partnerDomain).toBeTruthy();
    expect(partnerDomain?.allowedByPolicy).toBe(true);

    const inviter = all.body.summary.byInviter.find(
      (row) => row.inviterId === ADMIN
    );
    expect(inviter).toBeTruthy();
    expect(Number(inviter?.count)).toBeGreaterThan(0);

    // query matches email / display name / external_org / id
    const byEmail = await call<{ guests: Array<{ id: string }> }>(
      '/api/admin/guests?query=guest-one%40partner.example',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(byEmail.body.guests.map((guest) => guest.id)).toContain('ag-guest-1');

    const byId = await call<{ guests: Array<{ id: string }> }>(
      '/api/admin/guests?query=ag-guest-2',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(byId.body.guests.map((guest) => guest.id)).toEqual(['ag-guest-2']);

    const byOrg = await call<{ guests: Array<{ id: string }> }>(
      '/api/admin/guests?query=Partner%20A',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(byOrg.body.guests.length).toBeGreaterThan(0);

    const expired = await call<{ guests: Array<{ status: string }> }>(
      '/api/admin/guests?status=expired',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(expired.body.guests.length).toBeGreaterThanOrEqual(1);
    expect(expired.body.guests.every((guest) => guest.status === 'expired')).toBe(true);

    const offboarded = await call<{ guests: Array<{ id: string; offboardedAt: string }> }>(
      '/api/admin/guests?status=offboarded',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(offboarded.body.guests.map((guest) => guest.id)).toEqual([
      'ag-guest-offboarded',
    ]);
    expect(offboarded.body.guests[0].offboardedAt).toBeTruthy();

    const byDomain = await call<{ guests: Array<{ id: string; domain: string }> }>(
      '/api/admin/guests?domain=keep.example',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(byDomain.body.guests.map((guest) => guest.id)).toEqual([
      'ag-guest-domain-keep',
    ]);

    const byInviter = await call<{ guests: Array<{ invitedBy: string }> }>(
      `/api/admin/guests?invitedBy=${encodeURIComponent('ag-sys@example.com')}`,
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(byInviter.body.guests.length).toBeGreaterThan(0);
    expect(byInviter.body.guests.every((guest) => guest.invitedBy === ADMIN)).toBe(
      true
    );

    const expiresBefore = await call<{ guests: Array<{ id: string }> }>(
      `/api/admin/guests?expiresBefore=${encodeURIComponent(isoDaysFromNow(1))}`,
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(expiresBefore.body.guests.map((guest) => guest.id)).toContain(
      'ag-guest-expired'
    );

    const sorted = await call<{ guests: Array<{ email: string }> }>(
      '/api/admin/guests?sortBy=email&sortDir=asc&limit=200',
      ADMIN,
      { role: 'sys_admin' }
    );
    const emails = sorted.body.guests.map((guest) => guest.email);
    expect([...emails].sort()).toEqual(emails);

    const page = await call<{ guests: Array<{ id: string }>; nextOffset: number | null }>(
      '/api/admin/guests?limit=2&offset=0&sortBy=createdAt&sortDir=desc',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(page.body.guests).toHaveLength(2);
    expect(page.body.nextOffset).toBe(2);

    const invalidSort = await call<{ code?: string }>(
      '/api/admin/guests?sortBy=password',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(invalidSort.status).toBe(400);
    expect(invalidSort.body.code).toBe('INVALID_GUEST_SORT');

    const csv = await call<string>('/api/admin/guests?format=csv&limit=200', ADMIN, {
      role: 'sys_admin',
    });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.headers.get('content-disposition')).toContain('admin-guests.csv');
    expect(String((csv.body as { raw?: string }).raw ?? '')).toContain(
      'email,display_name'
    );
    expect(String((csv.body as { raw?: string }).raw ?? '')).toContain(
      "'=SUM(1,1)"
    );
  });

  it('returns DLP-safe detail with direct/inherited permissions and CSV/JSON exports', async () => {
    const detail = await call<{
      guest: Record<string, unknown>;
      invitations: Array<Record<string, unknown>>;
      permissions: {
        direct: Array<Record<string, unknown>>;
        inherited: Array<Record<string, unknown>>;
        directCount: number;
        inheritedCount: number;
      };
      sharedItems: Array<Record<string, unknown>>;
      recentAuditLogs: Array<Record<string, unknown>>;
      dlp: Record<string, unknown>;
    }>('/api/admin/guests/ag-guest-1', SEC_ADMIN, { role: 'sec_admin' });
    expect(detail.status).toBe(200);
    expect(detail.body.guest).toMatchObject({
      id: 'ag-guest-1',
      email: 'guest-one@partner.example',
      externalOrg: 'Partner A',
      invitedBy: ADMIN,
      invitedByName: 'Admin Guests Sys',
      invitedByEmail: 'ag-sys@example.com',
      status: 'active',
      offboardedAt: null,
      domain: 'partner.example',
      domainAllowedByPolicy: true,
    });
    expect(detail.body.guest.expiresAt).toBeTruthy();
    expect(detail.body.guest.lastLoginAt).toBeTruthy();

    const childDirect = detail.body.permissions.direct.find(
      (permission) =>
        permission.targetId === 'ag-child' &&
        permission.role === 'editor' &&
        permission.inherited === false
    );
    expect(childDirect).toBeTruthy();
    expect(childDirect?.synthesizedRole).toBe('editor');

    const childInherited = detail.body.permissions.inherited.find(
      (permission) =>
        permission.targetId === 'ag-child' &&
        permission.role === 'viewer' &&
        permission.inheritedFromName === 'Partner Parent'
    );
    expect(childInherited).toBeTruthy();
    expect(childInherited?.synthesizedRole).toBe('editor');
    expect(detail.body.permissions.directCount).toBeGreaterThan(0);
    expect(detail.body.permissions.inheritedCount).toBeGreaterThan(0);

    const confidential = detail.body.sharedItems.find(
      (item) => item.id === 'ag-file-conf'
    );
    expect(confidential).toMatchObject({
      itemType: 'file',
      name: 'board-secret.pdf',
      classification: 'confidential',
      dlpProtected: true,
    });
    expect(typeof confidential?.pathLabel).toBe('string');
    expect(Array.isArray(confidential?.capabilities)).toBe(true);
    const serialized = JSON.stringify(detail.body);
    expect(serialized).not.toContain('r2_object_key');
    expect(serialized).not.toContain('tenants/');
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('ai_reason');
    expect(serialized).not.toContain('signedUrl');
    expect(detail.body.dlp.confidentialMetadataOnly).toBe(true);
    expect(
      detail.body.recentAuditLogs.some((log) => log.action === 'guest.invite')
    ).toBe(true);

    const csv = await call<string>(
      '/api/admin/guests/ag-guest-1?format=csv',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(String((csv.body as { raw?: string }).raw ?? '')).toContain(
      'record_type'
    );
    expect(String((csv.body as { raw?: string }).raw ?? '')).toContain(
      'permission'
    );
    expect(String((csv.body as { raw?: string }).raw ?? '')).toContain(
      'board-secret.pdf'
    );
    expect(String((csv.body as { raw?: string }).raw ?? '')).not.toContain(
      'tenants/'
    );

    const permissionsExport = await call<string>(
      '/api/admin/guests/ag-guest-1?export=permissions',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(permissionsExport.status).toBe(200);
    expect(
      String((permissionsExport.body as { raw?: string }).raw ?? '')
    ).toContain('shared_item');

    const jsonExport = await call<Record<string, unknown>>(
      '/api/admin/guests/ag-guest-1?download=1',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(jsonExport.status).toBe(200);
    expect(jsonExport.headers.get('content-disposition')).toContain(
      'admin-guest-ag-guest-1.json'
    );
    expect(
      (jsonExport.body.guest as { email: string }).email
    ).toBe('guest-one@partner.example');

    const missing = await call<{ code?: string }>(
      '/api/admin/guests/does-not-exist',
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('GUEST_NOT_FOUND');
  });

  it('enforces sys/sec/member/guest RBAC and cross-tenant non-disclosure', async () => {
    const readEndpoints = [
      '/api/admin/guests',
      '/api/admin/guests/ag-guest-1',
    ];
    for (const endpoint of readEndpoints) {
      const member = await call(endpoint, MEMBER);
      expect(member.status).toBe(403);

      const guest = await call(endpoint, 'ag-guest-1', { userType: 'guest' });
      expect(guest.status).toBe(403);
      expect((guest.body as { code?: string }).code).toBe('GUEST_FORBIDDEN');
    }

    const writeEndpoints = [
      { path: '/api/admin/guests/ag-guest-1/suspend', method: 'POST' },
      { path: '/api/admin/guests/ag-guest-1/resume', method: 'POST' },
      { path: '/api/admin/guests/ag-guest-1/resend-invite', method: 'POST' },
      { path: '/api/admin/guests/ag-guest-1', method: 'DELETE' },
      { path: '/api/admin/policies', method: 'PATCH', body: {} },
    ];
    for (const endpoint of writeEndpoints) {
      for (const actor of [
        { id: MEMBER, userType: 'member' as const },
        { id: 'ag-guest-1', userType: 'guest' as const },
      ]) {
        const response = await call(endpoint.path, actor.id, {
          method: endpoint.method,
          body: endpoint.body,
          userType: actor.userType,
        });
        expect(
          response.status,
          `${actor.userType} ${endpoint.method} ${endpoint.path}`
        ).toBe(403);
      }
    }

    const secRead = await call('/api/admin/guests', SEC_ADMIN, {
      role: 'sec_admin',
    });
    expect(secRead.status).toBe(200);

    const secResume = await call('/api/admin/guests/ag-guest-1/resume', SEC_ADMIN, {
      role: 'sec_admin',
      method: 'POST',
      body: {},
    });
    expect(secResume.status).toBe(403);
    expect((secResume.body as { code?: string }).code).toBe('SYS_ADMIN_REQUIRED');

    const secResend = await call(
      '/api/admin/guests/ag-guest-1/resend-invite',
      SEC_ADMIN,
      { role: 'sec_admin', method: 'POST', body: {} }
    );
    expect(secResend.status).toBe(403);

    const secOffboard = await call('/api/admin/guests/ag-guest-1', SEC_ADMIN, {
      role: 'sec_admin',
      method: 'DELETE',
    });
    expect(secOffboard.status).toBe(403);

    const secPolicy = await call('/api/admin/policies', SEC_ADMIN, {
      role: 'sec_admin',
      method: 'PATCH',
      body: { externalDomainExistingGuestMode: 'suspend_existing' },
    });
    expect(secPolicy.status).toBe(403);

    const crossTenantDetail = await call<{ code?: string }>(
      '/api/admin/guests/ag-guest-1',
      OTHER_ADMIN,
      { role: 'sys_admin', tenantId: OTHER_TENANT }
    );
    expect(crossTenantDetail.status).toBe(404);
    expect(crossTenantDetail.body.code).toBe('GUEST_NOT_FOUND');

    const crossTenantSuspend = await call<{ code?: string }>(
      '/api/admin/guests/ag-guest-1/suspend',
      OTHER_ADMIN,
      {
        role: 'sys_admin',
        tenantId: OTHER_TENANT,
        method: 'POST',
        body: {},
      }
    );
    expect(crossTenantSuspend.status).toBe(404);
    expect(crossTenantSuspend.body.code).toBe('GUEST_NOT_FOUND');

    const otherList = await call<{ guests: Array<{ id: string }> }>(
      '/api/admin/guests',
      OTHER_ADMIN,
      { role: 'sys_admin', tenantId: OTHER_TENANT }
    );
    expect(otherList.body.guests.map((guest) => guest.id)).toEqual([
      'ag-other-guest',
    ]);

    const escalation = await call('/api/admin/guests/ag-guest-formula/suspend', ADMIN, {
      role: 'sys_admin',
      method: 'POST',
      body: { role: 'sys_admin', userType: 'member' },
    });
    expect(escalation.status).toBe(200);
    const guestRow = await env.DB.prepare(
      "SELECT role, user_type FROM users WHERE id = 'ag-guest-formula'"
    ).first<{ role: string; user_type: string }>();
    expect(guestRow).toEqual({ role: 'member', user_type: 'guest' });
  });

  it('suspends with sec_admin, revokes sessions, replays idempotently and resumes via sys_admin', async () => {
    const suspended = await call<{
      ok: boolean;
      sessionsRevoked: number;
      replayed?: boolean;
    }>('/api/admin/guests/ag-guest-1/suspend', SEC_ADMIN, {
      role: 'sec_admin',
      method: 'POST',
      body: { idempotencyKey: 'ag-suspend-key-1' },
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.ok).toBe(true);
    expect(suspended.body.sessionsRevoked).toBe(1);

    const row = await env.DB.prepare(
      "SELECT status FROM users WHERE id = 'ag-guest-1'"
    ).first<{ status: string }>();
    expect(row?.status).toBe('suspended');
    const session = await env.DB.prepare(
      "SELECT revoked_at FROM sessions WHERE id = 'ag-sess-1'"
    ).first<{ revoked_at: string | null }>();
    expect(session?.revoked_at).toBeTruthy();
    expect(
      await env.DB.prepare(
        "SELECT id FROM audit_logs WHERE action = 'admin.guest.suspend' AND target_id = 'ag-guest-1'"
      ).first()
    ).toBeTruthy();
    expect(
      await env.DB.prepare(
        "SELECT seq FROM sync_changes WHERE action = 'admin.guest.suspend' AND entity_id = 'ag-guest-1'"
      ).first()
    ).toBeTruthy();

    const auditCountBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM audit_logs WHERE action = 'admin.guest.suspend' AND target_id = 'ag-guest-1'"
    ).first<{ cnt: number }>();

    const replay = await call<{ replayed?: boolean }>(
      '/api/admin/guests/ag-guest-1/suspend',
      SEC_ADMIN,
      {
        role: 'sec_admin',
        method: 'POST',
        body: { idempotencyKey: 'ag-suspend-key-1' },
      }
    );
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    const auditCountAfter = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM audit_logs WHERE action = 'admin.guest.suspend' AND target_id = 'ag-guest-1'"
    ).first<{ cnt: number }>();
    expect(auditCountAfter?.cnt).toBe(auditCountBefore?.cnt);

    const conflict = await call<{ code?: string }>(
      '/api/admin/guests/ag-guest-2/suspend',
      SEC_ADMIN,
      {
        role: 'sec_admin',
        method: 'POST',
        body: { idempotencyKey: 'ag-suspend-key-1' },
      }
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');

    const resume = await call<{ ok: boolean; guest: { expiresAt: string } }>(
      '/api/admin/guests/ag-guest-1/resume',
      ADMIN,
      {
        role: 'sys_admin',
        method: 'POST',
        body: { extendDays: 10 },
      }
    );
    expect(resume.status).toBe(200);
    expect(resume.body.ok).toBe(true);
    const resumed = await env.DB.prepare(
      "SELECT status, role, user_type FROM users WHERE id = 'ag-guest-1'"
    ).first<{ status: string; role: string; user_type: string }>();
    expect(resumed).toEqual({
      status: 'active',
      role: 'member',
      user_type: 'guest',
    });
    expect(
      await env.DB.prepare(
        "SELECT id FROM audit_logs WHERE action = 'admin.guest.resume' AND target_id = 'ag-guest-1'"
      ).first()
    ).toBeTruthy();
  });

  it('rejects resume for expired and offboarded guests unless expiry is extended', async () => {
    const expired = await call<{ code?: string }>(
      '/api/admin/guests/ag-guest-expired/resume',
      ADMIN,
      { role: 'sys_admin', method: 'POST', body: {} }
    );
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe('GUEST_ACCOUNT_EXPIRED');

    const extended = await call<{ guest: { expiresAt: string } }>(
      '/api/admin/guests/ag-guest-expired/resume',
      ADMIN,
      { role: 'sys_admin', method: 'POST', body: { extendDays: 7 } }
    );
    expect(extended.status).toBe(200);
    expect(Date.parse(extended.body.guest.expiresAt)).toBeGreaterThan(Date.now());

    const offboardResume = await call<{ code?: string }>(
      '/api/admin/guests/ag-guest-offboarded/resume',
      ADMIN,
      { role: 'sys_admin', method: 'POST', body: { extendDays: 30 } }
    );
    expect(offboardResume.status).toBe(409);
    expect(offboardResume.body.code).toBe('GUEST_OFFBOARDED');

    const invalidExpiry = await call<{ code?: string }>(
      '/api/admin/guests/ag-guest-suspended/resume',
      ADMIN,
      {
        role: 'sys_admin',
        method: 'POST',
        body: { expiresAt: 'not-a-date' },
      }
    );
    expect(invalidExpiry.status).toBe(400);
    expect(invalidExpiry.body.code).toBe('INVALID_GUEST_EXPIRY');
  });

  it('resends the latest pending invitation, rotates the token hash and audits it', async () => {
    const before = await env.DB.prepare(
      "SELECT token_hash, resend_count FROM guest_invitations WHERE id = 'ag-inv-2-pending'"
    ).first<{ token_hash: string; resend_count: number }>();

    const resent = await call<{
      ok: boolean;
      invitationId: string;
      resendCount: number;
      mailPreview: { subject: string; bodyPreview: string };
    }>('/api/admin/guests/ag-guest-2/resend-invite', ADMIN, {
      role: 'sys_admin',
      method: 'POST',
      body: {},
    });
    expect(resent.status).toBe(200);
    expect(resent.body.invitationId).toBe('ag-inv-2-pending');
    expect(resent.body.resendCount).toBe(before!.resend_count + 1);
    expect(resent.body.mailPreview.subject).toContain('外部ゲスト');
    expect(resent.body.mailPreview.bodyPreview).toContain('招待リンク');
    expect(JSON.stringify(resent.body)).not.toContain('token_hash');

    const after = await env.DB.prepare(
      "SELECT token_hash, resend_count, status FROM guest_invitations WHERE id = 'ag-inv-2-pending'"
    ).first<{ token_hash: string; resend_count: number; status: string }>();
    expect(after?.token_hash).not.toBe(before?.token_hash);
    expect(after?.resend_count).toBe(before!.resend_count + 1);
    expect(after?.status).toBe('pending');

    expect(
      await env.DB.prepare(
        "SELECT id FROM audit_logs WHERE action = 'admin.guest.resend_invite' AND target_id = 'ag-inv-2-pending'"
      ).first()
    ).toBeTruthy();
    const mail = await env.DB.prepare(
      "SELECT token FROM guest_mail_sink WHERE to_email = 'guest-two@dropped.example' ORDER BY created_at DESC LIMIT 1"
    ).first<{ token: string | null }>();
    expect(mail?.token).toBeTruthy();

    const noPending = await call<{ code?: string }>(
      '/api/admin/guests/ag-guest-suspended/resend-invite',
      ADMIN,
      { role: 'sys_admin', method: 'POST', body: {} }
    );
    expect(noPending.status).toBe(409);
    expect(noPending.body.code).toBe('NO_PENDING_INVITATION');
  });

  it('atomically offboards a guest while preserving FK rows and blocking resume', async () => {
    const response = await call<{
      ok: boolean;
      sessionsRevoked: number;
      invitationsRevoked: number;
      otpChallengesConsumed: number;
      permissionsDeleted: number;
      guest: { offboardedAt: string; status: string };
    }>('/api/admin/guests/ag-guest-offboard', ADMIN, {
      role: 'sys_admin',
      method: 'DELETE',
      body: { idempotencyKey: 'ag-offboard-key-1' },
    });
    expect(response.status).toBe(200);
    expect(response.body.sessionsRevoked).toBe(1);
    expect(response.body.invitationsRevoked).toBe(1);
    expect(response.body.otpChallengesConsumed).toBe(1);
    expect(response.body.guest.status).toBe('suspended');
    expect(response.body.guest.offboardedAt).toBeTruthy();

    const user = await env.DB.prepare(
      `SELECT status, offboarded_at, offboarded_by, role, user_type
         FROM users WHERE id = 'ag-guest-offboard'`
    ).first<{
      status: string;
      offboarded_at: string | null;
      offboarded_by: string | null;
      role: string;
      user_type: string;
    }>();
    expect(user).toMatchObject({
      status: 'suspended',
      offboarded_by: ADMIN,
      role: 'member',
      user_type: 'guest',
    });
    expect(user?.offboarded_at).toBeTruthy();

    const session = await env.DB.prepare(
      "SELECT revoked_at FROM sessions WHERE id = 'ag-sess-offboard'"
    ).first<{ revoked_at: string | null }>();
    expect(session?.revoked_at).toBeTruthy();
    const invitation = await env.DB.prepare(
      "SELECT status, revoked_at, revoked_by FROM guest_invitations WHERE id = 'ag-inv-offboard-pending'"
    ).first<{
      status: string;
      revoked_at: string | null;
      revoked_by: string | null;
    }>();
    expect(invitation).toMatchObject({
      status: 'revoked',
      revoked_by: ADMIN,
    });
    expect(invitation?.revoked_at).toBeTruthy();
    const otp = await env.DB.prepare(
      "SELECT consumed_at FROM guest_otp_challenges WHERE id = 'ag-otp-offboard'"
    ).first<{ consumed_at: string | null }>();
    expect(otp?.consumed_at).toBeTruthy();
    expect(
      await env.DB.prepare(
        "SELECT id FROM permissions WHERE grantee_type = 'user' AND grantee_id = 'ag-guest-offboard'"
      ).first()
    ).toBeNull();

    // FK safety: the guest-created file still references the (kept) users row.
    const file = await env.DB.prepare(
      "SELECT created_by FROM files WHERE id = 'ag-guest-created-file'"
    ).first<{ created_by: string }>();
    expect(file?.created_by).toBe('ag-guest-offboard');

    expect(
      await env.DB.prepare(
        "SELECT id FROM audit_logs WHERE action = 'admin.guest.offboard' AND target_id = 'ag-guest-offboard'"
      ).first()
    ).toBeTruthy();
    expect(
      await env.DB.prepare(
        "SELECT seq FROM sync_changes WHERE action = 'admin.guest.offboard' AND entity_id = 'ag-guest-offboard'"
      ).first()
    ).toBeTruthy();

    const resume = await call<{ code?: string }>(
      '/api/admin/guests/ag-guest-offboard/resume',
      ADMIN,
      { role: 'sys_admin', method: 'POST', body: { extendDays: 30 } }
    );
    expect(resume.status).toBe(409);
    expect(resume.body.code).toBe('GUEST_OFFBOARDED');

    const suspendAgain = await call<{ code?: string }>(
      '/api/admin/guests/ag-guest-offboard/suspend',
      ADMIN,
      { role: 'sys_admin', method: 'POST', body: {} }
    );
    expect(suspendAgain.status).toBe(409);
    expect(suspendAgain.body.code).toBe('GUEST_OFFBOARDED');

    const replay = await call<{ replayed?: boolean; sessionsRevoked: number }>(
      '/api/admin/guests/ag-guest-offboard',
      ADMIN,
      {
        role: 'sys_admin',
        method: 'DELETE',
        body: { idempotencyKey: 'ag-offboard-key-1' },
      }
    );
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.sessionsRevoked).toBe(1);
  });

  it('rejects wildcard domains and applies reject_new_only vs suspend_existing', async () => {
    const wildcard = await call<{ code?: string; wildcardDomains?: string[] }>(
      '/api/admin/policies',
      ADMIN,
      {
        role: 'sys_admin',
        method: 'PATCH',
        body: { externalDomainAllowlist: ['*.example.com'] },
      }
    );
    expect(wildcard.status).toBe(400);
    expect(wildcard.body.code).toBe('WILDCARD_DOMAIN_NOT_ALLOWED');
    expect(wildcard.body.wildcardDomains).toEqual(['*.example.com']);

    const bareWildcard = await call<{ code?: string }>(
      '/api/admin/policies',
      ADMIN,
      {
        role: 'sys_admin',
        method: 'PATCH',
        body: { externalDomainAllowlist: ['keep.example', '*'] },
      }
    );
    expect(bareWildcard.status).toBe(400);
    expect(bareWildcard.body.code).toBe('WILDCARD_DOMAIN_NOT_ALLOWED');

    const rejectMode = await call<{
      policy: { externalDomainExistingGuestMode: string };
      externalDomainPolicy: {
        mode: string;
        affectedGuestCount: number;
        suspendedGuestIds: string[];
      };
    }>('/api/admin/policies', ADMIN, {
      role: 'sys_admin',
      method: 'PATCH',
      body: {
        externalDomainAllowlist: ['partner.example', 'keep.example'],
        externalDomainExistingGuestMode: 'reject_new_only',
      },
    });
    expect(rejectMode.status).toBe(200);
    expect(rejectMode.body.policy.externalDomainExistingGuestMode).toBe(
      'reject_new_only'
    );
    expect(rejectMode.body.externalDomainPolicy.mode).toBe('reject_new_only');
    expect(rejectMode.body.externalDomainPolicy.affectedGuestCount).toBeGreaterThan(
      0
    );
    expect(rejectMode.body.externalDomainPolicy.suspendedGuestIds).toEqual([]);
    const stillActive = await env.DB.prepare(
      "SELECT status FROM users WHERE id = 'ag-guest-domain-drop'"
    ).first<{ status: string }>();
    expect(stillActive?.status).toBe('active');

    const suspendMode = await call<{
      policy: { externalDomainExistingGuestMode: string };
      externalDomainPolicy: {
        mode: string;
        affectedGuestCount: number;
        suspendedGuestIds: string[];
      };
    }>('/api/admin/policies', ADMIN, {
      role: 'sys_admin',
      method: 'PATCH',
      body: {
        externalDomainAllowlist: ['partner.example', 'keep.example'],
        externalDomainExistingGuestMode: 'suspend_existing',
      },
    });
    expect(suspendMode.status).toBe(200);
    expect(suspendMode.body.externalDomainPolicy.mode).toBe('suspend_existing');
    expect(suspendMode.body.externalDomainPolicy.suspendedGuestIds).toContain(
      'ag-guest-domain-drop'
    );
    expect(suspendMode.body.externalDomainPolicy.suspendedGuestIds).not.toContain(
      'ag-guest-domain-keep'
    );

    const dropped = await env.DB.prepare(
      "SELECT status FROM users WHERE id = 'ag-guest-domain-drop'"
    ).first<{ status: string }>();
    expect(dropped?.status).toBe('suspended');
    const kept = await env.DB.prepare(
      "SELECT status FROM users WHERE id = 'ag-guest-domain-keep'"
    ).first<{ status: string }>();
    expect(kept?.status).toBe('active');
    const droppedSession = await env.DB.prepare(
      "SELECT revoked_at FROM sessions WHERE id = 'ag-sess-domain-drop'"
    ).first<{ revoked_at: string | null }>();
    expect(droppedSession?.revoked_at).toBeTruthy();

    expect(
      await env.DB.prepare(
        "SELECT id FROM audit_logs WHERE action = 'admin.policy_updated' ORDER BY created_at DESC LIMIT 1"
      ).first()
    ).toBeTruthy();
    expect(
      await env.DB.prepare(
        "SELECT id FROM audit_logs WHERE action = 'admin.guest.suspend' AND target_id = 'ag-guest-domain-drop'"
      ).first()
    ).toBeTruthy();
    expect(
      await env.DB.prepare(
        "SELECT seq FROM sync_changes WHERE action = 'admin.guest.suspend' AND entity_id = 'ag-guest-domain-drop'"
      ).first()
    ).toBeTruthy();
    expect(
      await env.DB.prepare(
        "SELECT seq FROM sync_changes WHERE action = 'admin.policy_updated' AND entity_type = 'policy' ORDER BY seq DESC LIMIT 1"
      ).first()
    ).toBeTruthy();

    const readPolicy = await call<{
      policy: { externalDomainExistingGuestMode: string; externalDomainAllowlist: string[] };
    }>('/api/admin/policies', SEC_ADMIN, { role: 'sec_admin' });
    expect(readPolicy.status).toBe(200);
    expect(readPolicy.body.policy.externalDomainExistingGuestMode).toBe(
      'suspend_existing'
    );
    expect(readPolicy.body.policy.externalDomainAllowlist).toEqual([
      'keep.example',
      'partner.example',
    ]);
  });
});
