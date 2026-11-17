import type { AuthUser } from '../types/api';
import type { OidcEnv } from '../types/oidc';
import { chunkArray, executeBatchChunks } from '../utils/batch';
import {
  AdminBulkIdempotencyError,
  beginAdminBulkOperation,
} from './admin-bulk-idempotency';
import {
  loadMemberRowStrict,
  type AdminUserRow,
} from './admin-users';
import { buildAuditLogStmt } from './audit';
import { countEffectiveOwners } from './authorization';
import { getFileLockState } from './file-lock';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';

/**
 * P11-4 / TOM-70 internal member offboarding.
 *
 * An offboarding is a logical deactivation: users, files and audit history stay
 * in place, while ownership of directly-owned folders/link/request artefacts is
 * transferred to an active successor. Pre-existing `users.offboarded_at` /
 * `users.offboarded_by` columns from migration 0014 are reused, so no schema
 * change is required.
 *
 * The critical invariant is grant-before-revoke: every successor `owner` grant
 * is emitted before the leaver's direct permissions are deleted. A partial
 * failure therefore leaves duplicate ownership rather than an ownerless folder.
 */

export type AdminOffboardingSharedLinksAction = 'transfer_owner' | 'revoke_all';
export type AdminOffboardingFileRequestsAction =
  | 'transfer_owner'
  | 'deactivate_all';
export type AdminOffboardingUserAction = 'suspend' | 'keep_status';

export interface AdminOffboardingOwnedFolder {
  id: string;
  name: string;
  classification: string;
  parentId: string | null;
  isRoot: boolean;
  soleOwner: boolean;
  effectiveOwnerCount: number;
  createdAt: string;
}

export interface AdminOffboardingDirectPermissions {
  total: number;
  folder: number;
  file: number;
  folderCount: number;
  fileCount: number;
}

export interface AdminOffboardingSharedLink {
  id: string;
  targetType: 'folder' | 'file';
  targetId: string;
  targetName: string | null;
  accessScope: string;
  canDownload: boolean;
  requireWatermark: boolean;
  expiresAt: string | null;
  createdAt: string;
}

export interface AdminOffboardingFileRequest {
  id: string;
  folderId: string;
  folderName: string | null;
  title: string;
  submissionCount: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface AdminOffboardingHeldLock {
  fileId: string;
  fileName: string | null;
  mode: 'wopi_collab' | 'desktop_exclusive';
  lockId: string;
  expiresAt: string;
}

export interface AdminOffboardingTransferCandidate {
  id: string;
  email: string;
  displayName: string;
  role: 'sys_admin' | 'sec_admin' | 'member';
}

export interface AdminOffboardingPreview {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: 'sys_admin' | 'sec_admin' | 'member';
    status: 'active' | 'suspended';
    userType: 'member' | 'guest';
    offboardedAt: string | null;
  };
  ownedFolders: AdminOffboardingOwnedFolder[];
  ownedFolderCount: number;
  soleOwnerCount: number;
  directPermissions: AdminOffboardingDirectPermissions;
  activeSharedLinks: AdminOffboardingSharedLink[];
  activeFileRequests: AdminOffboardingFileRequest[];
  heldLocks: AdminOffboardingHeldLock[];
  activeSessionCount: number;
  activeWopiSessionCount: number;
  groupMembershipCount: number;
  transferCandidates: AdminOffboardingTransferCandidate[];
  generatedAt: string;
}

export interface AdminOffboardingSummary {
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
}

export interface AdminOffboardingResult {
  ok: true;
  replayed: boolean;
  user: AdminUserRow;
  transferTarget: AdminOffboardingTransferCandidate | null;
  options: {
    sharedLinksAction: AdminOffboardingSharedLinksAction;
    fileRequestsAction: AdminOffboardingFileRequestsAction;
    userAction: AdminOffboardingUserAction;
    revokeDirectPermissions: boolean;
    removeGroupMemberships: boolean;
    releaseHeldLocks: boolean;
  };
  summary: AdminOffboardingSummary;
  syncSeq: number | null;
  notice: string;
}

export class AdminOffboardingError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminOffboardingError';
  }
}

export { AdminBulkIdempotencyError };

