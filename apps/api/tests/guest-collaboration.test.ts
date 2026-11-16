import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-guest-collab';
const OTHER_TENANT = 'tenant-guest-collab-other';
const ADMIN = 'collab-admin';
const SEC_ADMIN = 'collab-sec';
const MEMBER = 'collab-member';
const OUTSIDER = 'collab-outsider';
const OTHER_ADMIN = 'collab-other-admin';
const APP_ORIGIN = 'http://127.0.0.1:8787';

const GUEST_POLICY = {
  allowExternalCollaborators: true,
  externalDomainAllowlist: ['partner.example'],
  guestInvitationExpiryDays: 7,
  guestSessionMaxHours: 4,
  allowGuestElevatedRoles: true,
  advancedRolesEnabled: true,
  invitePolicy: 'editors',
};

type UserRole = 'sys_admin' | 'sec_admin' | 'member';
type UserType = 'member' | 'guest';

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  setCookie: string | null;
}

function buildTestEnv(overrides: Partial<OidcEnv> = {}): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN,
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'guest-collab-proxy-secret',
    DEFAULT_TENANT_ID: TENANT,
    ...overrides,
  } as OidcEnv;
}

function devHeaders(
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

function extractLocalSessionCookie(headers: Headers): string | null {
  const cookies = headers.getSetCookie?.() ?? [];
  const list =
    cookies.length > 0
      ? cookies
      : (headers.get('set-cookie') ?? '').split(/,(?=\s*[^;=]+=)/);
  for (const cookie of list) {
    if (cookie.startsWith('files_session_local=')) {
      return cookie.split(';')[0];
    }
  }
  return null;
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
  } = {}
): Promise<ApiResponse<T>> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers: devHeaders(
        userId,
        options.role ?? 'member',
        options.tenantId ?? TENANT,
        options.userType ?? 'member'
      ),
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
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
  return {
    status: response.status,
    body: body as T,
    setCookie: extractLocalSessionCookie(response.headers),
  };
}

async function callWithCookie<T = Record<string, unknown>>(
  path: string,
  cookie: string,
  options: { method?: string; body?: unknown } = {}
): Promise<ApiResponse<T>> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Cookie: cookie,
        Origin: APP_ORIGIN,
        'Content-Type': 'application/json',
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
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
  return {
    status: response.status,
    body: body as T,
    setCookie: extractLocalSessionCookie(response.headers),
  };
}

async function callPublic<T = Record<string, unknown>>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<ApiResponse<T>> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
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
  return {
    status: response.status,
    body: body as T,
    setCookie: extractLocalSessionCookie(response.headers),
  };
}

let folderCounter = 0;

async function createFolder(
  ownerId = ADMIN,
  parentId: string | null = null,
  classification: 'internal' | 'confidential' = 'internal'
): Promise<{ id: string; name: string }> {
  folderCounter += 1;
  const id = `collab-folder-${folderCounter}-${crypto.randomUUID().slice(0, 6)}`;
  const name = `Collab Folder ${folderCounter}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO folders (
       id, tenant_id, parent_id, name, depth, version, classification,
       created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  )
    .bind(
      id,
      TENANT,
      parentId,
      name,
      parentId ? 1 : 0,
      classification,
      ownerId,
      now,
      now
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
     VALUES (?, ?, ?, 0)`
  )
    .bind(TENANT, id, id)
    .run();
  if (parentId) {
    await env.DB.prepare(
      `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
       SELECT tenant_id, ancestor_id, ?, depth + 1
         FROM folder_closures
        WHERE tenant_id = ? AND descendant_id = ?`
    )
      .bind(id, TENANT, parentId)
      .run();
  }
  await env.DB.prepare(
    `INSERT INTO permissions (
       id, tenant_id, target_type, target_id, grantee_type, grantee_id,
       role, granted_by, created_at
     ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)`
  )
    .bind(crypto.randomUUID(), TENANT, id, ownerId, ownerId, now)
    .run();
  return { id, name };
}

