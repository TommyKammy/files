import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sha256Hex } from '../src/services/crypto-utils';
import {
  AccountLinkConflictError,
  syncUserWithD1,
} from '../src/services/user-sync';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-guest';
const OTHER_TENANT = 'tenant-guest-other';
const ADMIN = 'guest-admin';
const SEC_ADMIN = 'guest-sec';
const EDITOR = 'guest-editor';
const VIEWER = 'guest-viewer';
const OTHER_ADMIN = 'guest-other-admin';
const APP_ORIGIN = 'http://127.0.0.1:8787';
const SCIM_TOKEN = 'guest-e2e-scim-token';

const GUEST_OPEN_POLICY = {
  allowExternalCollaborators: true,
  externalDomainAllowlist: ['partner.example'],
  guestInvitationExpiryDays: 7,
  guestSessionMaxHours: 4,
  allowGuestElevatedRoles: false,
};

type UserRole = 'sys_admin' | 'sec_admin' | 'member';
type UserType = 'member' | 'guest';

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
  setCookie: string | null;
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
    cookie?: string;
  } = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = devHeaders(
    userId,
    options.role ?? 'member',
    options.tenantId ?? TENANT,
    options.userType ?? 'member'
  );
  if (options.cookie) headers.Cookie = options.cookie;
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers,
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
  return {
    status: response.status,
    body: body as T,
    headers: response.headers,
    setCookie: extractLocalSessionCookie(response.headers),
  };
}

async function callWithSession<T = Record<string, unknown>>(
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
    headers: response.headers,
    setCookie: extractLocalSessionCookie(response.headers),
  };
}

async function callPublic<T = Record<string, unknown>>(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {}
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: APP_ORIGIN,
  };
  if (options.cookie) headers.Cookie = options.cookie;
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      method: options.method ?? 'GET',
      headers,
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
  return {
    status: response.status,
    body: body as T,
    headers: response.headers,
    setCookie: extractLocalSessionCookie(response.headers),
  };
}

async function setTenantPolicy(
  overrides: Partial<{
    allowExternalCollaborators: boolean;
    externalDomainAllowlist: string[];
    guestInvitationExpiryDays: number;
    guestSessionMaxHours: number;
    allowGuestElevatedRoles: boolean;
    advancedRolesEnabled: boolean;
    invitePolicy: string;
  }> = {}
): Promise<void> {
  const policy = { ...GUEST_OPEN_POLICY, ...overrides };
  await env.DB.prepare(
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
      policy.allowExternalCollaborators ? 1 : 0,
      JSON.stringify(policy.externalDomainAllowlist),
      policy.guestInvitationExpiryDays,
      policy.guestSessionMaxHours,
      policy.allowGuestElevatedRoles ? 1 : 0,
      overrides.advancedRolesEnabled ? 1 : 0,
      overrides.invitePolicy ?? 'editors',
      TENANT
    )
    .run();
}

let folderCounter = 0;
async function createFolder(
  ownerId = ADMIN,
  tenantId = TENANT,
  parentId: string | null = null
): Promise<string> {
  folderCounter += 1;
  const id = `guest-folder-${folderCounter}-${crypto.randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO folders (
       id, tenant_id, parent_id, name, depth, version, classification,
       created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 1, 'internal', ?, ?, ?)`
  )
    .bind(
      id,
      tenantId,
      parentId,
      `Guest Folder ${folderCounter}`,
      parentId ? 1 : 0,
      ownerId,
      now,
      now
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
     VALUES (?, ?, ?, 0)`
  )
    .bind(tenantId, id, id)
    .run();
  await env.DB.prepare(
    `INSERT INTO permissions (
       id, tenant_id, target_type, target_id, grantee_type, grantee_id,
       role, granted_by, created_at
     ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)`
  )
    .bind(crypto.randomUUID(), tenantId, id, ownerId, ownerId, now)
    .run();
  return id;
}

async function createFile(folderId: string, ownerId = ADMIN): Promise<string> {
  const id = `guest-file-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO files (
       id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
       upload_state, classification, created_by, updated_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'txt', 'text/plain', 12, 'active', 'internal', ?, ?, ?, ?)`
  )
    .bind(
      id,
      TENANT,
      folderId,
      `${id}.txt`,
      ownerId,
      ownerId,
      now,
      now
    )
    .run();
  return id;
}

function uniqueEmail(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}@partner.example`;
}

async function inviteGuest(input: {
  email?: string;
  targetType?: 'folder' | 'file';
  targetId: string;
  role?: string;
  actorId?: string;
  tenantId?: string;
  displayName?: string;
  externalOrg?: string;
}): Promise<ApiResponse<{ invitation?: Record<string, unknown> }>> {
  return call('/api/guests/invitations', input.actorId ?? ADMIN, {
    method: 'POST',
    role: input.actorId === EDITOR ? 'member' : 'sys_admin',
    tenantId: input.tenantId ?? TENANT,
    body: {
      email: input.email ?? uniqueEmail('guest'),
      displayName: input.displayName ?? 'Guest Tester',
      externalOrg: input.externalOrg ?? 'Partner Corp',
      targetType: input.targetType ?? 'folder',
      targetId: input.targetId,
      role: input.role ?? 'viewer',
    },
  });
}

interface DevMail {
  kind: 'guest_invitation' | 'guest_otp';
  to: string;
  token: string | null;
  otpCode: string | null;
  acceptUrl: string | null;
  createdAt: string;
}