interface OffboardingTargetRow {
  id: string;
  email: string;
  display_name: string;
  role: 'sys_admin' | 'sec_admin' | 'member';
  status: 'active' | 'suspended';
  user_type: 'member' | 'guest';
  offboarded_at: string | null;
}

interface OwnedFolderRow {
  id: string;
  name: string;
  classification: string;
  parent_id: string | null;
  created_at: string;
}

interface DirectPermissionRow {
  id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  folder_id: string | null;
}

interface SharedLinkRow {
  id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  target_name: string | null;
  access_scope: string;
  can_download: number;
  require_watermark: number;
  expires_at: string | null;
  created_at: string;
}

interface FileRequestRow {
  id: string;
  folder_id: string;
  folder_name: string | null;
  title: string;
  submission_count: number;
  expires_at: string | null;
  created_at: string;
}

interface WopiFileRow {
  file_id: string;
  file_name: string | null;
}

interface TransferCandidateRow {
  id: string;
  email: string;
  display_name: string;
  role: 'sys_admin' | 'sec_admin' | 'member';
}

const TRANSFER_CANDIDATE_LIMIT = 500;
const LOCK_LOOKUP_CHUNK = 20;
const OWNER_COUNT_CHUNK = 20;

const SHARED_LINK_ACTIONS: readonly AdminOffboardingSharedLinksAction[] = [
  'transfer_owner',
  'revoke_all',
];
const FILE_REQUEST_ACTIONS: readonly AdminOffboardingFileRequestsAction[] = [
  'transfer_owner',
  'deactivate_all',
];
const USER_ACTIONS: readonly AdminOffboardingUserAction[] = [
  'suspend',
  'keep_status',
];