async function createFile(
  folderId: string,
  name: string,
  classification: 'internal' | 'confidential' = 'internal'
): Promise<{ id: string; name: string }> {
  const id = `collab-file-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO files (
       id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
       upload_state, classification, created_by, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'txt', 'text/plain', 24, 'active', ?, ?, ?, ?, ?)`
  )
    .bind(id, TENANT, folderId, name, classification, ADMIN, ADMIN, now, now)
    .run();
  return { id, name };
}

async function uploadAsAdmin(
  folderId: string,
  name: string
): Promise<string> {
  const payload = new TextEncoder().encode('guest collaboration download');
  const initResponse = await app.fetch(
    new Request(`${APP_ORIGIN}/api/files/upload-init`, {
      method: 'POST',
      headers: devHeaders(ADMIN, 'sys_admin'),
      body: JSON.stringify({
        folderId,
        fileName: name,
        mimeType: 'text/plain',
        sizeBytes: payload.byteLength,
      }),
    }),
    buildTestEnv({
      JOBS_QUEUE: { send: async () => undefined } as unknown as Queue,
    })
  );
  expect(initResponse.status).toBe(201);
  const init = (await initResponse.json()) as {
    fileId: string;
    versionId: string;
    uploadUrl: string;
    requiredHeaders?: Record<string, string>;
  };
  const put = await app.fetch(
    new Request(`${APP_ORIGIN}${init.uploadUrl}`, {
      method: 'PUT',
      headers: init.requiredHeaders,
      body: payload,
    }),
    buildTestEnv()
  );
  expect(put.status).toBe(200);
  const complete = await app.fetch(
    new Request(`${APP_ORIGIN}/api/files/upload-complete`, {
      method: 'POST',
      headers: devHeaders(ADMIN, 'sys_admin'),
      body: JSON.stringify({ fileId: init.fileId, versionId: init.versionId }),
    }),
    buildTestEnv({
      JOBS_QUEUE: { send: async () => undefined } as unknown as Queue,
    })
  );
  expect(complete.status).toBe(200);
  return init.fileId;
}

async function setTenantPolicy(): Promise<void> {  await env.DB.prepare(
    `UPDATE tenant_policies
        SET allow_external_collaborators = ?,
            external_domain_allowlist_json = ?,
            guest_invitation_expiry_days = ?,
            guest_session_max_hours = ?,
            allow_guest_elevated_roles = ?,
            advanced_roles_enabled = ?,
            invite_policy = ?
      WHERE tenant_id = ?`
  )
    .bind(
      GUEST_POLICY.allowExternalCollaborators ? 1 : 0,
      JSON.stringify(GUEST_POLICY.externalDomainAllowlist),
      GUEST_POLICY.guestInvitationExpiryDays,
      GUEST_POLICY.guestSessionMaxHours,
      GUEST_POLICY.allowGuestElevatedRoles ? 1 : 0,
      GUEST_POLICY.advancedRolesEnabled ? 1 : 0,
      GUEST_POLICY.invitePolicy,
      TENANT
    )
    .run();
}

interface DevMail {
  kind: 'guest_invitation' | 'guest_otp';
  to: string;
  token: string | null;
  otpCode: string | null;
  acceptUrl: string | null;
}

async function listMails(to: string, kind?: string): Promise<DevMail[]> {
  const query = new URLSearchParams({ to });
  if (kind) query.set('kind', kind);
  const response = await call<{ mails: DevMail[] }>(
    `/auth/dev-guest-mails?${query.toString()}`,
    ADMIN,
    { role: 'sys_admin' }
  );
  expect(response.status).toBe(200);
  return response.body.mails;
}

async function latestMail(
  to: string,
  kind: 'guest_invitation' | 'guest_otp'
): Promise<DevMail> {
  const mails = await listMails(to, kind);
  expect(mails.length, `expected ${kind} mail for ${to}`).toBeGreaterThan(0);
  return mails[0];
}