async function readMails(
  to: string,
  kind?: 'guest_invitation' | 'guest_otp',
  actorId = ADMIN
): Promise<DevMail[]> {
  const query = new URLSearchParams({ to });
  if (kind) query.set('kind', kind);
  const response = await call<{ mails: DevMail[] }>(
    `/auth/dev-guest-mails?${query.toString()}`,
    actorId,
    { role: 'sys_admin' }
  );
  expect(response.status).toBe(200);
  return response.body.mails;
}

async function latestMail(
  to: string,
  kind: 'guest_invitation' | 'guest_otp'
): Promise<DevMail> {
  const mails = await readMails(to, kind);
  expect(mails.length, `expected a ${kind} mail for ${to}`).toBeGreaterThan(0);
  return mails[0];
}

async function acceptAndLogin(email: string): Promise<{
  invitationToken: string;
  otp: string;
  cookie: string;
  guestUserId: string;
}> {
  const invitation = await latestMail(email, 'guest_invitation');
  expect(invitation.token).toBeTruthy();
  const accepted = await callPublic('/auth/guest/accept', {
    method: 'POST',
    body: { token: invitation.token },
  });
  expect(accepted.status).toBe(200);
  const otpMail = await latestMail(email, 'guest_otp');
  expect(otpMail.otpCode).toMatch(/^\d{6}$/);
  const verified = await callPublic<{
    ok: boolean;
    user: { id: string; userType: string };
  }>('/auth/guest/otp/verify', {
    method: 'POST',
    body: { email, otp: otpMail.otpCode },
  });
  expect(verified.status).toBe(200);
  expect(verified.body.user.userType).toBe('guest');
  expect(verified.setCookie).toBeTruthy();
  return {
    invitationToken: invitation.token!,
    otp: otpMail.otpCode!,
    cookie: verified.setCookie!,
    guestUserId: verified.body.user.id,
  };
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?, 'Guest Tenant', 'guest-tenant')"
    ).bind(TENANT),
    env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (id, name, slug) VALUES (?, 'Guest Other', 'guest-other')"
    ).bind(OTHER_TENANT),
    env.DB.prepare(
      'INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)'
    ).bind(TENANT),
    env.DB.prepare(
      'INSERT OR IGNORE INTO tenant_policies (tenant_id) VALUES (?)'
    ).bind(OTHER_TENANT),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'guest-admin@example.com', 'Guest Admin', 'sys_admin', 'active', ?, ?)`
    ).bind(ADMIN, TENANT, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'guest-sec@example.com', 'Guest Sec', 'sec_admin', 'active', ?, ?)`
    ).bind(SEC_ADMIN, TENANT, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'guest-editor@example.com', 'Guest Editor', 'member', 'active', ?, ?)`
    ).bind(EDITOR, TENANT, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'guest-viewer@example.com', 'Guest Viewer', 'member', 'active', ?, ?)`
    ).bind(VIEWER, TENANT, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, tenant_id, email, display_name, role, status, created_at, updated_at)
       VALUES (?, ?, 'guest-other-admin@example.com', 'Other Admin', 'sys_admin', 'active', ?, ?)`
    ).bind(OTHER_ADMIN, OTHER_TENANT, now, now),
    env.DB.prepare(
      `INSERT OR IGNORE INTO scim_tokens (id, tenant_id, idp_issuer, name, token_hash, created_at)
       VALUES ('guest-scim-token', ?, 'guest-idp', 'Guest SCIM', ?, ?)`
    ).bind(TENANT, await sha256Hex(SCIM_TOKEN), now),
  ]);
});

describe('P10-1 external guest policy API', () => {
  it('lets sys_admin update guest policies, normalizes domains and keeps sec_admin read-only', async () => {
    const secPatch = await call('/api/admin/policies', SEC_ADMIN, {
      method: 'PATCH',
      role: 'sec_admin',
      body: { allowExternalCollaborators: true },
    });
    expect(secPatch.status).toBe(403);
    expect((secPatch.body as { code?: string }).code).toBe('SYS_ADMIN_REQUIRED');

    const patch = await call<{
      policy: {
        allowExternalCollaborators: boolean;
        allowGuestElevatedRoles: boolean;
        externalDomainAllowlist: string[];
        guestInvitationExpiryDays: number;
        guestSessionMaxHours: number;
      };
    }>('/api/admin/policies', ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: {
        allowExternalCollaborators: true,
        allowGuestElevatedRoles: true,
        externalDomainAllowlist: ['Partner.Example', 'allowed.example.com', 'partner.example'],
        guestInvitationExpiryDays: 21,
        guestSessionMaxHours: 12,
      },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.policy).toMatchObject({
      allowExternalCollaborators: true,
      allowGuestElevatedRoles: true,
      externalDomainAllowlist: ['allowed.example.com', 'partner.example'],
      guestInvitationExpiryDays: 21,
      guestSessionMaxHours: 12,
    });

    const invalidDomain = await call('/api/admin/policies', ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { externalDomainAllowlist: ['https://evil.example/path'] },
    });
    expect(invalidDomain.status).toBe(400);
    expect((invalidDomain.body as { code?: string }).code).toBe(
      'INVALID_DOMAIN_ALLOWLIST'
    );

    const invalidExpiry = await call('/api/admin/policies', ADMIN, {
      method: 'PATCH',
      role: 'sys_admin',
      body: { guestInvitationExpiryDays: 0 },
    });
    expect(invalidExpiry.status).toBe(400);

    const secRead = await call<{
      policy: {
        allowExternalCollaborators: boolean;
        externalDomainAllowlist: string[];
      };
    }>('/api/admin/policies', SEC_ADMIN, { role: 'sec_admin' });
    expect(secRead.status).toBe(200);
    expect(secRead.body.policy.allowExternalCollaborators).toBe(true);
    expect(secRead.body.policy.externalDomainAllowlist).toEqual([
      'allowed.example.com',
      'partner.example',
    ]);
  });
});

describe('P10-1 guest invitation, accept, OTP and session lifecycle', () => {
  it('runs invite -> meta -> accept -> OTP login -> /api/auth/me with audits', async () => {
    await setTenantPolicy({ guestSessionMaxHours: 4 });
    const folderId = await createFolder();
    const email = uniqueEmail('lifecycle');
    const invite = await inviteGuest({
      email,
      targetId: folderId,
      role: 'viewer',
      displayName: 'Lifecycle Guest',
      externalOrg: 'Partner Corp',
    });
    expect(invite.status).toBe(201);
    expect(JSON.stringify(invite.body)).not.toContain('"token"');
    const invitedUserId = (invite.body as { invitation: { userId: string } })
      .invitation.userId;
    const beforeAcceptPermission = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM permissions
        WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?`
    )
      .bind(TENANT, invitedUserId)
      .first<{ cnt: number }>();
    expect(beforeAcceptPermission?.cnt).toBe(0);

    const invitationMail = await latestMail(email, 'guest_invitation');
    expect(invitationMail.token).toBeTruthy();
    expect(invitationMail.acceptUrl).toContain('/guest/accept?token=');

    const meta = await callPublic<{ invitation: Record<string, unknown> }>(
      `/auth/guest/invite-meta?token=${encodeURIComponent(invitationMail.token!)}`
    );
    expect(meta.status).toBe(200);
    expect(meta.body.invitation).toMatchObject({
      valid: true,
      status: 'pending',
      tenantName: 'Guest Tenant',
      externalOrg: 'Partner Corp',
      targetName: expect.stringContaining('Guest Folder'),
      canAccept: true,
    });
    expect(String(meta.body.invitation.emailMasked)).toContain('@partner.example');

    const accepted = await acceptAndLogin(email);
    const acceptedPermission = await env.DB.prepare(
      `SELECT role FROM permissions
        WHERE tenant_id = ? AND target_type = 'folder' AND target_id = ?
          AND grantee_type = 'user' AND grantee_id = ?`
    )
      .bind(TENANT, folderId, accepted.guestUserId)
      .first<{ role: string }>();
    expect(acceptedPermission?.role).toBe('viewer');
    const acceptAgain = await callPublic('/auth/guest/accept', {
      method: 'POST',
      body: { token: accepted.invitationToken },
    });
    expect(acceptAgain.status).toBe(410);
    expect((acceptAgain.body as { code?: string }).code).toBe(
      'INVITATION_ALREADY_USED'
    );

    const me = await callWithSession<{
      user: {
        id: string;
        userType: string;
        externalOrg: string | null;
        expiresAt: string | null;
        role: string;
      };
    }>('/api/auth/me', accepted.cookie);
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({
      id: accepted.guestUserId,
      userType: 'guest',
      externalOrg: 'Partner Corp',
      role: 'member',
    });
    expect(me.body.user.expiresAt).toBeTruthy();

    const adminBlocked = await callWithSession<{ code?: string }>(
      '/api/admin/policies',
      accepted.cookie
    );
    expect(adminBlocked.status).toBe(403);
    expect(adminBlocked.body.code).toBe('GUEST_FORBIDDEN');
    const auditBlocked = await callWithSession<{ code?: string }>(
      '/api/audit-logs',
      accepted.cookie
    );
    expect(auditBlocked.status).toBe(403);
    expect(auditBlocked.body.code).toBe('GUEST_FORBIDDEN');
    const rootBlocked = await callWithSession<{ code?: string }>(
      '/api/folders',
      accepted.cookie,
      { method: 'POST', body: { parentId: null, name: 'Guest Root Session' } }
    );
    expect(rootBlocked.status).toBe(403);
    expect(rootBlocked.body.code).toBe('GUEST_FORBIDDEN');

    const session = await env.DB.prepare(
      `SELECT expires_at FROM sessions WHERE user_id = ? AND revoked_at IS NULL`
    )
      .bind(accepted.guestUserId)
      .first<{ expires_at: string }>();
    expect(session).toBeTruthy();
    const sessionMs = Date.parse(session!.expires_at) - Date.now();
    expect(sessionMs).toBeGreaterThan(0);
    expect(sessionMs).toBeLessThanOrEqual(4 * 3600 * 1000 + 5000);

    const guestRow = await env.DB.prepare(
      `SELECT user_type, status, last_login_at, external_org, expires_at
         FROM users WHERE id = ?`
    )
      .bind(accepted.guestUserId)
      .first<{
        user_type: string;
        status: string;
        last_login_at: string | null;
        external_org: string | null;
        expires_at: string | null;
      }>();
    expect(guestRow).toMatchObject({
      user_type: 'guest',
      status: 'active',
      external_org: 'Partner Corp',
    });
    expect(guestRow?.last_login_at).toBeTruthy();

    const reusedOtp = await callPublic('/auth/guest/otp/verify', {
      method: 'POST',
      body: { email, otp: accepted.otp },
    });
    expect(reusedOtp.status).toBe(401);

    const actions = await env.DB.prepare(
      `SELECT action FROM audit_logs
        WHERE tenant_id = ? AND action IN ('guest.invite','guest.accept','guest.login')
        ORDER BY action`
    )
      .bind(TENANT)
      .all<{ action: string }>();
    const actionSet = new Set(actions.results.map((row) => row.action));
    expect(actionSet.has('guest.invite')).toBe(true);
    expect(actionSet.has('guest.accept')).toBe(true);
    expect(actionSet.has('guest.login')).toBe(true);
  });

  it('resends, rotates the token, then revokes the invitation and live session', async () => {
    await setTenantPolicy();
    const folderId = await createFolder();
    const email = uniqueEmail('revoke');
    const invite = await inviteGuest({ email, targetId: folderId });
    expect(invite.status).toBe(201);
    const invitationId = (invite.body as { invitation: { id: string } }).invitation.id;

    const firstMail = await latestMail(email, 'guest_invitation');
    expect(firstMail.token).toBeTruthy();

    const resend = await call<{ invitation: { resendCount: number } }>(
      `/api/guests/invitations/${invitationId}/resend`,
      ADMIN,
      { method: 'POST', role: 'sys_admin' }
    );
    expect(resend.status).toBe(200);
    expect(resend.body.invitation.resendCount).toBe(1);

    const oldMeta = await callPublic(
      `/auth/guest/invite-meta?token=${encodeURIComponent(firstMail.token!)}`
    );
    expect(oldMeta.status).toBe(404);

    const newMail = await latestMail(email, 'guest_invitation');
    expect(newMail.token).not.toBe(firstMail.token);
    const newMeta = await callPublic<{ invitation: { valid: boolean } }>(
      `/auth/guest/invite-meta?token=${encodeURIComponent(newMail.token!)}`
    );
    expect(newMeta.status).toBe(200);
    expect(newMeta.body.invitation.valid).toBe(true);

    const login = await acceptAndLogin(email);
    expect(login.invitationToken).toBe(newMail.token);

    const revoke = await call<{ ok: boolean; invitation: { status: string } }>(
      `/api/guests/invitations/${invitationId}/revoke`,
      ADMIN,
      { method: 'POST', role: 'sys_admin' }
    );
    expect(revoke.status).toBe(200);
    expect(revoke.body.invitation.status).toBe('revoked');

    const meAfterRevoke = await callWithSession(
      '/api/auth/me',
      login.cookie
    );
    expect(meAfterRevoke.status).toBe(401);

    const revokedMeta = await callPublic<{ invitation: { revoked: boolean; valid: boolean } }>(
      `/auth/guest/invite-meta?token=${encodeURIComponent(newMail.token!)}`
    );
    expect(revokedMeta.body.invitation.revoked).toBe(true);
    expect(revokedMeta.body.invitation.valid).toBe(false);

    const acceptRevoked = await callPublic('/auth/guest/accept', {
      method: 'POST',
      body: { token: newMail.token },
    });
    expect(acceptRevoked.status).toBe(410);
    expect((acceptRevoked.body as { code?: string }).code).toBe(
      'INVITATION_REVOKED'
    );

    const otpAfterRevoke = await callPublic('/auth/guest/otp/request', {
      method: 'POST',
      body: { email },
    });
    expect(otpAfterRevoke.status).toBe(403);
    expect((otpAfterRevoke.body as { code?: string }).code).toBe(
      'GUEST_ACCOUNT_INACTIVE'
    );

    const revokeAudit = await env.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM audit_logs WHERE tenant_id = ? AND action = 'guest.revoke'"
    )
      .bind(TENANT)
      .first<{ cnt: number }>();
    expect(revokeAudit?.cnt).toBeGreaterThanOrEqual(1);

    const guest = await env.DB.prepare(
      'SELECT status FROM users WHERE id = ?'
    )
      .bind(login.guestUserId)
      .first<{ status: string }>();
    expect(guest?.status).toBe('suspended');

    const permissionAfterRevoke = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM permissions
        WHERE tenant_id = ? AND target_type = 'folder' AND target_id = ?
          AND grantee_type = 'user' AND grantee_id = ?`
    )
      .bind(TENANT, folderId, login.guestUserId)
      .first<{ cnt: number }>();
    expect(permissionAfterRevoke?.cnt).toBe(0);
  });
});

describe('P10-1 guest policy gates and expiry', () => {
  it('rejects invitations and logins when external collaboration is disabled', async () => {
    await setTenantPolicy({ allowExternalCollaborators: true });
    const folderId = await createFolder();
    const email = uniqueEmail('disabled');
    const invite = await inviteGuest({ email, targetId: folderId });
    expect(invite.status).toBe(201);
    const invitationMail = await latestMail(email, 'guest_invitation');

    await setTenantPolicy({ allowExternalCollaborators: false });
    const inviteBlocked = await inviteGuest({
      email: uniqueEmail('disabled2'),
      targetId: folderId,
    });
    expect(inviteBlocked.status).toBe(403);
    expect((inviteBlocked.body as { code?: string }).code).toBe(
      'EXTERNAL_COLLABORATORS_DISABLED'
    );

    const acceptBlocked = await callPublic('/auth/guest/accept', {
      method: 'POST',
      body: { token: invitationMail.token },
    });
    expect(acceptBlocked.status).toBe(403);
    expect((acceptBlocked.body as { code?: string }).code).toBe(
      'EXTERNAL_COLLABORATORS_DISABLED'
    );

    const otpBlocked = await callPublic('/auth/guest/otp/request', {
      method: 'POST',
      body: { email },
    });
    expect(otpBlocked.status).toBe(403);
    expect((otpBlocked.body as { code?: string }).code).toBe(
      'EXTERNAL_COLLABORATORS_DISABLED'
    );
  });

  it('fail-closes the domain allowlist and rejects unlisted domains', async () => {
    await setTenantPolicy({ externalDomainAllowlist: [] });
    const folderId = await createFolder();
    const emptyAllowlist = await inviteGuest({
      email: uniqueEmail('emptylist'),
      targetId: folderId,
    });
    expect(emptyAllowlist.status).toBe(403);
    expect((emptyAllowlist.body as { code?: string }).code).toBe(
      'EXTERNAL_DOMAIN_NOT_ALLOWED'
    );

    await setTenantPolicy({ externalDomainAllowlist: ['partner.example'] });
    const otherDomain = await inviteGuest({
      email: 'someone@not-allowed.example',
      targetId: folderId,
    });
    expect(otherDomain.status).toBe(403);
    expect((otherDomain.body as { code?: string }).code).toBe(
      'EXTERNAL_DOMAIN_NOT_ALLOWED'
    );

    const allowed = await inviteGuest({
      email: uniqueEmail('allowed'),
      targetId: folderId,
    });
    expect(allowed.status).toBe(201);
  });

  it('rejects expired invitations and expired/suspended guest sessions', async () => {
    await setTenantPolicy();
    const folderId = await createFolder();
    const email = uniqueEmail('expired');
    const invite = await inviteGuest({ email, targetId: folderId });
    expect(invite.status).toBe(201);
    const invitationId = (invite.body as { invitation: { id: string } }).invitation.id;
    await env.DB.prepare(
      "UPDATE guest_invitations SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?"
    )
      .bind(invitationId)
      .run();
    const mail = await latestMail(email, 'guest_invitation');
    const meta = await callPublic<{ invitation: { expired: boolean; valid: boolean } }>(
      `/auth/guest/invite-meta?token=${encodeURIComponent(mail.token!)}`
    );
    expect(meta.body.invitation.expired).toBe(true);
    expect(meta.body.invitation.valid).toBe(false);
    const accept = await callPublic('/auth/guest/accept', {
      method: 'POST',
      body: { token: mail.token },
    });
    expect(accept.status).toBe(410);
    expect((accept.body as { code?: string }).code).toBe('INVITATION_EXPIRED');

    // Guest account expiry is enforced even for an otherwise valid session.
    const email2 = uniqueEmail('account-expired');
    await inviteGuest({ email: email2, targetId: folderId });
    const login = await acceptAndLogin(email2);
    await env.DB.prepare(
      "UPDATE users SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?"
    )
      .bind(login.guestUserId)
      .run();
    const meExpired = await callWithSession('/api/auth/me', login.cookie);
    expect(meExpired.status).toBe(401);

    // A valid guest account with an expired session is rejected too.
    const email3 = uniqueEmail('session-expired');
    await inviteGuest({ email: email3, targetId: folderId });
    const login3 = await acceptAndLogin(email3);
    await env.DB.prepare(
      "UPDATE sessions SET expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?"
    )
      .bind(login3.guestUserId)
      .run();
    const meSessionExpired = await callWithSession(
      '/api/auth/me',
      login3.cookie
    );
    expect(meSessionExpired.status).toBe(401);

    // Suspended guests are rejected immediately.
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?")
      .bind(login3.guestUserId)
      .run();
    const meSuspended = await callWithSession('/api/auth/me', login3.cookie);
    expect(meSuspended.status).toBe(401);
  });
});

describe('P10-1 OTP attempt and rate limiting', () => {
  it('locks after five wrong attempts and rate-limits OTP requests with Retry-After', async () => {
    await setTenantPolicy();
    const folderId = await createFolder();
    const email = uniqueEmail('otp-lock');
    await inviteGuest({ email, targetId: folderId });
    const mail = await latestMail(email, 'guest_invitation');
    const accepted = await callPublic('/auth/guest/accept', {
      method: 'POST',
      body: { token: mail.token },
    });
    expect(accepted.status).toBe(200);
    const otpMail = await latestMail(email, 'guest_otp');
    const wrong = String(Number(otpMail.otpCode) === 1 ? 2 : 1).padStart(6, '0');

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await callPublic<{ code?: string; attemptsRemaining?: number }>(
        '/auth/guest/otp/verify',
        { method: 'POST', body: { email, otp: wrong } }
      );
      expect(response.status).toBe(401);
      expect(response.body.code).toBe('INVALID_OTP');
      expect(response.body.attemptsRemaining).toBe(5 - attempt);
    }
    const fifth = await callPublic('/auth/guest/otp/verify', {
      method: 'POST',
      body: { email, otp: wrong },
    });
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get('Retry-After')).toBeTruthy();
    const lockedCorrect = await callPublic('/auth/guest/otp/verify', {
      method: 'POST',
      body: { email, otp: otpMail.otpCode },
    });
    expect(lockedCorrect.status).toBe(429);

    // Request windows are D1-backed and return Retry-After when exhausted.
    let limited: ApiResponse | null = null;
    for (let i = 0; i < 8; i += 1) {
      const response = await callPublic('/auth/guest/otp/request', {
        method: 'POST',
        body: { email },
      });
      if (response.status === 429) {
        limited = response;
        break;
      }
      expect(response.status).toBe(200);
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers.get('Retry-After')).toBeTruthy();
    expect((limited!.body as { code?: string }).code).toBe(
      'GUEST_AUTH_RATE_LIMITED'
    );

    const invalid = await callPublic('/auth/guest/otp/verify', {
      method: 'POST',
      body: { email, otp: '123' },
    });
    expect(invalid.status).toBe(400);
  });

  it('rejects an unaccepted guest for OTP login', async () => {
    await setTenantPolicy();
    const folderId = await createFolder();
    const email = uniqueEmail('not-accepted');
    await inviteGuest({ email, targetId: folderId });
    const request = await callPublic('/auth/guest/otp/request', {
      method: 'POST',
      body: { email },
    });
    expect(request.status).toBe(403);
    expect((request.body as { code?: string }).code).toBe(
      'INVITATION_NOT_ACCEPTED'
    );
  });
});

describe('P10-1 guest role restrictions', () => {
  it('restricts roles on the invitation API and POST /api/permissions', async () => {
    await setTenantPolicy({
      advancedRolesEnabled: false,
      allowGuestElevatedRoles: false,
    });
    const folderId = await createFolder();
    const fileId = await createFile(folderId);

    for (const role of ['owner', 'co_owner', 'editor']) {
      const response = await inviteGuest({
        email: uniqueEmail(`role-${role}`),
        targetId: folderId,
        role,
      });
      expect(response.status).toBe(403);
      expect((response.body as { code?: string }).code).toBe('GUEST_ROLE_FORBIDDEN');
    }

    const advancedDisabled = await inviteGuest({
      email: uniqueEmail('role-uploader'),
      targetId: folderId,
      role: 'uploader',
    });
    expect(advancedDisabled.status).toBe(403);
    expect((advancedDisabled.body as { code?: string }).code).toBe(
      'ADVANCED_ROLES_DISABLED'
    );

    await setTenantPolicy({ allowGuestElevatedRoles: true });
    const editorAllowed = await inviteGuest({
      email: uniqueEmail('role-editor-ok'),
      targetId: folderId,
      role: 'editor',
    });
    expect(editorAllowed.status).toBe(201);

    await setTenantPolicy({
      allowGuestElevatedRoles: true,
      advancedRolesEnabled: true,
    });
    const uploaderFolder = await inviteGuest({
      email: uniqueEmail('role-uploader-folder'),
      targetId: folderId,
      role: 'uploader',
    });
    expect(uploaderFolder.status).toBe(201);
    const uploaderFile = await inviteGuest({
      email: uniqueEmail('role-uploader-file'),
      targetType: 'file',
      targetId: fileId,
      role: 'uploader',
    });
    expect(uploaderFile.status).toBe(400);
    expect((uploaderFile.body as { code?: string }).code).toBe('ROLE_FOLDER_ONLY');

    // Existing guest user: direct grants go through the same restrictions.
    const guestEmail = uniqueEmail('role-direct');
    const direct = await inviteGuest({ email: guestEmail, targetId: folderId });
    expect(direct.status).toBe(201);
    const guestUserId = (direct.body as { invitation: { userId: string } }).invitation.userId;

    await setTenantPolicy({
      allowGuestElevatedRoles: false,
      advancedRolesEnabled: false,
    });
    const grantOwner = await call<{ code?: string }>('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: folderId,
        granteeType: 'user',
        granteeId: guestUserId,
        role: 'owner',
      },
    });
    expect(grantOwner.status).toBe(403);
    expect((grantOwner.body as { code?: string }).code).toBe(
      'GUEST_ROLE_FORBIDDEN'
    );

    const grantEditor = await call('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: folderId,
        granteeType: 'user',
        granteeId: guestUserId,
        role: 'editor',
      },
    });
    expect(grantEditor.status).toBe(403);

    const grantUploaderFile = await call<{ code?: string }>(
      '/api/permissions',
      ADMIN,
      {
        method: 'POST',
        role: 'sys_admin',
        body: {
          targetType: 'file',
          targetId: fileId,
          granteeType: 'user',
          granteeId: guestUserId,
          role: 'uploader',
        },
      }
    );
    expect(grantUploaderFile.status).toBe(400);
    expect((grantUploaderFile.body as { code?: string }).code).toBe(
      'ROLE_FOLDER_ONLY'
    );

    const grantUploaderDisabled = await call<{ code?: string }>(
      '/api/permissions',
      ADMIN,
      {
        method: 'POST',
        role: 'sys_admin',
        body: {
          targetType: 'folder',
          targetId: folderId,
          granteeType: 'user',
          granteeId: guestUserId,
          role: 'uploader',
        },
      }
    );
    expect(grantUploaderDisabled.status).toBe(403);
    expect((grantUploaderDisabled.body as { code?: string }).code).toBe(
      'ADVANCED_ROLES_DISABLED'
    );

    await setTenantPolicy({
      allowGuestElevatedRoles: true,
      advancedRolesEnabled: true,
    });
    const grantEditorAllowed = await call('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: folderId,
        granteeType: 'user',
        granteeId: guestUserId,
        role: 'editor',
      },
    });
    expect([200, 201]).toContain(grantEditorAllowed.status);

    const grantUploaderAllowed = await call('/api/permissions', ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      body: {
        targetType: 'folder',
        targetId: folderId,
        granteeType: 'user',
        granteeId: guestUserId,
        role: 'uploader',
      },
    });
    expect([200, 201]).toContain(grantUploaderAllowed.status);
  });
});

describe('P10-1 SCIM and OIDC isolation', () => {
  it('excludes guests from every SCIM operation and rejects same-email drift with 409', async () => {
    await setTenantPolicy();
    const folderId = await createFolder();
    const email = uniqueEmail('scim-guest');
    const invite = await inviteGuest({ email, targetId: folderId });
    expect(invite.status).toBe(201);
    const guestUserId = (invite.body as { invitation: { userId: string } }).invitation.userId;

    const list = await app.fetch(
      new Request(`${APP_ORIGIN}/scim/v2/Users`, {
        headers: { Authorization: `Bearer ${SCIM_TOKEN}` },
      }),
      buildTestEnv()
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      Resources: Array<{ id: string; userName: string }>;
      totalResults: number;
    };
    expect(listBody.Resources.some((row) => row.id === guestUserId)).toBe(false);
    expect(listBody.Resources.some((row) => row.userName === email)).toBe(false);
    expect(listBody.totalResults).toBeGreaterThan(0);

    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const response = await app.fetch(
        new Request(`${APP_ORIGIN}/scim/v2/Users/${guestUserId}`, {
          method,
          headers: {
            Authorization: `Bearer ${SCIM_TOKEN}`,
            'Content-Type': 'application/scim+json',
          },
          ...(method === 'GET' || method === 'DELETE'
            ? {}
            : {
                body: JSON.stringify({
                  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
                  userName: email,
                  displayName: 'SCIM Guest',
                  emails: [{ value: email, primary: true }],
                  active: false,
                }),
              }),
        }),
        buildTestEnv()
      );
      expect(response.status, `SCIM ${method} must not see guests`).toBe(404);
    }

    const create = await app.fetch(
      new Request(`${APP_ORIGIN}/scim/v2/Users`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SCIM_TOKEN}`,
          'Content-Type': 'application/scim+json',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: email,
          displayName: 'SCIM Drift',
          emails: [{ value: email, primary: true }],
          active: true,
        }),
      }),
      buildTestEnv()
    );
    expect(create.status).toBe(409);
    const createBody = (await create.json()) as { scimType?: string };
    expect(createBody.scimType).toBe('uniqueness');

    const guestRow = await env.DB.prepare(
      'SELECT user_type, role, status FROM users WHERE id = ?'
    )
      .bind(guestUserId)
      .first<{ user_type: string; role: string; status: string }>();
    expect(guestRow).toEqual({
      user_type: 'guest',
      role: 'member',
      status: 'active',
    });
  });

  it('never links or promotes a guest during OIDC syncUserWithD1', async () => {
    await setTenantPolicy();
    const folderId = await createFolder();
    const email = uniqueEmail('oidc-guest');
    const invite = await inviteGuest({ email, targetId: folderId });
    expect(invite.status).toBe(201);
    const guestUserId = (invite.body as { invitation: { userId: string } }).invitation.userId;

    const claims = {
      provider: 'okta' as const,
      issuer: 'https://guest-issuer.example',
      externalIdpId: 'guest-subject-1',
      email,
      emailVerified: true,
      displayName: 'OIDC Guest',
      department: null,
      groups: [],
    };
    await expect(
      syncUserWithD1(env.DB, TENANT, claims, '127.0.0.1')
    ).rejects.toBeInstanceOf(AccountLinkConflictError);

    // Even a (legacy/corrupt) guest row carrying the same IdP subject is not
    // silently promoted into a member account.
    await env.DB.prepare(
      `UPDATE users SET idp_issuer = ?, external_idp_id = ? WHERE id = ?`
    )
      .bind(claims.issuer, claims.externalIdpId, guestUserId)
      .run();
    await expect(
      syncUserWithD1(env.DB, TENANT, claims, '127.0.0.1')
    ).rejects.toBeInstanceOf(AccountLinkConflictError);

    const guestRow = await env.DB.prepare(
      'SELECT user_type, role FROM users WHERE id = ?'
    )
      .bind(guestUserId)
      .first<{ user_type: string; role: string }>();
    expect(guestRow).toEqual({ user_type: 'guest', role: 'member' });
  });
});