async function loadTarget(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<OffboardingTargetRow> {
  const row = await db
    .prepare(
      `SELECT id, email, display_name, role, status, user_type, offboarded_at
         FROM users
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, userId)
    .first<OffboardingTargetRow>();
  if (!row) {
    throw new AdminOffboardingError(
      404,
      'MEMBER_NOT_FOUND',
      'Internal member not found'
    );
  }
  if (row.user_type !== 'member') {
    throw new AdminOffboardingError(
      404,
      'NOT_INTERNAL_MEMBER',
      'Guest accounts are managed by the guest lifecycle console'
    );
  }
  return row;
}

function parseEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T
): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AdminOffboardingError(
      400,
      'INVALID_OFFBOARDING_OPTION',
      `${field} must be one of ${allowed.join(', ')}`
    );
  }
  return value as T;
}

function parseBooleanOption(
  value: unknown,
  field: string,
  fallback: boolean
): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new AdminOffboardingError(
      400,
      'INVALID_OFFBOARDING_OPTION',
      `${field} must be a boolean`
    );
  }
  return value;
}

function normalizeTransferToUserId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AdminOffboardingError(
      400,
      'INVALID_TRANSFER_TARGET',
      'transferToUserId must be a non-empty user id or null'
    );
  }
  return value.trim();
}

function assertConfirmation(
  value: unknown,
  target: Pick<OffboardingTargetRow, 'email'>
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    throw new AdminOffboardingError(
      400,
      'INVALID_CONFIRMATION',
      'confirmation must be a string'
    );
  }
  const normalized = value.trim();
  const matchesEmail =
    normalized.toLowerCase() === target.email.trim().toLowerCase();
  if (normalized !== 'OFFBOARD' && !matchesEmail) {
    throw new AdminOffboardingError(
      400,
      'INVALID_CONFIRMATION',
      'confirmation must be OFFBOARD or the target member email'
    );
  }
}

async function loadTransferCandidate(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<AdminOffboardingTransferCandidate> {
  const row = await db
    .prepare(
      `SELECT id, email, display_name, role, status, user_type
         FROM users
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, userId)
    .first<
      TransferCandidateRow & {
        status: 'active' | 'suspended';
        user_type: 'member' | 'guest';
      }
    >();
  if (!row) {
    throw new AdminOffboardingError(
      400,
      'INVALID_TRANSFER_TARGET',
      'Transfer target was not found in this tenant'
    );
  }
  if (row.user_type !== 'member') {
    throw new AdminOffboardingError(
      409,
      'TRANSFER_TARGET_NOT_MEMBER',
      'Ownership can only be transferred to an internal member'
    );
  }
  if (row.status !== 'active') {
    throw new AdminOffboardingError(
      409,
      'TRANSFER_TARGET_INACTIVE',
      'Ownership can only be transferred to an active member'
    );
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}

async function countActiveSysAdminsExcluding(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM users
        WHERE tenant_id = ? AND user_type = 'member'
          AND role = 'sys_admin' AND status = 'active' AND id <> ?`
    )
    .bind(tenantId, userId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function loadHeldLocks(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  userId: string,
  nowIso: string
): Promise<AdminOffboardingHeldLock[]> {
  const wopiFiles = await env.DB.prepare(
    `SELECT DISTINCT ws.file_id, fl.name AS file_name
       FROM wopi_sessions ws
       LEFT JOIN files fl
         ON fl.tenant_id = ws.tenant_id AND fl.id = ws.file_id
      WHERE ws.tenant_id = ?
        AND ws.user_id = ?
        AND ws.is_active = 1
        AND ws.expires_at > ?`
  )
    .bind(tenantId, userId, nowIso)
    .all<WopiFileRow>();

  const locks: AdminOffboardingHeldLock[] = [];
  for (let index = 0; index < wopiFiles.results.length; index += LOCK_LOOKUP_CHUNK) {
    const chunk = wopiFiles.results.slice(index, index + LOCK_LOOKUP_CHUNK);
    const states = await Promise.all(
      chunk.map((row) => getFileLockState(env, row.file_id))
    );
    states.forEach((state, offset) => {
      const row = chunk[offset]!;
      if (
        !state ||
        state.ownerId !== userId ||
        state.tenantId !== tenantId
      ) {
        return;
      }
      locks.push({
        fileId: row.file_id,
        fileName: row.file_name,
        mode: state.mode,
        lockId: state.lockId,
        expiresAt: new Date(state.expiresAt).toISOString(),
      });
    });
  }
  return locks;
}

/**
 * Read-only inventory. `soleOwner` intentionally uses the shared
 * `countEffectiveOwners` definition (direct + inherited owner assignments), so
 * the preview and the transfer guard agree on which folders need a successor.
 */
export async function loadAdminOffboardingPreview(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  userId: string
): Promise<AdminOffboardingPreview> {
  const db = env.DB;
  const target = await loadTarget(db, tenantId, userId);
  const nowIso = new Date().toISOString();

  const [
    ownedFolderRows,
    directPermissionCounts,
    sharedLinkRows,
    fileRequestRows,
    activeSessionRow,
    activeWopiSessionRow,
    groupMembershipRow,
    candidateRows,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT f.id, f.name, f.classification, f.parent_id, f.created_at
           FROM permissions p
           JOIN folders f
             ON f.tenant_id = p.tenant_id AND f.id = p.target_id
          WHERE p.tenant_id = ?
            AND p.target_type = 'folder'
            AND p.grantee_type = 'user'
            AND p.grantee_id = ?
            AND p.role = 'owner'
            AND f.deleted_at IS NULL
          ORDER BY f.name ASC, f.id ASC`
      )
      .bind(tenantId, userId)
      .all<OwnedFolderRow>(),
    db
      .prepare(
        `SELECT target_type, COUNT(*) AS count
           FROM permissions
          WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?
          GROUP BY target_type`
      )
      .bind(tenantId, userId)
      .all<{ target_type: 'folder' | 'file'; count: number }>(),
    db
      .prepare(
        `SELECT sl.id, sl.target_type, sl.target_id,
                COALESCE(f.name, fl.name) AS target_name,
                sl.access_scope, sl.can_download, sl.require_watermark,
                sl.expires_at, sl.created_at
           FROM shared_links sl
           LEFT JOIN folders f
             ON sl.target_type = 'folder'
            AND f.tenant_id = sl.tenant_id
            AND f.id = sl.target_id
           LEFT JOIN files fl
             ON sl.target_type = 'file'
            AND fl.tenant_id = sl.tenant_id
            AND fl.id = sl.target_id
          WHERE sl.tenant_id = ?
            AND sl.created_by = ?
            AND sl.revoked_at IS NULL
          ORDER BY sl.created_at DESC, sl.id ASC`
      )
      .bind(tenantId, userId)
      .all<SharedLinkRow>(),
    db
      .prepare(
        `SELECT fr.id, fr.folder_id, f.name AS folder_name, fr.title,
                fr.submission_count, fr.expires_at, fr.created_at
           FROM file_requests fr
           LEFT JOIN folders f
             ON f.tenant_id = fr.tenant_id AND f.id = fr.folder_id
          WHERE fr.tenant_id = ?
            AND fr.created_by = ?
            AND fr.is_active = 1
          ORDER BY fr.created_at DESC, fr.id ASC`
      )
      .bind(tenantId, userId)
      .all<FileRequestRow>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE tenant_id = ? AND user_id = ?
            AND revoked_at IS NULL AND expires_at > ?`
      )
      .bind(tenantId, userId, nowIso)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM wopi_sessions
          WHERE tenant_id = ? AND user_id = ?
            AND is_active = 1 AND expires_at > ?`
      )
      .bind(tenantId, userId, nowIso)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM group_members gm
           JOIN groups g ON g.id = gm.group_id
          WHERE g.tenant_id = ? AND gm.user_id = ?`
      )
      .bind(tenantId, userId)
      .first<{ count: number }>(),
    db
      .prepare(
        `SELECT id, email, display_name, role
           FROM users
          WHERE tenant_id = ?
            AND user_type = 'member'
            AND status = 'active'
            AND id <> ?
          ORDER BY display_name ASC, email ASC
          LIMIT ${TRANSFER_CANDIDATE_LIMIT}`
      )
      .bind(tenantId, userId)
      .all<TransferCandidateRow>(),
  ]);

  const folderCounts: number[] = [];
  for (const chunk of chunkArray(ownedFolderRows.results, OWNER_COUNT_CHUNK)) {
    const counts = await Promise.all(
      chunk.map((folder) =>
        countEffectiveOwners(db, tenantId, 'folder', folder.id, null)
      )
    );
    folderCounts.push(...counts);
  }
  const ownedFolders: AdminOffboardingOwnedFolder[] = ownedFolderRows.results.map(
    (folder, index) => {
      const effectiveOwnerCount = folderCounts[index] ?? 0;
      return {
        id: folder.id,
        name: folder.name,
        classification: folder.classification,
        parentId: folder.parent_id,
        isRoot: folder.parent_id === null,
        soleOwner: effectiveOwnerCount <= 1,
        effectiveOwnerCount,
        createdAt: folder.created_at,
      };
    }
  );

  let folderPermissionCount = 0;
  let filePermissionCount = 0;
  for (const row of directPermissionCounts.results) {
    if (row.target_type === 'folder') folderPermissionCount = row.count;
    if (row.target_type === 'file') filePermissionCount = row.count;
  }

  return {
    user: {
      id: target.id,
      email: target.email,
      displayName: target.display_name,
      role: target.role,
      status: target.status,
      userType: target.user_type,
      offboardedAt: target.offboarded_at,
    },
    ownedFolders,
    ownedFolderCount: ownedFolders.length,
    soleOwnerCount: ownedFolders.filter((folder) => folder.soleOwner).length,
    directPermissions: {
      total: folderPermissionCount + filePermissionCount,
      folder: folderPermissionCount,
      file: filePermissionCount,
      folderCount: folderPermissionCount,
      fileCount: filePermissionCount,
    },
    activeSharedLinks: sharedLinkRows.results.map((row) => ({
      id: row.id,
      targetType: row.target_type,
      targetId: row.target_id,
      targetName: row.target_name,
      accessScope: row.access_scope,
      canDownload: row.can_download === 1,
      requireWatermark: row.require_watermark === 1,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
    activeFileRequests: fileRequestRows.results.map((row) => ({
      id: row.id,
      folderId: row.folder_id,
      folderName: row.folder_name,
      title: row.title,
      submissionCount: row.submission_count,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    })),
    heldLocks: await loadHeldLocks(env, tenantId, userId, nowIso),
    activeSessionCount: activeSessionRow?.count ?? 0,
    activeWopiSessionCount: activeWopiSessionRow?.count ?? 0,
    groupMembershipCount: groupMembershipRow?.count ?? 0,
    transferCandidates: candidateRows.results.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    })),
    generatedAt: nowIso,
  };
}

async function releaseHeldLocks(
  env: Pick<OidcEnv, 'FILE_LOCK_HUB'>,
  tenantId: string,
  userId: string,
  locks: readonly AdminOffboardingHeldLock[]
): Promise<number> {
  if (!env.FILE_LOCK_HUB || locks.length === 0) return 0;
  let released = 0;
  for (const lock of locks) {
    try {
      const stub = env.FILE_LOCK_HUB.get(
        env.FILE_LOCK_HUB.idFromName(lock.fileId)
      );
      const current = await stub.getLock({ fileId: lock.fileId });
      if (
        !current.lock ||
        current.lock.ownerId !== userId ||
        current.lock.tenantId !== tenantId
      ) {
        continue;
      }
      const result = await stub.unlockFile({
        fileId: lock.fileId,
        lockId: current.lock.lockId,
      });
      if (result.ok && result.released) released += 1;
    } catch (err) {
      console.warn(
        `[admin-offboarding] Failed to release lock for ${lock.fileId}:`,
        err
      );
    }
  }
  return released;
}

/**
 * Execute an offboarding. Callers must already have restricted this endpoint to
 * `sys_admin`; the role check below is a defence-in-depth assertion.
 */
export async function offboardAdminMember(
  input: {
    env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>;
    tenantId: string;
    userId: string;
    actor: AuthUser;
    transferToUserId?: unknown;
    sharedLinksAction?: unknown;
    fileRequestsAction?: unknown;
    userAction?: unknown;
    suspendOrRemoveUser?: unknown;
    revokeDirectPermissions?: unknown;
    removeGroupMemberships?: unknown;
    releaseHeldLocks?: unknown;
    confirmation?: unknown;
    idempotencyKey?: string | null;
  }
): Promise<AdminOffboardingResult> {
  const { env, tenantId, userId, actor } = input;
  const db = env.DB;

  if (actor.role !== 'sys_admin') {
    throw new AdminOffboardingError(
      403,
      'SYS_ADMIN_REQUIRED',
      'Only sys_admin can offboard internal members'
    );
  }

  const target = await loadTarget(db, tenantId, userId);
  if (target.id === actor.id) {
    throw new AdminOffboardingError(
      409,
      'CANNOT_SELF_OFFBOARD',
      'You cannot offboard your own account'
    );
  }
  if (target.role === 'sys_admin' && target.status === 'active') {
    const remaining = await countActiveSysAdminsExcluding(db, tenantId, target.id);
    if (remaining === 0) {
      throw new AdminOffboardingError(
        409,
        'LAST_SYS_ADMIN_REQUIRED',
        'At least one active sys_admin must remain'
      );
    }
  }

  const transferToUserId = normalizeTransferToUserId(input.transferToUserId);
  const sharedLinksAction = parseEnum(
    input.sharedLinksAction,
    'sharedLinksAction',
    SHARED_LINK_ACTIONS,
    transferToUserId ? 'transfer_owner' : 'revoke_all'
  );
  const fileRequestsAction = parseEnum(
    input.fileRequestsAction,
    'fileRequestsAction',
    FILE_REQUEST_ACTIONS,
    transferToUserId ? 'transfer_owner' : 'deactivate_all'
  );
  const userAction = parseEnum(
    input.userAction ?? input.suspendOrRemoveUser,
    'userAction',
    USER_ACTIONS,
    'suspend'
  );
  const revokeDirectPermissions = parseBooleanOption(
    input.revokeDirectPermissions,
    'revokeDirectPermissions',
    true
  );
  const removeGroupMemberships = parseBooleanOption(
    input.removeGroupMemberships,
    'removeGroupMemberships',
    true
  );
  const releaseHeldLockFlag = parseBooleanOption(
    input.releaseHeldLocks,
    'releaseHeldLocks',
    true
  );
  assertConfirmation(input.confirmation, target);

  if (transferToUserId === target.id) {
    throw new AdminOffboardingError(
      400,
      'INVALID_TRANSFER_TARGET',
      'The transfer target must be a different member'
    );
  }

  const preview = await loadAdminOffboardingPreview(env, tenantId, userId);
  const needsTransfer =
    preview.ownedFolders.length > 0 ||
    sharedLinksAction === 'transfer_owner' ||
    fileRequestsAction === 'transfer_owner';
  if (needsTransfer && !transferToUserId) {
    throw new AdminOffboardingError(
      400,
      'TRANSFER_TARGET_REQUIRED',
      'transferToUserId is required when folders, shared links or file requests are transferred'
    );
  }

  const transferTarget = transferToUserId
    ? await loadTransferCandidate(db, tenantId, transferToUserId)
    : null;

  const payload = {
    userId,
    transferToUserId,
    sharedLinksAction,
    fileRequestsAction,
    userAction,
    revokeDirectPermissions,
    removeGroupMemberships,
    releaseHeldLocks: releaseHeldLockFlag,
  };

  const session = await beginAdminBulkOperation<AdminOffboardingResult>({
    db,
    tenantId,
    operation: 'admin.user.offboard',
    idempotencyKey: input.idempotencyKey ?? null,
    payload,
  });
  if (session.kind === 'replay') {
    return { ...session.response, replayed: true };
  }

  try {
    const nowIso = new Date().toISOString();
    const directPermissionRows = revokeDirectPermissions
      ? await db
          .prepare(
            `SELECT p.id, p.target_type, p.target_id,
                    CASE
                      WHEN p.target_type = 'folder' THEN p.target_id
                      ELSE fl.folder_id
                    END AS folder_id
               FROM permissions p
               LEFT JOIN files fl
                 ON p.target_type = 'file'
                AND fl.tenant_id = p.tenant_id
                AND fl.id = p.target_id
              WHERE p.tenant_id = ?
                AND p.grantee_type = 'user'
                AND p.grantee_id = ?`
          )
          .bind(tenantId, userId)
          .all<DirectPermissionRow>()
      : { results: [] as DirectPermissionRow[] };

    const statements: D1PreparedStatement[] = [];

    // Phase 1: grant the successor BEFORE any leaver permission is removed.
    if (transferTarget) {
      for (const folder of preview.ownedFolders) {
        statements.push(
          db
            .prepare(
              `INSERT INTO permissions (
                 id, tenant_id, target_type, target_id, grantee_type,
                 grantee_id, role, granted_by, created_at
               ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)
               ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
               DO UPDATE SET role = 'owner', granted_by = excluded.granted_by`
            )
            .bind(
              crypto.randomUUID(),
              tenantId,
              folder.id,
              transferTarget.id,
              actor.id,
              nowIso
            )
        );
        statements.push(
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'permission',
            entityId: `${folder.id}:user:${transferTarget.id}`,
            folderId: folder.id,
            action: 'permission.grant',
            payload: {
              targetType: 'folder',
              targetId: folder.id,
              granteeType: 'user',
              granteeId: transferTarget.id,
              role: 'owner',
              reason: 'admin_offboarding',
            },
            nowIso,
          })
        );
      }
    }

    // Phase 2: remove the leaver's direct grants (owner grants now duplicated).
    if (revokeDirectPermissions) {
      statements.push(
        db
          .prepare(
            `DELETE FROM permissions
              WHERE tenant_id = ? AND grantee_type = 'user' AND grantee_id = ?`
          )
          .bind(tenantId, userId)
      );
      for (const permission of directPermissionRows.results) {
        statements.push(
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'permission',
            entityId: `${permission.target_type}:${permission.target_id}:user:${userId}`,
            folderId: permission.folder_id,
            targetUserId: userId,
            action: 'permission.revoke',
            payload: {
              targetType: permission.target_type,
              targetId: permission.target_id,
              granteeType: 'user',
              granteeId: userId,
              reason: 'admin_offboarding',
            },
            nowIso,
          })
        );
      }
    }

    // Phase 3: shared links.
    if (sharedLinksAction === 'transfer_owner' && transferTarget) {
      statements.push(
        db
          .prepare(
            `UPDATE shared_links
                SET created_by = ?
              WHERE tenant_id = ? AND created_by = ? AND revoked_at IS NULL`
          )
          .bind(transferTarget.id, tenantId, userId)
      );
      for (const link of preview.activeSharedLinks) {
        statements.push(
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'shared_link',
            entityId: link.id,
            folderId: link.targetType === 'folder' ? link.targetId : null,
            action: 'shared_link.transfer_owner',
            payload: {
              targetType: link.targetType,
              targetId: link.targetId,
              previousOwnerId: userId,
              newOwnerId: transferTarget.id,
            },
            nowIso,
          })
        );
      }
    } else if (sharedLinksAction === 'revoke_all') {
      statements.push(
        db
          .prepare(
            `UPDATE shared_links
                SET revoked_at = ?, revoked_by = ?
              WHERE tenant_id = ? AND created_by = ? AND revoked_at IS NULL`
          )
          .bind(nowIso, actor.id, tenantId, userId)
      );
      for (const link of preview.activeSharedLinks) {
        statements.push(
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'shared_link',
            entityId: link.id,
            folderId: link.targetType === 'folder' ? link.targetId : null,
            action: 'shared_link.revoke',
            payload: {
              targetType: link.targetType,
              targetId: link.targetId,
              revokedBy: actor.id,
              reason: 'admin_offboarding',
            },
            nowIso,
          })
        );
      }
    }

    // Phase 4: file requests. `sync_changes` has no file_request entity type,
    // so these events are scoped to the destination folder for invalidation.
    if (fileRequestsAction === 'transfer_owner' && transferTarget) {
      statements.push(
        db
          .prepare(
            `UPDATE file_requests
                SET created_by = ?
              WHERE tenant_id = ? AND created_by = ? AND is_active = 1`
          )
          .bind(transferTarget.id, tenantId, userId)
      );
      for (const request of preview.activeFileRequests) {
        statements.push(
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'folder',
            entityId: request.folderId,
            folderId: request.folderId,
            action: 'file_request.transfer_owner',
            payload: {
              fileRequestId: request.id,
              previousOwnerId: userId,
              newOwnerId: transferTarget.id,
            },
            nowIso,
          })
        );
      }
    } else if (fileRequestsAction === 'deactivate_all') {
      statements.push(
        db
          .prepare(
            `UPDATE file_requests
                SET is_active = 0
              WHERE tenant_id = ? AND created_by = ? AND is_active = 1`
          )
          .bind(tenantId, userId)
      );
      for (const request of preview.activeFileRequests) {
        statements.push(
          buildSyncChangeStmt(db, {
            tenantId,
            entityType: 'folder',
            entityId: request.folderId,
            folderId: request.folderId,
            action: 'file_request.deactivate',
            payload: {
              fileRequestId: request.id,
              reason: 'admin_offboarding',
            },
            nowIso,
          })
        );
      }
    }

    // Phase 5: sessions / WOPI locks / group memberships.
    statements.push(
      db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE tenant_id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .bind(nowIso, tenantId, userId)
    );
    if (releaseHeldLockFlag) {
      statements.push(
        db
          .prepare(
            `UPDATE wopi_sessions
                SET is_active = 0, revoked_at = ?
              WHERE tenant_id = ? AND user_id = ? AND is_active = 1`
          )
          .bind(nowIso, tenantId, userId)
      );
    }
    if (removeGroupMemberships) {
      // Deliberate tenant-wide cleanup: offboarding removes every membership in
      // this tenant (manual and SCIM-backed). Cross-tenant memberships cannot
      // exist because `groups` is tenant-scoped.
      statements.push(
        db
          .prepare(
            `DELETE FROM group_members
              WHERE user_id = ?
                AND group_id IN (
                  SELECT id FROM groups WHERE tenant_id = ?
                )`
          )
          .bind(userId, tenantId)
      );
    }

    // Phase 6: account state. `keep_status` still records the offboarding for
    // auditability but leaves the account usable after a fresh login.
    if (userAction === 'suspend') {
      statements.push(
        db
          .prepare(
            `UPDATE users
                SET status = 'suspended',
                    offboarded_at = ?,
                    offboarded_by = ?,
                    updated_at = ?
              WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
          )
          .bind(nowIso, actor.id, nowIso, tenantId, userId)
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE users
                SET offboarded_at = ?,
                    offboarded_by = ?,
                    updated_at = ?
              WHERE tenant_id = ? AND id = ? AND user_type = 'member'`
          )
          .bind(nowIso, actor.id, nowIso, tenantId, userId)
      );
    }

    const summary: AdminOffboardingSummary = {
      ownedFolderCount: preview.ownedFolders.length,
      transferredFolderCount: transferTarget ? preview.ownedFolders.length : 0,
      soleOwnerFolderCount: preview.soleOwnerCount,
      directPermissionsRevoked: revokeDirectPermissions
        ? directPermissionRows.results.length
        : 0,
      groupMembershipsRemoved: removeGroupMemberships
        ? preview.groupMembershipCount
        : 0,
      sharedLinksTransferred:
        sharedLinksAction === 'transfer_owner'
          ? preview.activeSharedLinks.length
          : 0,
      sharedLinksRevoked:
        sharedLinksAction === 'revoke_all'
          ? preview.activeSharedLinks.length
          : 0,
      fileRequestsTransferred:
        fileRequestsAction === 'transfer_owner'
          ? preview.activeFileRequests.length
          : 0,
      fileRequestsDeactivated:
        fileRequestsAction === 'deactivate_all'
          ? preview.activeFileRequests.length
          : 0,
      sessionsRevoked: preview.activeSessionCount,
      wopiSessionsRevoked: releaseHeldLockFlag
        ? preview.activeWopiSessionCount
        : 0,
      locksReleased: 0,
      statusChanged: userAction === 'suspend' && target.status !== 'suspended',
    };

    statements.push(
      buildAuditLogStmt(db, {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.user.offboard',
        targetType: 'user',
        targetId: target.id,
        metadata: {
          userId: target.id,
          email: target.email,
          role: target.role,
          previousStatus: target.status,
          transferToUserId: transferTarget?.id ?? null,
          options: {
            sharedLinksAction,
            fileRequestsAction,
            userAction,
            revokeDirectPermissions,
            removeGroupMemberships,
            releaseHeldLocks: releaseHeldLockFlag,
          },
          counts: { ...summary, locksReleased: undefined },
          affectedFolderIds: preview.ownedFolders.map((folder) => folder.id),
          offboardedAt: nowIso,
        },
        nowIso,
      }),
      buildSyncChangeStmt(db, {
        tenantId,
        entityType: 'user',
        entityId: target.id,
        targetUserId: target.id,
        action: userAction === 'suspend' ? 'user.suspended' : 'admin.user.offboard',
        payload: {
          email: target.email,
          status: userAction === 'suspend' ? 'suspended' : target.status,
          reason: 'admin_offboard',
          offboardedAt: nowIso,
          transferToUserId: transferTarget?.id ?? null,
        },
        nowIso,
      })
    );

    const results = await executeBatchChunks(db, statements);
    summary.locksReleased = releaseHeldLockFlag
      ? await releaseHeldLocks(env, tenantId, userId, preview.heldLocks)
      : 0;

    const response: AdminOffboardingResult = {
      ok: true,
      replayed: false,
      user: await loadMemberRowStrict(db, tenantId, target.id),
      transferTarget,
      options: {
        sharedLinksAction,
        fileRequestsAction,
        userAction,
        revokeDirectPermissions,
        removeGroupMemberships,
        releaseHeldLocks: releaseHeldLockFlag,
      },
      summary,
      syncSeq: extractLastSyncSeq(results),
      notice: `${
        target.email
      } をオフボーディングしました。フォルダ ${summary.transferredFolderCount} 件を移管、共有リンク ${summary.sharedLinksTransferred} 件を移管 / ${summary.sharedLinksRevoked} 件を失効、ファイルリクエスト ${summary.fileRequestsTransferred} 件を移管 / ${summary.fileRequestsDeactivated} 件を停止、有効セッション ${summary.sessionsRevoked} 件を失効させました。`,
    };
    return await session.complete(response);
  } catch (err) {
    await session.fail();
    throw err;
  }
}