interface SeedState {
  parentId: string;
  parentName: string;
  childId: string;
  childName: string;
  confidentialFileId: string;
  confidentialFileName: string;
  uploadedFileId: string;
  guestEmail: string;
  guestUserId: string;
  invitationId: string;
  guestCookie: string;
}

let seed: SeedState;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?, 'Collab Tenant', 'collab-tenant')"
    ).bind(TENANT),
    env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?, 'Collab Other', 'collab-other')"
    ).bind(OTHER_TENANT),
    env.DB.prepare(
      'INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)'
    ).bind(TENANT),
    env.DB.prepare(
      'INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)'
    ).bind(OTHER_TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'collab-admin@example.com', 'Collab Admin', 'sys_admin', 'active', ?, ?)`
    ).bind(ADMIN, TENANT, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'collab-sec@example.com', 'Collab Sec', 'sec_admin', 'active', ?, ?)`
    ).bind(SEC_ADMIN, TENANT, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'collab-member@example.com', 'Collab Member', 'member', 'active', ?, ?)`
    ).bind(MEMBER, TENANT, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'collab-outsider@example.com', 'Collab Outsider', 'member', 'active', ?, ?)`
    ).bind(OUTSIDER, TENANT, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'collab-other-admin@example.com', 'Other Admin', 'sys_admin', 'active', ?, ?)`
    ).bind(OTHER_ADMIN, OTHER_TENANT, now, now),
  ]);
  await setTenantPolicy();

  const parent = await createFolder();
  const child = await createFolder(ADMIN, parent.id);
  const confidentialFile = await createFile(child.id, 'guest-secret-plan.txt', 'confidential');
  const uploadedFileId = await uploadAsAdmin(
    child.id,
    `guest-download-${crypto.randomUUID().slice(0, 6)}.txt`
  );
  const guestEmail = `collab-guest-${crypto.randomUUID().slice(0, 8)}@partner.example`;

  const invite = await call<{
    invitation: { id: string; userId: string };
    notice: string;
  }>('/api/guests/invitations', ADMIN, {
    method: 'POST',
    role: 'sys_admin',
    body: {
      email: guestEmail,
      displayName: 'Collab Guest',
      externalOrg: 'Partner Collab',
      targetType: 'folder',
      targetId: child.id,
      role: 'editor',
    },
  });
  expect(invite.status).toBe(201);
  expect(invite.body.notice).toContain('招待メールを送信しました');
  const guestUserId = invite.body.invitation.userId;
  const invitationId = invite.body.invitation.id;

  // Ancestor viewer + child editor produce an inherited source in the summary.
  const parentGrant = await call('/api/permissions', ADMIN, {
    method: 'POST',
    role: 'sys_admin',
    body: {
      targetType: 'folder',
      targetId: parent.id,
      granteeType: 'user',
      granteeId: guestUserId,
      role: 'viewer',
    },
  });
  expect([200, 201]).toContain(parentGrant.status);

  // Direct file grant keeps the shared-item list explicit and DLP-testable.
  const fileGrant = await call('/api/permissions', ADMIN, {
    method: 'POST',
    role: 'sys_admin',
    body: {
      targetType: 'file',
      targetId: confidentialFile.id,
      granteeType: 'user',
      granteeId: guestUserId,
      role: 'viewer',
    },
  });
  expect([200, 201]).toContain(fileGrant.status);

  const invitationMail = await latestMail(guestEmail, 'guest_invitation');
  expect(invitationMail.token).toBeTruthy();
  const accepted = await callPublic('/auth/guest/accept', {
    method: 'POST',
    body: { token: invitationMail.token },
  });
  expect(accepted.status).toBe(200);
  const otpMail = await latestMail(guestEmail, 'guest_otp');
  const verified = await callPublic<{
    user: { id: string; userType: string };
  }>('/auth/guest/otp/verify', {
    method: 'POST',
    body: { email: guestEmail, otp: otpMail.otpCode },
  });
  expect(verified.status).toBe(200);
  expect(verified.body.user.userType).toBe('guest');
  expect(verified.setCookie).toBeTruthy();

  seed = {
    parentId: parent.id,
    parentName: parent.name,
    childId: child.id,
    childName: child.name,
    confidentialFileId: confidentialFile.id,
    confidentialFileName: confidentialFile.name,
    uploadedFileId,
    guestEmail,
    guestUserId,
    invitationId,
    guestCookie: verified.setCookie!,
  };
});

describe('P10-2 principal search guest metadata', () => {
  it('returns guest attributes, filters by kind and blocks guest callers', async () => {
    const all = await call<{
      principals: Array<Record<string, unknown>>;
    }>(`/api/principals/search?q=${encodeURIComponent('collab-guest-')}&kind=all`, ADMIN, {
      role: 'sys_admin',
    });
    expect(all.status).toBe(200);
    const guest = all.body.principals.find(
      (principal) => principal.id === seed.guestUserId
    );
    expect(guest).toMatchObject({
      type: 'user',
      userType: 'guest',
      externalOrg: 'Partner Collab',
      invitedBy: ADMIN,
      invitationStatus: 'accepted',
    });
    expect(typeof guest?.expiresAt).toBe('string');
    expect(typeof guest?.lastLoginAt).toBe('string');

    const guestsOnly = await call<{
      principals: Array<Record<string, unknown>>;
    }>(`/api/principals/search?q=${encodeURIComponent('collab-')}&kind=guest`, ADMIN, {
      role: 'sys_admin',
    });
    expect(guestsOnly.status).toBe(200);
    expect(
      guestsOnly.body.principals.every(
        (principal) => principal.userType === 'guest'
      )
    ).toBe(true);
    expect(
      guestsOnly.body.principals.some(
        (principal) => principal.id === seed.guestUserId
      )
    ).toBe(true);

    const membersOnly = await call<{
      principals: Array<Record<string, unknown>>;
    }>(`/api/principals/search?q=${encodeURIComponent('collab-')}&kind=member`, ADMIN, {
      role: 'sys_admin',
    });
    expect(membersOnly.status).toBe(200);
    expect(
      membersOnly.body.principals.every(
        (principal) => principal.userType === 'member'
      )
    ).toBe(true);
    expect(
      membersOnly.body.principals.some(
        (principal) => principal.id === seed.guestUserId
      )
    ).toBe(false);

    const invalid = await call('/api/principals/search?q=x&kind=invalid', ADMIN, {
      role: 'sys_admin',
    });
    expect(invalid.status).toBe(400);

    const guestCall = await callWithCookie<{ code?: string }>(
      '/api/principals/search?q=collab',
      seed.guestCookie
    );
    expect(guestCall.status).toBe(403);
    expect(guestCall.body.code).toBe('GUEST_FORBIDDEN');

    const crossTenant = await call<{
      principals: Array<Record<string, unknown>>;
    }>(`/api/principals/search?q=${encodeURIComponent('collab-guest-')}`, OTHER_ADMIN, {
      role: 'sys_admin',
      tenantId: OTHER_TENANT,
    });
    expect(crossTenant.status).toBe(200);
    expect(crossTenant.body.principals).toEqual([]);
  });
});

describe('P10-2 permissions list guest collaboration payload', () => {
  it('returns guest grant metadata, redacted mail previews and policy limits', async () => {
    const response = await call<{
      permissions: Array<Record<string, unknown>>;
      guestInvitations: Array<Record<string, unknown>>;
      guestPolicy: Record<string, unknown>;
    }>(
      `/api/permissions?targetType=folder&targetId=${encodeURIComponent(seed.childId)}`,
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(response.status).toBe(200);
    const guestPermission = response.body.permissions.find(
      (permission) => permission.granteeId === seed.guestUserId
    );
    expect(guestPermission).toMatchObject({
      granteeUserType: 'guest',
      granteeExternalOrg: 'Partner Collab',
      granteeStatus: 'accepted',
      granteeInvitedBy: ADMIN,
      granteeInvitedByName: 'Collab Admin',
    });
    expect(guestPermission?.granteeExpiresAt).toBeTruthy();
    expect(guestPermission?.granteeLastLoginAt).toBeTruthy();

    expect(response.body.guestInvitations).toHaveLength(1);
    const invitation = response.body.guestInvitations[0];
    expect(invitation).toMatchObject({
      id: seed.invitationId,
      email: seed.guestEmail,
      status: 'accepted',
      role: 'editor',
    });
    expect(invitation.invitedByName).toBe('Collab Admin');
    const mailPreview = invitation.mailPreview as {
      subject: string;
      bodyPreview: string;
    };
    expect(mailPreview.subject).toContain('外部ゲストコラボレーターの招待');
    expect(mailPreview.bodyPreview).toContain(seed.childName);
    expect(mailPreview.bodyPreview).not.toMatch(/token=/);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('token_hash');
    expect(serialized).not.toContain('"token"');

    expect(response.body.guestPolicy).toMatchObject({
      allowExternalCollaborators: true,
      externalDomainAllowlist: ['partner.example'],
      allowGuestElevatedRoles: true,
      guestInvitationExpiryDays: 7,
    });
    expect(response.body.guestPolicy.guestGrantableRoles).toEqual(
      expect.arrayContaining([
        'viewer',
        'previewer',
        'editor',
        'uploader',
        'viewer_uploader',
        'previewer_uploader',
      ])
    );
    expect(response.body.guestPolicy.guestGrantableRoles).not.toContain('owner');
    expect(response.body.guestPolicy.guestGrantableRoles).not.toContain(
      'co_owner'
    );
  });

  it('records resend and revoke notices/audits for pending invitations', async () => {
    const email = `collab-resend-${crypto.randomUUID().slice(0, 8)}@partner.example`;
    const invite = await call<{ invitation: { id: string } }>(
      '/api/guests/invitations',
      ADMIN,
      {
        method: 'POST',
        role: 'sys_admin',
        body: {
          email,
          targetType: 'folder',
          targetId: seed.childId,
          role: 'viewer',
        },
      }
    );
    expect(invite.status).toBe(201);
    const invitationId = invite.body.invitation.id;

    const resend = await call<{ notice: string }>(
      `/api/guests/invitations/${invitationId}/resend`,
      ADMIN,
      { method: 'POST', role: 'sys_admin' }
    );
    expect(resend.status).toBe(200);
    expect(resend.body.notice).toContain('再送');

    const revoke = await call<{ notice: string }>(
      `/api/guests/invitations/${invitationId}/revoke`,
      ADMIN,
      { method: 'POST', role: 'sys_admin' }
    );
    expect(revoke.status).toBe(200);
    expect(revoke.body.notice).toContain('有効セッションを失効');

    const actions = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND action IN ('guest.resend','guest.revoke')
        ORDER BY action`
    )
      .bind(TENANT)
      .all<{ action: string }>();
    expect(new Set(actions.results.map((row) => row.action))).toEqual(
      new Set(['guest.resend', 'guest.revoke'])
    );
  });
});

