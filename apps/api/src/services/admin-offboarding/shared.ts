import type { OidcEnv } from '../../types/oidc';
import { getFileLockState } from '../file-lock';
import {
  AdminOffboardingError,
  type AdminOffboardingFileRequestsAction,
  type AdminOffboardingHeldLock,
  type AdminOffboardingSharedLinksAction,
  type AdminOffboardingTransferCandidate,
  type AdminOffboardingUserAction,
} from './types';

export interface OffboardingTargetRow {
  id: string;
  email: string;
  display_name: string;
  role: 'sys_admin' | 'sec_admin' | 'member';
  status: 'active' | 'suspended';
  user_type: 'member' | 'guest';
  offboarded_at: string | null;
}

export interface OwnedFolderRow {
  id: string;
  name: string;
  classification: string;
  parent_id: string | null;
  created_at: string;
}

export interface DirectPermissionRow {
  id: string;
  target_type: 'folder' | 'file';
  target_id: string;
  folder_id: string | null;
}

export interface SharedLinkRow {
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

export interface FileRequestRow {
  id: string;
  folder_id: string;
  folder_name: string | null;
  title: string;
  submission_count: number;
  expires_at: string | null;
  created_at: string;
}

export interface WopiFileRow {
  file_id: string;
  file_name: string | null;
}

export interface TransferCandidateRow {
  id: string;
  email: string;
  display_name: string;
  role: 'sys_admin' | 'sec_admin' | 'member';
}

export const TRANSFER_CANDIDATE_LIMIT = 500;
export const LOCK_LOOKUP_CHUNK = 20;
export const OWNER_COUNT_CHUNK = 20;

export const SHARED_LINK_ACTIONS: readonly AdminOffboardingSharedLinksAction[] = [
  'transfer_owner',
  'revoke_all',
];
export const FILE_REQUEST_ACTIONS: readonly AdminOffboardingFileRequestsAction[] = [
  'transfer_owner',
  'deactivate_all',
];
export const USER_ACTIONS: readonly AdminOffboardingUserAction[] = [
  'suspend',
  'keep_status',
];

export async function loadTarget(
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

export function parseEnum<T extends string>(
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

export function parseBooleanOption(
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

export function normalizeTransferToUserId(value: unknown): string | null {
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

export function assertConfirmation(
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

export async function loadTransferCandidate(
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

export async function countActiveSysAdminsExcluding(
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

export async function loadHeldLocks(
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

export async function releaseHeldLocks(
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
