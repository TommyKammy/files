import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { sha256Hex } from '../src/services/crypto-utils';
import type { OidcEnv } from '../src/types/oidc';

const TENANT = 'tenant-off-main';
const OTHER_TENANT = 'tenant-off-other';
const REVOKE_TENANT = 'tenant-off-revoke';
const GUARD_TENANT = 'tenant-off-guards';
const LAST_TENANT = 'tenant-off-last';
const MODES_TENANT = 'tenant-off-modes';
const REPLAY_TENANT = 'tenant-off-replay';
const APP_ORIGIN = 'http://127.0.0.1:8787';

const SYS = 'off-main-sys';
const LEAVER = 'off-main-leaver';
const SUCCESSOR = 'off-main-successor';
const SUSPENDED = 'off-main-suspended';
const GUEST = 'off-main-guest';
const ADMIN_OWNER = 'off-main-admin-owner';
const NOASSET = 'off-main-noasset';
const OUTSIDER = 'off-outsider';

const REVOKE_SYS = 'off-revoke-sys';
const REVOKE_LEAVER = 'off-revoke-leaver';
const REVOKE_SUCCESSOR = 'off-revoke-successor';

const GUARD_SYS = 'off-guard-sys';
const GUARD_SEC = 'off-guard-sec';
const GUARD_TARGET = 'off-guard-target';
const GUARD_GUEST = 'off-guard-guest';
const GUARD_SUSPENDED = 'off-guard-suspended';
const LAST_SYS = 'off-last-sys';
const VIRTUAL_SYS = 'off-virtual-sys';

const MODES_SYS = 'off-modes-sys';
const MODES_LEAVER = 'off-modes-leaver';
const MODES_SUCCESSOR = 'off-modes-successor';

const REPLAY_SYS = 'off-replay-sys';
const REPLAY_LEAVER = 'off-replay-leaver';
const REPLAY_SUCCESSOR = 'off-replay-successor';

type UserRole = 'sys_admin' | 'sec_admin' | 'member';
type UserType = 'member' | 'guest';

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Headers;
}