describe('P10-2 guest detail summary', () => {
  it('returns effective permissions, inheritance, shared items and guest attributes', async () => {
    const response = await call<{
      guest: Record<string, unknown>;
      invitations: Array<Record<string, unknown>>;
      effectivePermissions: Array<Record<string, unknown>>;
      sharedItems: Array<Record<string, unknown>>;
      accessSummary: Record<string, number>;
    }>(`/api/guests/${seed.guestUserId}/summary`, ADMIN, {
      role: 'sys_admin',
    });
    expect(response.status).toBe(200);
    expect(response.body.guest).toMatchObject({
      id: seed.guestUserId,
      email: seed.guestEmail,
      externalOrg: 'Partner Collab',
      status: 'active',
      invitedBy: ADMIN,
      invitedByName: 'Collab Admin',
    });
    expect(response.body.guest.lastLoginAt).toBeTruthy();
    expect(response.body.guest.expiresAt).toBeTruthy();
    expect(response.body.invitations).toHaveLength(1);

    const childGrants = response.body.effectivePermissions.filter(
      (permission) => permission.targetId === seed.childId
    );
    const direct = childGrants.find(
      (permission) =>
        permission.inherited === false && permission.role === 'editor'
    );
    expect(direct).toBeTruthy();
    expect(direct?.synthesizedRole).toBe('editor');
    const inherited = childGrants.find(
      (permission) =>
        permission.inherited === true && permission.role === 'viewer'
    );
    expect(inherited).toBeTruthy();
    expect(inherited?.inheritedFromName).toBe(seed.parentName);
    expect(inherited?.synthesizedRole).toBe('editor');

    const confidential = response.body.sharedItems.find(
      (item) => item.id === seed.confidentialFileId
    );
    expect(confidential).toMatchObject({
      itemType: 'file',
      name: seed.confidentialFileName,
      classification: 'confidential',
      effectiveRole: 'editor',
    });
    expect(typeof confidential?.pathLabel).toBe('string');
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain('r2_object_key');
    expect(serialized).not.toContain('tenants/');
    expect(serialized).not.toContain('token_hash');
    expect(response.body.accessSummary.fileCount).toBeGreaterThanOrEqual(1);
  });

  it('enforces inviter/RBAC visibility and tenant isolation', async () => {
    const memberDenied = await call<{ code?: string }>(
      `/api/guests/${seed.guestUserId}/summary`,
      MEMBER
    );
    expect(memberDenied.status).toBe(403);

    const secAllowed = await call(
      `/api/guests/${seed.guestUserId}/summary`,
      SEC_ADMIN,
      { role: 'sec_admin' }
    );
    expect(secAllowed.status).toBe(200);

    const guestDenied = await callWithCookie<{ code?: string }>(
      `/api/guests/${seed.guestUserId}/summary`,
      seed.guestCookie
    );
    expect(guestDenied.status).toBe(403);
    expect(guestDenied.body.code).toBe('GUEST_FORBIDDEN');

    const crossTenant = await call(
      `/api/guests/${seed.guestUserId}/summary`,
      OTHER_ADMIN,
      { role: 'sys_admin', tenantId: OTHER_TENANT }
    );
    expect(crossTenant.status).toBe(404);

    // A member holding permission.view on the shared target may inspect it.
    const grant = await call('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: seed.childId,
        granteeType: 'user',
        granteeId: MEMBER,
        role: 'viewer',
      },
    });
    expect([200, 201]).toContain(grant.status);
    const memberAllowed = await call(
      `/api/guests/${seed.guestUserId}/summary`,
      MEMBER
    );
    expect(memberAllowed.status).toBe(200);
  });
});