describe('P10-1 internal route isolation', () => {
  it('blocks guests from admin, audit, file-requests and root folder creation', async () => {
    await setTenantPolicy();
    const folderId = await createFolder();
    const email = uniqueEmail('internal-block');
    const invite = await inviteGuest({ email, targetId: folderId });
    expect(invite.status).toBe(201);
    const guestUserId = (invite.body as { invitation: { userId: string } }).invitation.userId;
    const guestOptions = { userType: 'guest' as const, role: 'member' as const };

    for (const path of ['/api/admin/policies', '/api/audit-logs', '/api/file-requests']) {
      const response = await call(path, guestUserId, guestOptions);
      expect(response.status, path).toBe(403);
      expect((response.body as { code?: string }).code).toBe('GUEST_FORBIDDEN');
    }

    const createRequest = await call('/api/file-requests', guestUserId, {
      ...guestOptions,
      method: 'POST',
      body: { folderId, title: 'Guest request' },
    });
    expect(createRequest.status).toBe(403);
    expect((createRequest.body as { code?: string }).code).toBe('GUEST_FORBIDDEN');

    const rootFolder = await call('/api/folders', guestUserId, {
      ...guestOptions,
      method: 'POST',
      body: { parentId: null, name: 'Guest Root' },
    });
    expect(rootFolder.status).toBe(403);
    expect((rootFolder.body as { code?: string }).code).toBe('GUEST_FORBIDDEN');

    // The dedicated guest management API is member-only as well.
    const guestList = await call('/api/guests/invitations', guestUserId, guestOptions);
    expect(guestList.status).toBe(403);
    expect((guestList.body as { code?: string }).code).toBe('GUEST_FORBIDDEN');

    const guestInvite = await call('/api/guests/invitations', guestUserId, {
      ...guestOptions,
      method: 'POST',
      body: {
        email: uniqueEmail('guest-invited-by-guest'),
        targetType: 'folder',
        targetId: folderId,
        role: 'viewer',
      },
    });
    expect(guestInvite.status).toBe(403);
    expect((guestInvite.body as { code?: string }).code).toBe('GUEST_FORBIDDEN');

    // Company-only shared links are internal-member-only.
    const rawToken = `company-only-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO shared_links (
         id, tenant_id, token_hash, target_type, target_id, access_scope,
         can_download, created_by, created_at
       ) VALUES (?, ?, ?, 'folder', ?, 'company_only', 1, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        TENANT,
        await sha256Hex(rawToken),
        folderId,
        ADMIN,
        new Date().toISOString()
      )
      .run();
    const guestShare = await call(
      `/api/s/${encodeURIComponent(rawToken)}/meta`,
      guestUserId,
      guestOptions
    );
    expect(guestShare.status).toBe(403);
    expect((guestShare.body as { code?: string }).code).toBe(
      'COMPANY_ONLY_MEMBER_REQUIRED'
    );
    const memberShare = await call(
      `/api/s/${encodeURIComponent(rawToken)}/meta`,
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(memberShare.status).toBe(200);
  });
});

describe('P10-1 invitation authorization and tenant isolation', () => {
  it('honors TOM-58 invite policy and capability subset for member invitees', async () => {
    await setTenantPolicy({ invitePolicy: 'editors' });
    const folderId = await createFolder();
    await env.DB.prepare(
      `INSERT INTO permissions (
         id, tenant_id, target_type, target_id, grantee_type, grantee_id,
         role, granted_by, created_at
       ) VALUES (?, ?, 'folder', ?, 'user', ?, 'editor', ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        TENANT,
        folderId,
        EDITOR,
        ADMIN,
        new Date().toISOString()
      )
      .run();

    const editorInvite = await call('/api/guests/invitations', EDITOR, {
      method: 'POST',
      role: 'member',
      body: {
        email: uniqueEmail('editor-invited'),
        targetType: 'folder',
        targetId: folderId,
        role: 'viewer',
      },
    });
    expect(editorInvite.status).toBe(201);

    const viewerInvite = await call('/api/guests/invitations', VIEWER, {
      method: 'POST',
      role: 'member',
      body: {
        email: uniqueEmail('viewer-invited'),
        targetType: 'folder',
        targetId: folderId,
        role: 'viewer',
      },
    });
    expect(viewerInvite.status).toBe(403);
    expect((viewerInvite.body as { code?: string }).code).toBe(
      'INVITE_POLICY_RESTRICTED'
    );

    const editorEscalation = await call('/api/guests/invitations', EDITOR, {
      method: 'POST',
      role: 'member',
      body: {
        email: uniqueEmail('editor-escalation'),
        targetType: 'folder',
        targetId: folderId,
        role: 'co_owner',
      },
    });
    expect(editorEscalation.status).toBe(403);
    expect((editorEscalation.body as { code?: string }).code).toBe(
      'ROLE_EXCEEDS_CALLER_CAPABILITIES'
    );
  });

  it('does not leak or mutate invitations across tenants', async () => {
    await setTenantPolicy();
    const folderId = await createFolder();
    const email = uniqueEmail('cross-tenant');
    const invite = await inviteGuest({ email, targetId: folderId });
    expect(invite.status).toBe(201);
    const invitationId = (invite.body as { invitation: { id: string } }).invitation.id;

    const otherCreate = await call('/api/guests/invitations', OTHER_ADMIN, {
      method: 'POST',
      role: 'sys_admin',
      tenantId: OTHER_TENANT,
      body: {
        email: uniqueEmail('other-tenant'),
        targetType: 'folder',
        targetId: folderId,
        role: 'viewer',
      },
    });
    expect(otherCreate.status).toBe(404);

    const otherRevoke = await call(
      `/api/guests/invitations/${invitationId}/revoke`,
      OTHER_ADMIN,
      { method: 'POST', role: 'sys_admin', tenantId: OTHER_TENANT }
    );
    expect(otherRevoke.status).toBe(404);

    const otherList = await call(
      `/api/guests/invitations?targetType=folder&targetId=${encodeURIComponent(folderId)}`,
      OTHER_ADMIN,
      { role: 'sys_admin', tenantId: OTHER_TENANT }
    );
    expect(otherList.status).toBe(404);

    const ownerList = await call<{ invitations: Array<{ id: string }> }>(
      `/api/guests/invitations?targetType=folder&targetId=${encodeURIComponent(folderId)}`,
      ADMIN,
      { role: 'sys_admin' }
    );
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.invitations.some((row) => row.id === invitationId)).toBe(true);
  });
});

describe('P10-1 mail sink protection', () => {
  it('returns 404 for /auth/dev-guest-mails outside the local bypass', async () => {
    const response = await app.fetch(
      new Request('https://files.example.com/auth/dev-guest-mails'),
      {
        ...buildTestEnv(),
        ENVIRONMENT: 'production',
        ALLOW_DEV_AUTH: 'true',
      } as OidcEnv
    );
    expect(response.status).toBe(404);
  });
});