function buildTestEnv(overrides: Partial<OidcEnv> = {}): OidcEnv {
  return {
    ...env,
    ENVIRONMENT: 'local',
    ALLOW_DEV_AUTH: 'true',
    APP_ORIGIN,
    STORAGE_MODE: 'local_proxy',
    LOCAL_PROXY_SECRET: 'test-hmac-offboarding-secret',
    DEFAULT_TENANT_ID: TENANT,
    JOBS_QUEUE: { send: async () => undefined },
    ...overrides,
  } as unknown as OidcEnv;
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
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
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

async function callWithSessionCookie(
  path: string,
  token: string
): Promise<ApiResponse> {
  const response = await app.fetch(
    new Request(`${APP_ORIGIN}${path}`, {
      headers: {
        Cookie: `files_session_local=${token}`,
        Origin: APP_ORIGIN,
      },
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
  return { status: response.status, body: body as Record<string, unknown>, headers: response.headers };
}

async function offboard(
  userId: string,
  body: Record<string, unknown>,
  options: {
    role?: UserRole;
    tenantId?: string;
    extraHeaders?: Record<string, string>;
    actorId?: string;
  } = {}
): Promise<ApiResponse> {
  return call(`/api/admin/users/${encodeURIComponent(userId)}/offboard`, 
    options.actorId ?? SYS,
    {
      method: 'POST',
      body,
      role: options.role ?? 'sys_admin',
      tenantId: options.tenantId ?? TENANT,
      extraHeaders: options.extraHeaders,
    }
  );
}

interface PreviewBody {
  user: {
    id: string;
    email: string;
    status: string;
    userType: string;
    offboardedAt: string | null;
  };
  ownedFolders: Array<{
    id: string;
    name: string;
    soleOwner: boolean;
    effectiveOwnerCount: number;
    isRoot: boolean;
  }>;
  ownedFolderCount: number;
  soleOwnerCount: number;
  directPermissions: {
    total: number;
    folder: number;
    file: number;
    folderCount: number;
    fileCount: number;
  };
  activeSharedLinks: Array<{ id: string; targetType: string; targetId: string }>;
  activeFileRequests: Array<{ id: string; title: string }>;
  heldLocks: Array<{ fileId: string; mode: string }>;
  activeSessionCount: number;
  activeWopiSessionCount: number;
  groupMembershipCount: number;
  transferCandidates: Array<{ id: string; email: string }>;
}

interface OffboardingBody {
  ok: boolean;
  replayed: boolean;
  user: { id: string; status: string; email: string };
  transferTarget: { id: string; email: string } | null;
  options: Record<string, unknown>;
  summary: {
    ownedFolderCount: number;
    transferredFolderCount: number;
    soleOwnerFolderCount: number;
    directPermissionsRevoked: number;
    groupMembershipsRemoved: number;
    sharedLinksTransferred: number;
    sharedLinksRevoked: number;
    fileRequestsTransferred: number;
    fileRequestsDeactivated: number;
    sessionsRevoked: number;
    wopiSessionsRevoked: number;
    locksReleased: number;
    statusChanged: boolean;
  };
  syncSeq: number | null;
  notice: string;
}

async function count(
  sql: string,
  ...binds: unknown[]
): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe('P11-4 / TOM-70 member offboarding', () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const nowIso = new Date().toISOString();
    const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const pastIso = new Date(Date.now() - 60 * 1000).toISOString();

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenants (id, name, slug)
         VALUES
           (?, 'Offboarding Main', 'offboarding-main'),
           (?, 'Offboarding Other', 'offboarding-other'),
           (?, 'Offboarding Revoke', 'offboarding-revoke'),
           (?, 'Offboarding Guards', 'offboarding-guards'),
           (?, 'Offboarding Last', 'offboarding-last'),
           (?, 'Offboarding Modes', 'offboarding-modes'),
           (?, 'Offboarding Replay', 'offboarding-replay')`
      ).bind(
        TENANT,
        OTHER_TENANT,
        REVOKE_TENANT,
        GUARD_TENANT,
        LAST_TENANT,
        MODES_TENANT,
        REPLAY_TENANT
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO tenant_policies (tenant_id)
         VALUES (?), (?), (?), (?), (?), (?), (?)`
      ).bind(
        TENANT,
        OTHER_TENANT,
        REVOKE_TENANT,
        GUARD_TENANT,
        LAST_TENANT,
        MODES_TENANT,
        REPLAY_TENANT
      ),
      env.DB.prepare(
        `UPDATE tenant_policies
            SET folder_structure_mode = 'closed',
                permission_inheritance_mode = 'waterfall'
          WHERE tenant_id = ?`
      ).bind(MODES_TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO users (
           id, tenant_id, email, display_name, department, role, status,
           user_type, storage_quota_bytes
         ) VALUES
           (?, ?, 'off-main-sys@example.com', 'Main Sys', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'off-main-leaver@example.com', 'Leaver', 'Sales', 'member', 'active', 'member', NULL),
           (?, ?, 'off-main-successor@example.com', 'Successor', 'Sales', 'member', 'active', 'member', NULL),
           (?, ?, 'off-main-suspended@example.com', 'Suspended', 'Sales', 'member', 'suspended', 'member', NULL),
           (?, ?, 'off-main-guest@example.com', 'Guest', 'Partner', 'member', 'active', 'guest', NULL),
           (?, ?, 'off-main-admin-owner@example.com', 'Admin Owner', 'IT', 'member', 'active', 'member', NULL),
           (?, ?, 'off-main-noasset@example.com', 'No Asset', 'Sales', 'member', 'active', 'member', NULL),
           (?, ?, 'off-outsider@example.com', 'Outsider', 'IT', 'member', 'active', 'member', NULL),
           (?, ?, 'off-revoke-sys@example.com', 'Revoke Sys', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'off-revoke-leaver@example.com', 'Revoke Leaver', 'Legal', 'member', 'active', 'member', NULL),
           (?, ?, 'off-revoke-successor@example.com', 'Revoke Successor', 'Legal', 'member', 'active', 'member', NULL),
           (?, ?, 'off-guard-sys@example.com', 'Guard Sys', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'off-guard-sec@example.com', 'Guard Sec', 'Security', 'sec_admin', 'active', 'member', NULL),
           (?, ?, 'off-guard-target@example.com', 'Guard Target', 'Sales', 'member', 'active', 'member', NULL),
           (?, ?, 'off-guard-suspended@example.com', 'Guard Suspended', 'Sales', 'member', 'suspended', 'member', NULL),
           (?, ?, 'off-guard-guest@example.com', 'Guard Guest', 'Partner', 'member', 'active', 'guest', NULL),
           (?, ?, 'off-last-sys@example.com', 'Last Sys', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'off-modes-sys@example.com', 'Modes Sys', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'off-modes-leaver@example.com', 'Modes Leaver', 'Ops', 'member', 'active', 'member', NULL),
           (?, ?, 'off-modes-successor@example.com', 'Modes Successor', 'Ops', 'member', 'active', 'member', NULL),
           (?, ?, 'off-replay-sys@example.com', 'Replay Sys', 'IT', 'sys_admin', 'active', 'member', NULL),
           (?, ?, 'off-replay-leaver@example.com', 'Replay Leaver', 'Ops', 'member', 'active', 'member', NULL),
           (?, ?, 'off-replay-successor@example.com', 'Replay Successor', 'Ops', 'member', 'active', 'member', NULL)`
      ).bind(
        SYS, TENANT,
        LEAVER, TENANT,
        SUCCESSOR, TENANT,
        SUSPENDED, TENANT,
        GUEST, TENANT,
        ADMIN_OWNER, TENANT,
        NOASSET, TENANT,
        OUTSIDER, OTHER_TENANT,
        REVOKE_SYS, REVOKE_TENANT,
        REVOKE_LEAVER, REVOKE_TENANT,
        REVOKE_SUCCESSOR, REVOKE_TENANT,
        GUARD_SYS, GUARD_TENANT,
        GUARD_SEC, GUARD_TENANT,
        GUARD_TARGET, GUARD_TENANT,
        GUARD_SUSPENDED, GUARD_TENANT,
        GUARD_GUEST, GUARD_TENANT,
        LAST_SYS, LAST_TENANT,
        MODES_SYS, MODES_TENANT,
        MODES_LEAVER, MODES_TENANT,
        MODES_SUCCESSOR, MODES_TENANT,
        REPLAY_SYS, REPLAY_TENANT,
        REPLAY_LEAVER, REPLAY_TENANT,
        REPLAY_SUCCESSOR, REPLAY_TENANT
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification,
           created_by, created_at, updated_at
         ) VALUES
           ('off-root-sole', ?, NULL, 'Sales', 0, 1, 'internal', ?, ?, ?),
           ('off-root-co', ?, NULL, 'Team', 0, 1, 'internal', ?, ?, ?),
           ('off-nested', ?, 'off-root-sole', 'Forecast', 1, 1, 'internal', ?, ?, ?),
           ('off-root-shared', ?, NULL, 'Company', 0, 1, 'internal', ?, ?, ?),
           ('off-foreign-root', ?, NULL, 'Foreign', 0, 1, 'internal', ?, ?, ?),
           ('off-revoke-root', ?, NULL, 'Revoke Sales', 0, 1, 'internal', ?, ?, ?),
           ('off-guard-root', ?, NULL, 'Guard Sales', 0, 1, 'internal', ?, ?, ?),
           ('off-modes-root', ?, NULL, 'Modes Ops', 0, 1, 'internal', ?, ?, ?),
           ('off-modes-child', ?, 'off-modes-root', 'Modes Child', 1, 1, 'internal', ?, ?, ?),
           ('off-replay-root', ?, NULL, 'Replay Ops', 0, 1, 'internal', ?, ?, ?)`
      ).bind(
        TENANT, LEAVER, nowIso, nowIso,
        TENANT, ADMIN_OWNER, nowIso, nowIso,
        TENANT, LEAVER, nowIso, nowIso,
        TENANT, ADMIN_OWNER, nowIso, nowIso,
        OTHER_TENANT, OUTSIDER, nowIso, nowIso,
        REVOKE_TENANT, REVOKE_LEAVER, nowIso, nowIso,
        GUARD_TENANT, GUARD_TARGET, nowIso, nowIso,
        MODES_TENANT, MODES_LEAVER, nowIso, nowIso,
        MODES_TENANT, MODES_LEAVER, nowIso, nowIso,
        REPLAY_TENANT, REPLAY_LEAVER, nowIso, nowIso
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES
           (?, 'off-root-sole', 'off-root-sole', 0),
           (?, 'off-root-sole', 'off-nested', 1),
           (?, 'off-nested', 'off-nested', 0),
           (?, 'off-root-co', 'off-root-co', 0),
           (?, 'off-root-shared', 'off-root-shared', 0),
           (?, 'off-foreign-root', 'off-foreign-root', 0),
           (?, 'off-revoke-root', 'off-revoke-root', 0),
           (?, 'off-guard-root', 'off-guard-root', 0),
           (?, 'off-modes-root', 'off-modes-root', 0),
           (?, 'off-modes-root', 'off-modes-child', 1),
           (?, 'off-modes-child', 'off-modes-child', 0),
           (?, 'off-replay-root', 'off-replay-root', 0)`
      ).bind(
        TENANT, TENANT, TENANT, TENANT, TENANT,
        OTHER_TENANT,
        REVOKE_TENANT,
        GUARD_TENANT,
        MODES_TENANT, MODES_TENANT, MODES_TENANT,
        REPLAY_TENANT
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by, created_at
         ) VALUES
           ('off-p-root-sole', ?, 'folder', 'off-root-sole', 'user', ?, 'owner', ?, ?),
           ('off-p-root-co-leaver', ?, 'folder', 'off-root-co', 'user', ?, 'owner', ?, ?),
           ('off-p-root-co-admin', ?, 'folder', 'off-root-co', 'user', ?, 'owner', ?, ?),
           ('off-p-nested-leaver', ?, 'folder', 'off-nested', 'user', ?, 'owner', ?, ?),
           ('off-p-root-shared-admin', ?, 'folder', 'off-root-shared', 'user', ?, 'owner', ?, ?),
           ('off-p-root-shared-leaver', ?, 'folder', 'off-root-shared', 'user', ?, 'editor', ?, ?),
           ('off-p-file-two-leaver', ?, 'file', 'off-file-two', 'user', ?, 'editor', ?, ?),
           ('off-p-foreign', ?, 'folder', 'off-foreign-root', 'user', ?, 'owner', ?, ?),
           ('off-p-revoke-root', ?, 'folder', 'off-revoke-root', 'user', ?, 'owner', ?, ?),
           ('off-p-guard-root', ?, 'folder', 'off-guard-root', 'user', ?, 'owner', ?, ?),
           ('off-p-modes-root', ?, 'folder', 'off-modes-root', 'user', ?, 'owner', ?, ?),
           ('off-p-modes-child', ?, 'folder', 'off-modes-child', 'user', ?, 'owner', ?, ?),
           ('off-p-replay-root', ?, 'folder', 'off-replay-root', 'user', ?, 'owner', ?, ?)`
      ).bind(
        TENANT, LEAVER, SYS, nowIso,
        TENANT, LEAVER, SYS, nowIso,
        TENANT, ADMIN_OWNER, SYS, nowIso,
        TENANT, LEAVER, SYS, nowIso,
        TENANT, ADMIN_OWNER, SYS, nowIso,
        TENANT, LEAVER, ADMIN_OWNER, nowIso,
        TENANT, LEAVER, ADMIN_OWNER, nowIso,
        OTHER_TENANT, OUTSIDER, OUTSIDER, nowIso,
        REVOKE_TENANT, REVOKE_LEAVER, REVOKE_SYS, nowIso,
        GUARD_TENANT, GUARD_TARGET, GUARD_SYS, nowIso,
        MODES_TENANT, MODES_LEAVER, MODES_SYS, nowIso,
        MODES_TENANT, MODES_LEAVER, MODES_SYS, nowIso,
        REPLAY_TENANT, REPLAY_LEAVER, REPLAY_SYS, nowIso
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO files (
           id, tenant_id, folder_id, name, extension, mime_type, size_bytes,
           upload_state, current_version_num, classification, created_by,
           updated_by, created_at, updated_at
         ) VALUES
           ('off-file-one', ?, 'off-root-sole', 'pipeline.xlsx', 'xlsx',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            128, 'active', 1, 'internal', ?, ?, ?, ?),
           ('off-file-two', ?, 'off-root-shared', 'contract.pdf', 'pdf',
            'application/pdf', 256, 'active', 1, 'internal', ?, ?, ?, ?),
           ('off-modes-file', ?, 'off-modes-child', 'ops.csv', 'csv',
            'text/csv', 64, 'active', 1, 'internal', ?, ?, ?, ?)`
      ).bind(
        TENANT, LEAVER, LEAVER, nowIso, nowIso,
        TENANT, ADMIN_OWNER, ADMIN_OWNER, nowIso, nowIso,
        MODES_TENANT, MODES_LEAVER, MODES_LEAVER, nowIso, nowIso
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO shared_links (
           id, tenant_id, token_hash, target_type, target_id, access_scope,
           can_download, require_watermark, created_by, created_at
         ) VALUES
           ('off-link-folder', ?, 'off-token-link-folder', 'folder', 'off-root-sole',
            'company_only', 1, 0, ?, ?),
           ('off-link-file', ?, 'off-token-link-file', 'file', 'off-file-one',
            'collaborators_only', 0, 0, ?, ?),
           ('off-link-revoked', ?, 'off-token-link-revoked', 'folder', 'off-root-sole',
            'public', 1, 0, ?, ?),
           ('off-link-revoke-1', ?, 'off-token-revoke-1', 'folder', 'off-revoke-root',
            'company_only', 1, 0, ?, ?),
           ('off-link-revoke-2', ?, 'off-token-revoke-2', 'folder', 'off-revoke-root',
            'company_only', 1, 0, ?, ?)`
      ).bind(
        TENANT, LEAVER, nowIso,
        TENANT, LEAVER, nowIso,
        TENANT, LEAVER, nowIso,
        REVOKE_TENANT, REVOKE_LEAVER, nowIso,
        REVOKE_TENANT, REVOKE_LEAVER, nowIso
      ),
      env.DB.prepare(
        `UPDATE shared_links SET revoked_at = ?, revoked_by = ?
          WHERE id = 'off-link-revoked'`
      ).bind(pastIso, SYS),
      env.DB.prepare(
        `INSERT OR IGNORE INTO file_requests (
           id, tenant_id, folder_id, token_hash, title, description,
           require_submitter_email, max_file_size_bytes, allowed_extensions,
           submission_count, expires_at, is_active, created_by, created_at
         ) VALUES
           ('off-fr-one', ?, 'off-root-sole', 'off-token-fr-one', 'Pipeline submissions',
            NULL, 1, 104857600, NULL, 3, NULL, 1, ?, ?),
           ('off-fr-two', ?, 'off-root-co', 'off-token-fr-two', 'Team submissions',
            NULL, 1, 104857600, NULL, 1, NULL, 1, ?, ?),
           ('off-fr-inactive', ?, 'off-root-sole', 'off-token-fr-inactive', 'Old request',
            NULL, 1, 104857600, NULL, 0, NULL, 0, ?, ?),
           ('off-fr-revoke-1', ?, 'off-revoke-root', 'off-token-fr-revoke-1', 'Revoke One',
            NULL, 1, 104857600, NULL, 0, NULL, 1, ?, ?),
           ('off-fr-revoke-2', ?, 'off-revoke-root', 'off-token-fr-revoke-2', 'Revoke Two',
            NULL, 1, 104857600, NULL, 0, NULL, 1, ?, ?)`
      ).bind(
        TENANT, LEAVER, nowIso,
        TENANT, LEAVER, nowIso,
        TENANT, LEAVER, nowIso,
        REVOKE_TENANT, REVOKE_LEAVER, nowIso,
        REVOKE_TENANT, REVOKE_LEAVER, nowIso
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO groups (id, tenant_id, name)
         VALUES ('off-group-a', ?, 'Offboarding A'), ('off-group-b', ?, 'Offboarding B')`
      ).bind(TENANT, TENANT),
      env.DB.prepare(
        `INSERT OR IGNORE INTO group_members (group_id, user_id)
         VALUES ('off-group-a', ?), ('off-group-a', ?), ('off-group-b', ?)`
      ).bind(LEAVER, SUCCESSOR, LEAVER),
      env.DB.prepare(
        `INSERT OR IGNORE INTO sessions (
           id, tenant_id, user_id, token_hash, expires_at, revoked_at, created_at
         ) VALUES
           ('off-ses-1', ?, ?, ?, ?, NULL, ?),
           ('off-ses-2', ?, ?, ?, ?, NULL, ?),
           ('off-ses-revoked', ?, ?, ?, ?, ?, ?),
           ('off-ses-successor', ?, ?, ?, ?, NULL, ?)`
      ).bind(
        TENANT, LEAVER, await sha256Hex('off-token-1'), futureIso, nowIso,
        TENANT, LEAVER, await sha256Hex('off-token-2'), futureIso, nowIso,
        TENANT, LEAVER, await sha256Hex('off-token-revoked'), futureIso, pastIso, nowIso,
        TENANT, SUCCESSOR, await sha256Hex('off-token-successor'), futureIso, nowIso
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO wopi_sessions (
           id, tenant_id, file_id, user_id, role, can_write,
           access_token_hash, is_active, expires_at, created_at
         ) VALUES
           ('off-wopi-1', ?, 'off-file-one', ?, 'owner', 1, 'off-hash-1', 1, ?, ?),
           ('off-wopi-2', ?, 'off-file-two', ?, 'editor', 0, 'off-hash-2', 1, ?, ?),
           ('off-wopi-successor', ?, 'off-file-one', ?, 'owner', 1, 'off-hash-3', 1, ?, ?)`
      ).bind(
        TENANT, LEAVER, futureIso, nowIso,
        TENANT, LEAVER, futureIso, nowIso,
        TENANT, SUCCESSOR, futureIso, nowIso
      ),
    ]);

    if (env.FILE_LOCK_HUB) {
      const leaverLock = env.FILE_LOCK_HUB.get(
        env.FILE_LOCK_HUB.idFromName('off-file-one')
      );
      await leaverLock.lockFile({
        fileId: 'off-file-one',
        tenantId: TENANT,
        mode: 'desktop_exclusive',
        lockId: 'off-lock-1',
        ownerId: LEAVER,
        ownerName: 'Leaver',
        ttlSeconds: 3600,
      });
      const adminLock = env.FILE_LOCK_HUB.get(
        env.FILE_LOCK_HUB.idFromName('off-file-two')
      );
      await adminLock.lockFile({
        fileId: 'off-file-two',
        tenantId: TENANT,
        mode: 'wopi_collab',
        lockId: 'off-lock-2',
        ownerId: ADMIN_OWNER,
        ownerName: 'Admin Owner',
        ttlSeconds: 3600,
      });
    }
  });

  it('previews owned folders, sole owners, direct permissions, links, requests, locks and sessions', async () => {
    const res = await call<PreviewBody>(
      `/api/admin/users/${LEAVER}/offboarding-preview`,
      SYS,
      { role: 'sys_admin' }
    );
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: LEAVER,
      status: 'active',
      userType: 'member',
      offboardedAt: null,
    });
    expect(res.body.ownedFolderCount).toBe(3);
    expect(res.body.ownedFolders.map((folder) => folder.id).sort()).toEqual(
      ['off-nested', 'off-root-co', 'off-root-sole'].sort()
    );
    expect(res.body.soleOwnerCount).toBe(1);
    const sole = res.body.ownedFolders.find(
      (folder) => folder.id === 'off-root-sole'
    )!;
    expect(sole.soleOwner).toBe(true);
    expect(sole.effectiveOwnerCount).toBe(1);
    expect(sole.isRoot).toBe(true);
    expect(
      res.body.ownedFolders.find((folder) => folder.id === 'off-root-co')!
        .soleOwner
    ).toBe(false);

    expect(res.body.directPermissions).toMatchObject({
      total: 5,
      folder: 4,
      file: 1,
      folderCount: 4,
      fileCount: 1,
    });
    expect(res.body.activeSharedLinks.map((link) => link.id).sort()).toEqual([
      'off-link-file',
      'off-link-folder',
    ]);
    expect(res.body.activeFileRequests.map((request) => request.id).sort()).toEqual([
      'off-fr-one',
      'off-fr-two',
    ]);
    expect(res.body.heldLocks.map((lock) => lock.fileId)).toEqual([
      'off-file-one',
    ]);
    expect(res.body.activeSessionCount).toBe(2);
    expect(res.body.activeWopiSessionCount).toBe(2);
    expect(res.body.groupMembershipCount).toBe(2);
    expect(res.body.transferCandidates.map((candidate) => candidate.id)).toContain(
      SUCCESSOR
    );
    expect(
      res.body.transferCandidates.map((candidate) => candidate.id)
    ).not.toContain(SUSPENDED);

    // sec_admin may inspect but not execute.
    const secPreview = await call(
      `/api/admin/users/${LEAVER}/offboarding-preview`,
      GUARD_SEC,
      { role: 'sec_admin', tenantId: GUARD_TENANT }
    );
    expect(secPreview.status).toBe(404); // guard tenant has no such member
    const secPreviewMain = await call(
      `/api/admin/users/${LEAVER}/offboarding-preview`,
      'off-sec-preview',
      { role: 'sec_admin', tenantId: TENANT }
    );
    expect(secPreviewMain.status).toBe(200);

    const memberPreview = await call(
      `/api/admin/users/${LEAVER}/offboarding-preview`,
      LEAVER,
      { role: 'member' }
    );
    expect(memberPreview.status).toBe(403);
  });

  it('transfers sole-owner folders grant-first, links and file requests, then revokes sessions, locks and permissions', async () => {
    // A real session cookie works before offboarding.
    const before = await callWithSessionCookie('/api/auth/me', 'off-token-1');
    expect(before.status).toBe(200);

    const res = await offboard(
      LEAVER,
      {
        transferToUserId: SUCCESSOR,
        sharedLinksAction: 'transfer_owner',
        fileRequestsAction: 'transfer_owner',
        userAction: 'suspend',
        confirmation: 'OFFBOARD',
      },
      { extraHeaders: { 'Idempotency-Key': 'off-main-key-1' } }
    );
    expect(res.status).toBe(200);
    const body = res.body as unknown as OffboardingBody;
    expect(body.ok).toBe(true);
    expect(body.replayed).toBe(false);
    expect(body.user).toMatchObject({ id: LEAVER, status: 'suspended' });
    expect(body.transferTarget?.id).toBe(SUCCESSOR);
    expect(body.summary).toMatchObject({
      ownedFolderCount: 3,
      transferredFolderCount: 3,
      soleOwnerFolderCount: 1,
      directPermissionsRevoked: 5,
      groupMembershipsRemoved: 2,
      sharedLinksTransferred: 2,
      sharedLinksRevoked: 0,
      fileRequestsTransferred: 2,
      fileRequestsDeactivated: 0,
      sessionsRevoked: 2,
      wopiSessionsRevoked: 2,
      locksReleased: env.FILE_LOCK_HUB ? 1 : 0,
      statusChanged: true,
    });
    expect(body.notice).toContain('オフボーディング');

    // Successor owns every previously owned folder; leaver grants are gone.
    const successorOwnerCount = await count(
      `SELECT COUNT(*) AS count FROM permissions
        WHERE tenant_id = ? AND target_type = 'folder' AND role = 'owner'
          AND grantee_type = 'user' AND grantee_id = ?
          AND target_id IN ('off-root-sole', 'off-root-co', 'off-nested')`,
      TENANT,
      SUCCESSOR
    );
    expect(successorOwnerCount).toBe(3);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM permissions
          WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?`,
        TENANT,
        LEAVER
      )
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM permissions
          WHERE id = 'off-p-root-shared-admin'`
      )
    ).toBe(1);

    // Grant statements are sequenced before revoke statements.
    const grant = await env.DB.prepare(
      `SELECT MIN(seq) AS seq FROM sync_changes
        WHERE tenant_id = ? AND entity_type = 'permission'
          AND action = 'permission.grant'
          AND payload_json LIKE '%admin_offboarding%'`
    )
      .bind(TENANT)
      .first<{ seq: number }>();
    const revoke = await env.DB.prepare(
      `SELECT MIN(seq) AS seq FROM sync_changes
        WHERE tenant_id = ? AND entity_type = 'permission'
          AND action = 'permission.revoke'
          AND payload_json LIKE '%admin_offboarding%'`
    )
      .bind(TENANT)
      .first<{ seq: number }>();
    expect(grant?.seq).toBeTruthy();
    expect(revoke?.seq).toBeTruthy();
    expect(grant!.seq).toBeLessThan(revoke!.seq);

    // Links and requests changed hands rather than being destroyed.
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM shared_links
          WHERE tenant_id = ? AND created_by = ? AND revoked_at IS NULL`,
        TENANT,
        SUCCESSOR
      )
    ).toBe(2);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM file_requests
          WHERE tenant_id = ? AND created_by = ? AND is_active = 1`,
        TENANT,
        SUCCESSOR
      )
    ).toBe(2);

    // Sessions, WOPI rows, groups and user state.
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`,
        TENANT,
        LEAVER
      )
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE id = 'off-ses-successor' AND revoked_at IS NULL`
      )
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM wopi_sessions
          WHERE tenant_id = ? AND user_id = ? AND is_active = 1`,
        TENANT,
        LEAVER
      )
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM group_members WHERE user_id = ?`,
        LEAVER
      )
    ).toBe(0);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM group_members
          WHERE group_id = 'off-group-a' AND user_id = ?`,
        SUCCESSOR
      )
    ).toBe(1);
    const userRow = await env.DB.prepare(
      `SELECT status, offboarded_at, offboarded_by FROM users WHERE id = ?`
    )
      .bind(LEAVER)
      .first<{
        status: string;
        offboarded_at: string | null;
        offboarded_by: string | null;
      }>();
    expect(userRow?.status).toBe('suspended');
    expect(userRow?.offboarded_at).toBeTruthy();
    expect(userRow?.offboarded_by).toBe(SYS);

    // Hub lock held by the leaver is gone; another user's lock survives.
    if (env.FILE_LOCK_HUB) {
      const released = await env.FILE_LOCK_HUB.get(
        env.FILE_LOCK_HUB.idFromName('off-file-one')
      ).getLock({ fileId: 'off-file-one' });
      expect(released.lock).toBeNull();
      const retained = await env.FILE_LOCK_HUB.get(
        env.FILE_LOCK_HUB.idFromName('off-file-two')
      ).getLock({ fileId: 'off-file-two' });
      expect(retained.lock?.ownerId).toBe(ADMIN_OWNER);
    }

    // A revoked browser session is rejected immediately.
    const after = await callWithSessionCookie('/api/auth/me', 'off-token-1');
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('ACCOUNT_SUSPENDED');

    // Audit + sync events exist.
    const audit = await env.DB.prepare(
      `SELECT metadata_json FROM audit_logs
        WHERE tenant_id = ? AND action = 'admin.user.offboard'
          AND target_id = ?`
    )
      .bind(TENANT, LEAVER)
      .first<{ metadata_json: string }>();
    expect(audit).toBeTruthy();
    const metadata = JSON.parse(audit!.metadata_json) as {
      transferToUserId: string;
      counts: { transferredFolderCount: number };
    };
    expect(metadata.transferToUserId).toBe(SUCCESSOR);
    expect(metadata.counts.transferredFolderCount).toBe(3);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM sync_changes
          WHERE tenant_id = ? AND target_user_id = ? AND action = 'user.suspended'`,
        TENANT,
        LEAVER
      )
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM sync_changes
          WHERE tenant_id = ? AND action = 'shared_link.transfer_owner'`,
        TENANT
      )
    ).toBe(2);
  });

  it('revokes links and deactivates requests while keeping the account status when requested', async () => {
    const res = await offboard(
      REVOKE_LEAVER,
      {
        transferToUserId: REVOKE_SUCCESSOR,
        sharedLinksAction: 'revoke_all',
        fileRequestsAction: 'deactivate_all',
        userAction: 'keep_status',
        revokeDirectPermissions: false,
        removeGroupMemberships: false,
        releaseHeldLocks: false,
      },
      { tenantId: REVOKE_TENANT, actorId: REVOKE_SYS }
    );
    expect(res.status).toBe(200);
    const body = res.body as unknown as OffboardingBody;
    expect(body.options).toMatchObject({
      sharedLinksAction: 'revoke_all',
      fileRequestsAction: 'deactivate_all',
      userAction: 'keep_status',
      revokeDirectPermissions: false,
      removeGroupMemberships: false,
      releaseHeldLocks: false,
    });
    expect(body.summary).toMatchObject({
      sharedLinksTransferred: 0,
      sharedLinksRevoked: 2,
      fileRequestsTransferred: 0,
      fileRequestsDeactivated: 2,
      statusChanged: false,
    });
    expect(body.user.status).toBe('active');

    expect(
      await count(
        `SELECT COUNT(*) AS count FROM shared_links
          WHERE tenant_id = ? AND revoked_at IS NOT NULL AND revoked_by = ?`,
        REVOKE_TENANT,
        REVOKE_SYS
      )
    ).toBe(2);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM file_requests
          WHERE tenant_id = ? AND is_active = 1`,
        REVOKE_TENANT
      )
    ).toBe(0);
    // revokeDirectPermissions=false keeps the leaver's owner grant.
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM permissions
          WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?`,
        REVOKE_TENANT,
        REVOKE_LEAVER
      )
    ).toBe(1);
    // The successor still received the folder owner grant (required).
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM permissions
          WHERE tenant_id = ? AND target_id = 'off-revoke-root'
            AND grantee_type = 'user' AND grantee_id = ? AND role = 'owner'`,
        REVOKE_TENANT,
        REVOKE_SUCCESSOR
      )
    ).toBe(1);
    const row = await env.DB.prepare(
      `SELECT status, offboarded_at, offboarded_by FROM users WHERE id = ?`
    )
      .bind(REVOKE_LEAVER)
      .first<{
        status: string;
        offboarded_at: string | null;
        offboarded_by: string | null;
      }>();
    expect(row?.status).toBe('active');
    expect(row?.offboarded_at).toBeTruthy();
    expect(row?.offboarded_by).toBe(REVOKE_SYS);
  });

  it('allows offboarding a member with no transferable assets without a transfer target', async () => {
    const res = await offboard(
      NOASSET,
      { userAction: 'suspend' },
      { extraHeaders: { 'Idempotency-Key': 'off-main-noasset-key' } }
    );
    expect(res.status).toBe(200);
    const body = res.body as unknown as OffboardingBody;
    expect(body.transferTarget).toBeNull();
    expect(body.summary).toMatchObject({
      ownedFolderCount: 0,
      transferredFolderCount: 0,
      soleOwnerFolderCount: 0,
      sharedLinksTransferred: 0,
      sharedLinksRevoked: 0,
      fileRequestsTransferred: 0,
      fileRequestsDeactivated: 0,
      sessionsRevoked: 0,
      statusChanged: true,
    });
    expect(body.user.status).toBe('suspended');
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM audit_logs
          WHERE tenant_id = ? AND action = 'admin.user.offboard' AND target_id = ?`,
        TENANT,
        NOASSET
      )
    ).toBe(1);
  });

  it('rejects self-offboarding, the last sys_admin, guests, foreign tenants and invalid transfer targets', async () => {
    const self = await offboard(
      GUARD_SYS,
      { transferToUserId: GUARD_TARGET },
      { tenantId: GUARD_TENANT, actorId: GUARD_SYS }
    );
    expect(self.status).toBe(409);
    expect(self.body.code).toBe('CANNOT_SELF_OFFBOARD');

    const last = await offboard(LAST_SYS, {}, {
      tenantId: LAST_TENANT,
      actorId: VIRTUAL_SYS,
    });
    expect(last.status).toBe(409);
    expect(last.body.code).toBe('LAST_SYS_ADMIN_REQUIRED');

    const guest = await offboard(GUARD_GUEST, {}, {
      tenantId: GUARD_TENANT,
      actorId: GUARD_SYS,
    });
    expect(guest.status).toBe(404);
    expect(guest.body.code).toBe('NOT_INTERNAL_MEMBER');

    const foreign = await offboard(OUTSIDER, {}, {
      tenantId: TENANT,
      actorId: SYS,
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('MEMBER_NOT_FOUND');

    const missingTransfer = await offboard(
      GUARD_TARGET,
      {
        sharedLinksAction: 'transfer_owner',
        confirmation: 'OFFBOARD',
      },
      { tenantId: GUARD_TENANT, actorId: GUARD_SYS }
    );
    expect(missingTransfer.status).toBe(400);
    expect(missingTransfer.body.code).toBe('TRANSFER_TARGET_REQUIRED');

    const selfTransfer = await offboard(
      GUARD_TARGET,
      { transferToUserId: GUARD_TARGET },
      { tenantId: GUARD_TENANT, actorId: GUARD_SYS }
    );
    expect(selfTransfer.status).toBe(400);
    expect(selfTransfer.body.code).toBe('INVALID_TRANSFER_TARGET');

    const suspendedTransfer = await offboard(
      GUARD_TARGET,
      { transferToUserId: GUARD_SUSPENDED },
      { tenantId: GUARD_TENANT, actorId: GUARD_SYS }
    );
    expect(suspendedTransfer.status).toBe(409);
    expect(suspendedTransfer.body.code).toBe('TRANSFER_TARGET_INACTIVE');

    const guestTransfer = await offboard(
      GUARD_TARGET,
      { transferToUserId: GUARD_GUEST },
      { tenantId: GUARD_TENANT, actorId: GUARD_SYS }
    );
    expect(guestTransfer.status).toBe(409);
    expect(guestTransfer.body.code).toBe('TRANSFER_TARGET_NOT_MEMBER');

    // sec_admin cannot execute; members cannot execute either.
    const secExecute = await offboard(
      GUARD_TARGET,
      { transferToUserId: GUARD_SYS },
      { tenantId: GUARD_TENANT, actorId: GUARD_SEC, role: 'sec_admin' }
    );
    expect(secExecute.status).toBe(403);
    expect(secExecute.body.code).toBe('SYS_ADMIN_REQUIRED');

    const memberExecute = await offboard(
      GUARD_TARGET,
      {},
      { tenantId: GUARD_TENANT, actorId: GUARD_TARGET, role: 'member' }
    );
    expect(memberExecute.status).toBe(403);
  });

  it('replays the stored response for the same idempotency key and rejects key reuse with a different payload', async () => {
    const first = await offboard(
      REPLAY_LEAVER,
      {
        transferToUserId: REPLAY_SUCCESSOR,
        sharedLinksAction: 'revoke_all',
        fileRequestsAction: 'deactivate_all',
        userAction: 'suspend',
      },
      {
        tenantId: REPLAY_TENANT,
        actorId: REPLAY_SYS,
        extraHeaders: { 'Idempotency-Key': 'off-replay-key-1' },
      }
    );
    expect(first.status).toBe(200);
    const firstBody = first.body as unknown as OffboardingBody;
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.summary.transferredFolderCount).toBe(1);

    const replay = await offboard(
      REPLAY_LEAVER,
      {
        transferToUserId: REPLAY_SUCCESSOR,
        sharedLinksAction: 'revoke_all',
        fileRequestsAction: 'deactivate_all',
        userAction: 'suspend',
      },
      {
        tenantId: REPLAY_TENANT,
        actorId: REPLAY_SYS,
        extraHeaders: { 'Idempotency-Key': 'off-replay-key-1' },
      }
    );
    expect(replay.status).toBe(200);
    const replayBody = replay.body as unknown as OffboardingBody;
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.summary).toEqual(firstBody.summary);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM admin_bulk_idempotency
          WHERE tenant_id = ? AND idempotency_key = 'off-replay-key-1'
            AND status = 'completed'`,
        REPLAY_TENANT
      )
    ).toBe(1);

    const conflict = await offboard(
      REPLAY_LEAVER,
      {
        transferToUserId: REPLAY_SYS,
        sharedLinksAction: 'revoke_all',
        fileRequestsAction: 'deactivate_all',
        userAction: 'suspend',
      },
      {
        tenantId: REPLAY_TENANT,
        actorId: REPLAY_SYS,
        extraHeaders: { 'Idempotency-Key': 'off-replay-key-1' },
      }
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('keeps closed folder structure + waterfall inheritance coherent after ownership transfer', async () => {
    const res = await offboard(
      MODES_LEAVER,
      {
        transferToUserId: MODES_SUCCESSOR,
        sharedLinksAction: 'revoke_all',
        fileRequestsAction: 'deactivate_all',
      },
      { tenantId: MODES_TENANT, actorId: MODES_SYS }
    );
    expect(res.status).toBe(200);

    const rootChildren = await call<{
      folders: Array<{ id: string; name: string }>;
      files: Array<{ id: string; name: string }>;
    }>(
      `/api/folders/off-modes-root/children`,
      MODES_SUCCESSOR,
      { tenantId: MODES_TENANT }
    );
    expect(rootChildren.status).toBe(200);
    expect(
      rootChildren.body.folders.map((folder) => folder.id)
    ).toContain('off-modes-child');

    const childChildren = await call<{
      folders: Array<{ id: string }>;
      files: Array<{ id: string; name: string }>;
    }>(
      `/api/folders/off-modes-child/children`,
      MODES_SUCCESSOR,
      { tenantId: MODES_TENANT }
    );
    expect(childChildren.status).toBe(200);
    expect(childChildren.body.files.map((file) => file.id)).toContain(
      'off-modes-file'
    );

    // The original owner can no longer read the folder.
    const leaverChildren = await call(
      `/api/folders/off-modes-root/children`,
      MODES_LEAVER,
      { tenantId: MODES_TENANT }
    );
    expect([401, 403, 404]).toContain(leaverChildren.status);

    // Closure rows and the transfer grants remain consistent.
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM folder_closures
          WHERE tenant_id = ? AND ancestor_id = 'off-modes-root'
            AND descendant_id = 'off-modes-child' AND depth = 1`,
        MODES_TENANT
      )
    ).toBe(1);
    expect(
      await count(
        `SELECT COUNT(*) AS count FROM permissions
          WHERE tenant_id = ? AND target_type = 'folder' AND role = 'owner'
            AND grantee_type = 'user' AND grantee_id = ?
            AND target_id IN ('off-modes-root', 'off-modes-child')`,
        MODES_TENANT,
        MODES_SUCCESSOR
      )
    ).toBe(2);
  });
});