describe('P10-2 guest access audits and session failure codes', () => {
  it('records guest.access for shared items, folders, file reads and uploads', async () => {
    const shared = await callWithCookie('/api/shared-items', seed.guestCookie);
    expect(shared.status).toBe(200);

    const children = await callWithCookie(
      `/api/folders/${encodeURIComponent(seed.childId)}/children`,
      seed.guestCookie
    );
    expect(children.status).toBe(200);

    const metadata = await callWithCookie(
      `/api/files/${encodeURIComponent(seed.confidentialFileId)}`,
      seed.guestCookie
    );
    expect(metadata.status).toBe(200);

    const contentUrl = await callWithCookie(
      `/api/files/${encodeURIComponent(
        seed.uploadedFileId
      )}/content-url?intent=download`,
      seed.guestCookie
    );
    expect(contentUrl.status).toBe(200);

    const payload = new TextEncoder().encode('guest upload audit');
    const uploadInit = await app.fetch(
      new Request(`${APP_ORIGIN}/api/files/upload-init`, {
        method: 'POST',
        headers: {
          Cookie: seed.guestCookie,
          Origin: APP_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: seed.childId,
          fileName: `guest-upload-${crypto.randomUUID().slice(0, 6)}.txt`,
          mimeType: 'text/plain',
          sizeBytes: payload.byteLength,
        }),
      }),
      buildTestEnv({
        JOBS_QUEUE: { send: async () => undefined } as unknown as Queue,
      })
    );
    expect(uploadInit.status).toBe(201);
    const initBody = (await uploadInit.json()) as {
      fileId: string;
      versionId: string;
      uploadUrl: string;
      requiredHeaders?: Record<string, string>;
    };
    const put = await app.fetch(
      new Request(`${APP_ORIGIN}${initBody.uploadUrl}`, {
        method: 'PUT',
        headers: initBody.requiredHeaders,
        body: payload,
      }),
      buildTestEnv()
    );
    expect(put.status).toBe(200);
    const complete = await app.fetch(
      new Request(`${APP_ORIGIN}/api/files/upload-complete`, {
        method: 'POST',
        headers: {
          Cookie: seed.guestCookie,
          Origin: APP_ORIGIN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileId: initBody.fileId,
          versionId: initBody.versionId,
        }),
      }),
      buildTestEnv({
        JOBS_QUEUE: { send: async () => undefined } as unknown as Queue,
      })
    );
    expect(complete.status).toBe(200);

    const audits = await env.DB.prepare(
      `SELECT target_type, target_id, metadata_json
         FROM audit_logs
        WHERE tenant_id = ? AND action = 'guest.access' AND actor_id = ?`
    )
      .bind(TENANT, seed.guestUserId)
      .all<{
        target_type: string;
        target_id: string;
        metadata_json: string;
      }>();
    const operations = new Set(
      audits.results.map((row) => JSON.parse(row.metadata_json).operation)
    );
    expect(operations.has('list_shared_items')).toBe(true);
    expect(operations.has('list_folder')).toBe(true);
    expect(operations.has('read_file_metadata')).toBe(true);
    expect(operations.has('download_url')).toBe(true);
    expect(operations.has('upload_complete')).toBe(true);
    const auditMetadata = JSON.parse(audits.results[0].metadata_json);
    expect(auditMetadata.externalOrg).toBe('Partner Collab');
  });

  it('returns precise 401 codes for expired, suspended and revoked guests', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();

    await env.DB.prepare(
      'UPDATE users SET expires_at = ? WHERE id = ?'
    )
      .bind(past, seed.guestUserId)
      .run();
    const expired = await callWithCookie<{ code?: string }>(
      '/api/auth/me',
      seed.guestCookie
    );
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('GUEST_ACCOUNT_EXPIRED');

    await env.DB.prepare(
      `UPDATE users SET expires_at = ?, status = 'suspended' WHERE id = ?`
    )
      .bind(new Date(Date.now() + 3600_000).toISOString(), seed.guestUserId)
      .run();
    const suspended = await callWithCookie<{ code?: string }>(
      '/api/auth/me',
      seed.guestCookie
    );
    expect(suspended.status).toBe(401);
    expect(suspended.body.code).toBe('GUEST_ACCOUNT_SUSPENDED');

    await env.DB.prepare(
      `UPDATE users SET status = 'active' WHERE id = ?`
    )
      .bind(seed.guestUserId)
      .run();
    await env.DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE user_id = ?`
    )
      .bind(new Date().toISOString(), seed.guestUserId)
      .run();
    const revoked = await callWithCookie<{ code?: string }>(
      '/api/auth/me',
      seed.guestCookie
    );
    expect(revoked.status).toBe(401);
    expect(revoked.body.code).toBe('SESSION_EXPIRED_OR_REVOKED');
  });
});
