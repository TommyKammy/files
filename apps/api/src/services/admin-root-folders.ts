import type { AuthUser, ClassificationLabel } from '../types/api';
import type { OidcEnv } from '../types/oidc';
import { chunkArray } from '../utils/batch';
import { VALID_CLASSIFICATIONS } from '../utils/classification';
import { buildAuditLogStmt } from './audit';
import { buildRootFolderResetStmt } from './root-folder-stats';
import { getFileLockState, FileLockedError } from './file-lock';
import { restoreFolderWithOptions } from './folder-closure/restore-options';
import { validateFolderName } from './folder-closure/shared';
import {
  getFolderStructureMode,
  type FolderStructureMode,
} from './folder-structure';
import { buildSyncChangeStmt } from './sync-changes';
import { extractLastSyncSeq } from './sync-notifier';

const ROOT_PERMISSION_CHUNK = 30;
const FILE_LOCK_CHECK_CHUNK = 20;

export interface AdminRootFolderCandidate {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  deleted_at: string | null;
}

export interface AdminRootOwnerRef {
  grantee_type: 'user' | 'group';
  grantee_id: string;
}

export interface AdminRootCoOwnerStatementBundle {
  statements: D1PreparedStatement[];
  syncStatements: D1PreparedStatement[];
}

export type AdminRootOwnerStatus = 'active' | 'suspended';

export interface AdminRootOwnerGrant {
  granteeType: 'user' | 'group';
  granteeId: string;
  name: string;
  email: string | null;
  status: AdminRootOwnerStatus;
}

export interface AdminRootCoOwnerGrant extends AdminRootOwnerGrant {
  granteeType: 'user' | 'group';
}

export interface AdminRootFolderRecord {
  id: string;
  name: string;
  classification: ClassificationLabel;
  isPinned: boolean;
  version: number;
  createdBy: string;
  createdByName: string;
  createdByEmail: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedBy: string | null;
  owners: AdminRootOwnerGrant[];
  coOwners: AdminRootCoOwnerGrant[];
  itemCount: number;
  totalBytes: number;
  ownerMissing: boolean;
  hasSuspendedOwner: boolean;
}

export interface AdminRootFolderSummary {
  totalRootFolders: number;
  activeRootFolders: number;
  archivedRootFolders: number;
  missingOwnerCount: number;
  suspendedOwnerCount: number;
  totalBytes: number;
  folderStructureMode: FolderStructureMode;
}

export interface AdminRootFolderListResult {
  roots: AdminRootFolderRecord[];
  summary: AdminRootFolderSummary;
}

export interface AdminRootFolderMutationResult {
  root: AdminRootFolderRecord;
  syncSeq: number | null;
}

export class AdminRootFolderError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminRootFolderError';
  }
}

interface RootFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  is_pinned: number;
  version: number;
  created_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
  created_by_name: string | null;
  created_by_email: string | null;
}

interface PermissionGrantRow {
  target_id: string;
  grantee_type: 'user' | 'group';
  grantee_id: string;
  role: 'owner' | 'co_owner';
  name: string | null;
  email: string | null;
  status: AdminRootOwnerStatus | null;
}

interface RootMetricRow {
  root_id: string;
  item_count: number;
  total_bytes: number;
}

function isRootFolderRow(row: RootFolderRow | null): row is RootFolderRow {
  return row !== null;
}

export function normalizeIdArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AdminRootFolderError(
      400,
      'INVALID_GRANTEE_LIST',
      `${field} must be an array of ids`
    );
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new AdminRootFolderError(
        400,
        'INVALID_GRANTEE',
        `${field} must contain non-empty ids`
      );
    }
    const id = raw.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export async function assertActiveUser(
  db: D1Database,
  tenantId: string,
  userId: string,
  code = 'INVALID_OWNER'
): Promise<void> {
  const row = await db
    .prepare('SELECT id, status FROM users WHERE tenant_id = ? AND id = ?')
    .bind(tenantId, userId)
    .first<{ id: string; status: 'active' | 'suspended' }>();
  if (!row) {
    throw new AdminRootFolderError(400, code, 'User not found in tenant');
  }
  if (row.status !== 'active') {
    throw new AdminRootFolderError(400, 'SUSPENDED_USER_BLOCKED', 'User is suspended');
  }
}

export async function assertTenantGroups(
  db: D1Database,
  tenantId: string,
  groupIds: readonly string[]
): Promise<void> {
  if (groupIds.length === 0) return;
  for (const chunk of chunkArray([...groupIds], ROOT_PERMISSION_CHUNK)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id FROM groups WHERE tenant_id = ? AND id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<{ id: string }>();
    if (rows.results.length !== chunk.length) {
      throw new AdminRootFolderError(
        400,
        'INVALID_GROUP',
        'Group not found in tenant'
      );
    }
  }
}

export async function loadRootFolderRow(
  db: D1Database,
  tenantId: string,
  folderId: string,
  options: { allowDeleted?: boolean } = {}
): Promise<RootFolderRow> {
  const row = await db
    .prepare(
      `SELECT f.id, f.parent_id, f.name, f.classification, f.is_pinned, f.version,
              f.created_by, f.deleted_at, f.deleted_by, f.created_at, f.updated_at,
              u.display_name AS created_by_name,
              u.email AS created_by_email
         FROM folders f
         LEFT JOIN users u
           ON u.tenant_id = f.tenant_id AND u.id = f.created_by
        WHERE f.tenant_id = ? AND f.id = ?`
    )
    .bind(tenantId, folderId)
    .first<RootFolderRow>();
  if (!row) {
    throw new AdminRootFolderError(404, 'NOT_FOUND', 'Root folder not found');
  }
  if (row.parent_id !== null) {
    throw new AdminRootFolderError(
      400,
      'NOT_ROOT_FOLDER',
      'Target folder is not a workspace root folder'
    );
  }
  if (row.deleted_at !== null && !options.allowDeleted) {
    throw new AdminRootFolderError(404, 'NOT_FOUND', 'Root folder not found');
  }
  return row;
}

/**
 * Load root-folder candidates without throwing for missing/non-root/archived
 * ids. Bulk operations need per-item results, so a cross-tenant or unknown id
 * simply never appears in the returned map.
 */
export async function loadAdminRootFolderCandidates(
  db: D1Database,
  tenantId: string,
  folderIds: readonly string[]
): Promise<Map<string, AdminRootFolderCandidate>> {
  const result = new Map<string, AdminRootFolderCandidate>();
  for (const chunk of chunkArray([...new Set(folderIds)], ROOT_PERMISSION_CHUNK)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, parent_id, name, classification, deleted_at
           FROM folders
          WHERE tenant_id = ? AND id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<AdminRootFolderCandidate>();
    for (const row of rows.results) result.set(row.id, row);
  }
  return result;
}

/**
 * Shared co-owner grant statements. Both the single-folder API and the bulk
 * grant API use this builder, so `owner` grants are never downgraded.
 */
export function buildAdminRootCoOwnerStatements(
  db: D1Database,
  input: {
    tenantId: string;
    folderId: string;
    userIds: readonly string[];
    groupIds: readonly string[];
    grantedBy: string;
    nowIso: string;
  }
): AdminRootCoOwnerStatementBundle {
  const statements: D1PreparedStatement[] = [];
  const syncStatements: D1PreparedStatement[] = [];

  for (const [granteeType, ids] of [
    ['user', input.userIds],
    ['group', input.groupIds],
  ] as const) {
    for (const granteeId of ids) {
      statements.push(
        db
          .prepare(
            `INSERT INTO permissions (
               id, tenant_id, target_type, target_id, grantee_type, grantee_id,
               role, granted_by, created_at
             ) VALUES (?, ?, 'folder', ?, ?, ?, 'co_owner', ?, ?)
             ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
             DO UPDATE SET
               role = CASE WHEN permissions.role = 'owner' THEN 'owner' ELSE 'co_owner' END,
               granted_by = CASE WHEN permissions.role = 'owner' THEN permissions.granted_by ELSE excluded.granted_by END`
          )
          .bind(
            crypto.randomUUID(),
            input.tenantId,
            input.folderId,
            granteeType,
            granteeId,
            input.grantedBy,
            input.nowIso
          )
      );
      syncStatements.push(
        buildSyncChangeStmt(db, {
          tenantId: input.tenantId,
          entityType: 'permission',
          entityId: `${input.folderId}:${granteeType}:${granteeId}`,
          folderId: input.folderId,
          action: 'permission.grant',
          payload: {
            targetType: 'folder',
            targetId: input.folderId,
            granteeType,
            granteeId,
            role: 'co_owner',
          },
          nowIso: input.nowIso,
        })
      );
    }
  }

  return { statements, syncStatements };
}

/**
 * Shared owner-transfer statements. The new owner is granted/promoted first and
 * previous owners are demoted/revoked afterwards inside the same D1 batch, so
 * no intermediate state can drop the last effective owner.
 */
export function buildAdminRootOwnerTransferStatements(
  db: D1Database,
  input: {
    tenantId: string;
    folderId: string;
    newOwnerUserId: string;
    demote: 'co_owner' | 'editor' | 'revoke';
    previousOwners: readonly AdminRootOwnerRef[];
    grantedBy: string;
    nowIso: string;
  }
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by, created_at
         ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)
         ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
         DO UPDATE SET role = 'owner', granted_by = excluded.granted_by`
      )
      .bind(
        crypto.randomUUID(),
        input.tenantId,
        input.folderId,
        input.newOwnerUserId,
        input.grantedBy,
        input.nowIso
      ),
  ];

  for (const previous of input.previousOwners) {
    if (input.demote === 'revoke') {
      statements.push(
        db
          .prepare(
            `DELETE FROM permissions
              WHERE tenant_id = ?
                AND target_type = 'folder'
                AND target_id = ?
                AND grantee_type = ?
                AND grantee_id = ?`
          )
          .bind(
            input.tenantId,
            input.folderId,
            previous.grantee_type,
            previous.grantee_id
          )
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE permissions
                SET role = ?, granted_by = ?
              WHERE tenant_id = ?
                AND target_type = 'folder'
                AND target_id = ?
                AND grantee_type = ?
                AND grantee_id = ?`
          )
          .bind(
            input.demote,
            input.grantedBy,
            input.tenantId,
            input.folderId,
            previous.grantee_type,
            previous.grantee_id
          )
      );
    }
  }

  return statements;
}

async function loadPermissionRows(
  db: D1Database,
  tenantId: string,
  rootIds: readonly string[]
): Promise<PermissionGrantRow[]> {
  const grants: PermissionGrantRow[] = [];
  for (const chunk of chunkArray([...rootIds], ROOT_PERMISSION_CHUNK)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT p.target_id,
                p.grantee_type,
                p.grantee_id,
                p.role,
                COALESCE(u.display_name, g.name) AS name,
                u.email AS email,
                CASE
                  WHEN p.grantee_type = 'user' AND u.id IS NULL THEN 'suspended'
                  ELSE COALESCE(u.status, 'active')
                END AS status
           FROM permissions p
           LEFT JOIN users u
             ON p.grantee_type = 'user'
            AND u.tenant_id = p.tenant_id
            AND u.id = p.grantee_id
           LEFT JOIN groups g
             ON p.grantee_type = 'group'
            AND g.tenant_id = p.tenant_id
            AND g.id = p.grantee_id
          WHERE p.tenant_id = ?
            AND p.target_type = 'folder'
            AND p.role IN ('owner', 'co_owner')
            AND p.target_id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<PermissionGrantRow>();
    grants.push(...rows.results);
  }
  return grants;
}

async function loadRootMetrics(
  db: D1Database,
  tenantId: string,
  rootIds: readonly string[]
): Promise<Map<string, { itemCount: number; totalBytes: number }>> {
  const metrics = new Map<string, { itemCount: number; totalBytes: number }>();
  for (const chunk of chunkArray([...rootIds], ROOT_PERMISSION_CHUNK)) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT root_folder_id AS root_id,
                file_count AS item_count,
                total_bytes AS total_bytes
           FROM root_folder_stats
          WHERE tenant_id = ?
            AND root_folder_id IN (${placeholders})`
      )
      .bind(tenantId, ...chunk)
      .all<RootMetricRow>();
    for (const row of rows.results) {
      metrics.set(row.root_id, {
        itemCount: Number(row.item_count),
        totalBytes: Number(row.total_bytes),
      });
    }
  }
  return metrics;
}

function toRecord(
  row: RootFolderRow,
  grants: readonly PermissionGrantRow[],
  metric: { itemCount: number; totalBytes: number } | undefined
): AdminRootFolderRecord {
  const owners = grants
    .filter((grant) => grant.role === 'owner')
    .map((grant) => ({
      granteeType: grant.grantee_type,
      granteeId: grant.grantee_id,
      name: grant.name ?? '不明なユーザー',
      email: grant.email,
      status: grant.status === 'suspended' ? 'suspended' : 'active',
    })) satisfies AdminRootOwnerGrant[];
  const coOwners = grants
    .filter((grant) => grant.role === 'co_owner')
    .map((grant) => ({
      granteeType: grant.grantee_type,
      granteeId: grant.grantee_id,
      name: grant.name ?? '不明なユーザー',
      email: grant.email,
      status: grant.status === 'suspended' ? 'suspended' : 'active',
    })) satisfies AdminRootCoOwnerGrant[];

  return {
    id: row.id,
    name: row.name,
    classification: row.classification,
    isPinned: row.is_pinned === 1,
    version: row.version,
    createdBy: row.created_by,
    createdByName: row.created_by_name ?? row.created_by,
    createdByEmail: row.created_by_email ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
    owners,
    coOwners,
    itemCount: metric?.itemCount ?? 0,
    totalBytes: metric?.totalBytes ?? 0,
    ownerMissing:
      owners.filter((owner) => owner.status !== 'suspended').length === 0,
    hasSuspendedOwner: owners.some((owner) => owner.status === 'suspended'),
  };
}

async function loadAllRootRecords(
  db: D1Database,
  tenantId: string,
  options: {
    status: 'active' | 'archived' | 'all';
    includeMetrics?: boolean;
  } = { status: 'all' }
): Promise<AdminRootFolderRecord[]> {
  const deletedFilter =
    options.status === 'active'
      ? 'AND f.deleted_at IS NULL'
      : options.status === 'archived'
        ? 'AND f.deleted_at IS NOT NULL'
        : '';
  const rows = await db
    .prepare(
      `SELECT f.id, f.parent_id, f.name, f.classification, f.is_pinned, f.version,
              f.created_by, f.deleted_at, f.deleted_by, f.created_at, f.updated_at,
              u.display_name AS created_by_name,
              u.email AS created_by_email
         FROM folders f
         LEFT JOIN users u
           ON u.tenant_id = f.tenant_id AND u.id = f.created_by
        WHERE f.tenant_id = ?
          AND f.parent_id IS NULL
          ${deletedFilter}
        ORDER BY (f.deleted_at IS NOT NULL) ASC, f.name ASC, f.id ASC`
    )
    .bind(tenantId)
    .all<RootFolderRow>();

  const ids = rows.results.map((row) => row.id);
  const includeMetrics = options.includeMetrics !== false;
  const [grants, metrics] = await Promise.all([
    loadPermissionRows(db, tenantId, ids),
    includeMetrics
      ? loadRootMetrics(db, tenantId, ids)
      : Promise.resolve(new Map<string, { itemCount: number; totalBytes: number }>()),
  ]);
  const grantsByRoot = new Map<string, PermissionGrantRow[]>();
  for (const grant of grants) {
    const bucket = grantsByRoot.get(grant.target_id) ?? [];
    bucket.push(grant);
    grantsByRoot.set(grant.target_id, bucket);
  }

  return rows.results
    .filter(isRootFolderRow)
    .map((row) =>
      toRecord(row, grantsByRoot.get(row.id) ?? [], metrics.get(row.id))
    );
}

/**
 * Tenant root-folder inventory for the admin governance console. `search`
 * matches the folder name or any direct owner/co-owner name/email.
 * Pass `includeMetrics: false` for lightweight dropdown/selector consumers.
 */
export async function listAdminRootFolders(
  db: D1Database,
  tenantId: string,
  filters: {
    status?: 'active' | 'archived' | 'all';
    search?: string;
    ownerMissingOnly?: boolean;
    includeMetrics?: boolean;
  } = {}
): Promise<AdminRootFolderListResult> {
  const folderStructureMode = await getFolderStructureMode(db, tenantId);
  const all = await loadAllRootRecords(db, tenantId, {
    status: filters.status ?? 'all',
    includeMetrics: filters.includeMetrics,
  });

  const search = filters.search?.trim().toLowerCase() ?? '';
  let roots = all;
  if (search.length > 0) {
    roots = roots.filter((root) => {
      if (root.name.toLowerCase().includes(search)) return true;
      return [...root.owners, ...root.coOwners].some(
        (grant) =>
          grant.name.toLowerCase().includes(search) ||
          (grant.email ?? '').toLowerCase().includes(search)
      );
    });
  }
  if (filters.ownerMissingOnly) {
    roots = roots.filter((root) => root.ownerMissing);
  }

  const activeRoots = all.filter((root) => root.deletedAt === null);
  return {
    roots,
    summary: {
      totalRootFolders: all.length,
      activeRootFolders: activeRoots.length,
      archivedRootFolders: all.length - activeRoots.length,
      missingOwnerCount: activeRoots.filter((root) => root.ownerMissing).length,
      suspendedOwnerCount: activeRoots.filter((root) => root.hasSuspendedOwner)
        .length,
      totalBytes: activeRoots.reduce((sum, root) => sum + root.totalBytes, 0),
      folderStructureMode,
    },
  };
}

async function loadRecordById(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<AdminRootFolderRecord> {
  const row = await loadRootFolderRow(db, tenantId, folderId, {
    allowDeleted: true,
  });
  const [grants, metrics] = await Promise.all([
    loadPermissionRows(db, tenantId, [folderId]),
    loadRootMetrics(db, tenantId, [folderId]),
  ]);
  return toRecord(row, grants, metrics.get(folderId));
}

export async function createAdminRootFolder(
  db: D1Database,
  user: AuthUser,
  input: {
    name: unknown;
    classification?: unknown;
    isPinned?: unknown;
    ownerUserId: unknown;
    coOwnerUserIds?: unknown;
    coOwnerGroupIds?: unknown;
  }
): Promise<AdminRootFolderMutationResult> {
  const name = validateFolderName(input.name);
  const classification =
    input.classification === undefined
      ? 'unset'
      : (input.classification as ClassificationLabel);
  if (!VALID_CLASSIFICATIONS.has(classification)) {
    throw new AdminRootFolderError(
      400,
      'INVALID_CLASSIFICATION',
      'Invalid classification value'
    );
  }
  if (typeof input.ownerUserId !== 'string' || input.ownerUserId.trim().length === 0) {
    throw new AdminRootFolderError(
      400,
      'INVALID_OWNER',
      'ownerUserId is required'
    );
  }
  const ownerUserId = input.ownerUserId.trim();
  const coOwnerUserIds = normalizeIdArray(
    input.coOwnerUserIds,
    'coOwnerUserIds'
  );
  const coOwnerGroupIds = normalizeIdArray(
    input.coOwnerGroupIds,
    'coOwnerGroupIds'
  );

  const duplicate = await db
    .prepare(
      `SELECT id FROM folders
        WHERE tenant_id = ? AND parent_id IS NULL AND name = ? AND deleted_at IS NULL
        LIMIT 1`
    )
    .bind(user.tenantId, name)
    .first<{ id: string }>();
  if (duplicate) {
    throw new AdminRootFolderError(
      409,
      'NAME_CONFLICT',
      `A root folder named "${name}" already exists`
    );
  }

  await assertActiveUser(db, user.tenantId, ownerUserId);
  for (const userId of coOwnerUserIds) {
    if (userId === ownerUserId) continue;
    await assertActiveUser(db, user.tenantId, userId, 'INVALID_CO_OWNER');
  }
  await assertTenantGroups(db, user.tenantId, coOwnerGroupIds);

  const folderId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const isPinned = input.isPinned === true ? 1 : 0;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO folders (
           id, tenant_id, parent_id, name, depth, version, classification,
           is_pinned, created_by, deleted_at, created_at, updated_at
         ) VALUES (?, ?, NULL, ?, 0, 1, ?, ?, ?, NULL, ?, ?)`
      )
      .bind(
        folderId,
        user.tenantId,
        name,
        classification,
        isPinned,
        user.id,
        nowIso,
        nowIso
      ),
    db
      .prepare(
        `INSERT INTO folder_closures (tenant_id, ancestor_id, descendant_id, depth)
         VALUES (?, ?, ?, 0)`
      )
      .bind(user.tenantId, folderId, folderId),
    buildRootFolderResetStmt(db, user.tenantId, folderId, nowIso),
    db
      .prepare(
        `INSERT INTO permissions (
           id, tenant_id, target_type, target_id, grantee_type, grantee_id,
           role, granted_by, created_at
         ) VALUES (?, ?, 'folder', ?, 'user', ?, 'owner', ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        user.tenantId,
        folderId,
        ownerUserId,
        user.id,
        nowIso
      ),
  ];

  const coOwnerGrantKeys = new Set<string>();
  for (const userId of coOwnerUserIds) {
    const key = `user:${userId}`;
    if (userId === ownerUserId || coOwnerGrantKeys.has(key)) continue;
    coOwnerGrantKeys.add(key);
    statements.push(
      db
        .prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id,
             role, granted_by, created_at
           ) VALUES (?, ?, 'folder', ?, 'user', ?, 'co_owner', ?, ?)
           ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
           DO UPDATE SET role = 'co_owner', granted_by = excluded.granted_by`
        )
        .bind(
          crypto.randomUUID(),
          user.tenantId,
          folderId,
          userId,
          user.id,
          nowIso
        )
    );
  }
  for (const groupId of coOwnerGroupIds) {
    const key = `group:${groupId}`;
    if (coOwnerGrantKeys.has(key)) continue;
    coOwnerGrantKeys.add(key);
    statements.push(
      db
        .prepare(
          `INSERT INTO permissions (
             id, tenant_id, target_type, target_id, grantee_type, grantee_id,
             role, granted_by, created_at
           ) VALUES (?, ?, 'folder', ?, 'group', ?, 'co_owner', ?, ?)
           ON CONFLICT (target_type, target_id, grantee_type, grantee_id)
           DO UPDATE SET role = 'co_owner', granted_by = excluded.granted_by`
        )
        .bind(
          crypto.randomUUID(),
          user.tenantId,
          folderId,
          groupId,
          user.id,
          nowIso
        )
    );
  }

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.root_folder.create',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: classification,
      metadata: {
        name,
        ownerUserId,
        coOwnerUserIds,
        coOwnerGroupIds,
        classification,
        isPinned: isPinned === 1,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: null,
      action: 'folder.create',
      payload: {
        folder: {
          id: folderId,
          tenant_id: user.tenantId,
          parent_id: null,
          name,
          depth: 0,
          version: 1,
          classification,
          is_pinned: isPinned,
          created_by: user.id,
          deleted_at: null,
          deleted_by: null,
          created_at: nowIso,
          updated_at: nowIso,
        },
        adminCreated: true,
      },
      nowIso,
    })
  );

  const batchResults = await db.batch(statements);
  return {
    root: await loadRecordById(db, user.tenantId, folderId),
    syncSeq: extractLastSyncSeq(batchResults),
  };
}

export async function transferAdminRootFolderOwner(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  input: {
    newOwnerUserId?: unknown;
    demotePreviousOwnersTo?: unknown;
  }
): Promise<AdminRootFolderMutationResult> {
  const folder = await loadRootFolderRow(db, user.tenantId, folderId);
  if (typeof input.newOwnerUserId !== 'string' || input.newOwnerUserId.trim().length === 0) {
    throw new AdminRootFolderError(
      400,
      'INVALID_OWNER',
      'newOwnerUserId is required'
    );
  }
  const newOwnerUserId = input.newOwnerUserId.trim();
  const demote =
    input.demotePreviousOwnersTo === 'editor' ||
    input.demotePreviousOwnersTo === 'revoke'
      ? input.demotePreviousOwnersTo
      : 'co_owner';
  await assertActiveUser(db, user.tenantId, newOwnerUserId);
  if (newOwnerUserId.length === 0) {
    throw new AdminRootFolderError(
      409,
      'LAST_OWNER_PROTECTED',
      'At least one active owner must remain'
    );
  }

  const existingOwners = await db
    .prepare(
      `SELECT grantee_type, grantee_id
         FROM permissions
        WHERE tenant_id = ?
          AND target_type = 'folder'
          AND target_id = ?
          AND role = 'owner'`
    )
    .bind(user.tenantId, folderId)
    .all<{ grantee_type: 'user' | 'group'; grantee_id: string }>();
  const previousOwners = existingOwners.results.filter(
    (row) => !(row.grantee_type === 'user' && row.grantee_id === newOwnerUserId)
  );
  const previousOwnerIds = previousOwners.map((row) => row.grantee_id);

  const nowIso = new Date().toISOString();
  const statements = buildAdminRootOwnerTransferStatements(db, {
    tenantId: user.tenantId,
    folderId,
    newOwnerUserId,
    demote,
    previousOwners,
    grantedBy: user.id,
    nowIso,
  });

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.root_folder.owner_transfer',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: folder.classification,
      metadata: {
        previousOwnerIds,
        newOwnerUserId,
        demotePreviousOwnersTo: demote,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: null,
      action: 'admin.root_folder.owner_transfer',
      payload: {
        previousOwnerIds,
        newOwnerUserId,
        demotePreviousOwnersTo: demote,
      },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'permission',
      entityId: `${folderId}:user:${newOwnerUserId}`,
      folderId,
      action: 'permission.grant',
      payload: {
        targetType: 'folder',
        targetId: folderId,
        granteeType: 'user',
        granteeId: newOwnerUserId,
        role: 'owner',
      },
      nowIso,
    })
  );

  const batchResults = await db.batch(statements);
  const record = await loadRecordById(db, user.tenantId, folderId);
  if (
    !record.owners.some(
      (owner) => owner.granteeId === newOwnerUserId && owner.status === 'active'
    )
  ) {
    throw new AdminRootFolderError(
      409,
      'LAST_OWNER_PROTECTED',
      'At least one active owner must remain'
    );
  }

  return { root: record, syncSeq: extractLastSyncSeq(batchResults) };
}

export async function grantAdminRootFolderCoOwners(
  db: D1Database,
  user: AuthUser,
  folderId: string,
  input: { userIds?: unknown; groupIds?: unknown }
): Promise<AdminRootFolderMutationResult> {
  const folder = await loadRootFolderRow(db, user.tenantId, folderId);
  const userIds = normalizeIdArray(input.userIds, 'userIds');
  const groupIds = normalizeIdArray(input.groupIds, 'groupIds');
  if (userIds.length === 0 && groupIds.length === 0) {
    throw new AdminRootFolderError(
      400,
      'INVALID_GRANTEE',
      'At least one userId or groupId is required'
    );
  }
  for (const userId of userIds) {
    await assertActiveUser(db, user.tenantId, userId, 'INVALID_CO_OWNER');
  }
  await assertTenantGroups(db, user.tenantId, groupIds);

  const nowIso = new Date().toISOString();
  const { statements, syncStatements } = buildAdminRootCoOwnerStatements(db, {
    tenantId: user.tenantId,
    folderId,
    userIds,
    groupIds,
    grantedBy: user.id,
    nowIso,
  });

  statements.push(
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.root_folder.co_owner_grant',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: folder.classification,
      metadata: { userIds, groupIds },
      nowIso,
    }),
    ...syncStatements
  );

  const batchResults = await db.batch(statements);
  return {
    root: await loadRecordById(db, user.tenantId, folderId),
    syncSeq: extractLastSyncSeq(batchResults),
  };
}

/**
 * Archive preflight shared by the single-folder API and bulk dry-run previews.
 * It validates root state and rejects desktop-exclusive file locks without
 * mutating anything.
 */
export async function assertAdminRootFolderArchivable(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  folderId: string
): Promise<RootFolderRow> {
  const db = env.DB;
  const folder = await loadRootFolderRow(db, tenantId, folderId, {
    allowDeleted: true,
  });
  if (folder.deleted_at !== null) {
    throw new AdminRootFolderError(
      409,
      'ALREADY_ARCHIVED',
      'Root folder is already archived'
    );
  }

  const activeFiles = await db
    .prepare(
      `SELECT fl.id
         FROM files fl
        WHERE fl.tenant_id = ?
          AND fl.deleted_at IS NULL
          AND fl.upload_state = 'active'
          AND fl.folder_id IN (
            SELECT fc.descendant_id
              FROM folder_closures fc
             WHERE fc.tenant_id = ? AND fc.ancestor_id = ?
          )`
    )
    .bind(tenantId, tenantId, folderId)
    .all<{ id: string }>();

  for (const chunk of chunkArray(
    activeFiles.results.map((row) => row.id),
    FILE_LOCK_CHECK_CHUNK
  )) {
    const locks = await Promise.all(
      chunk.map((fileId) => getFileLockState(env, fileId))
    );
    const desktopLock = locks.find(
      (lock) => lock !== null && lock.mode === 'desktop_exclusive'
    );
    if (desktopLock) {
      throw new FileLockedError(desktopLock);
    }
  }

  return folder;
}

export async function archiveAdminRootFolder(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  user: AuthUser,
  folderId: string
): Promise<{ deletedAt: string; syncSeq: number | null }> {
  const db = env.DB;
  const folder = await assertAdminRootFolderArchivable(
    env,
    user.tenantId,
    folderId
  );
  const nowIso = new Date().toISOString();
  const batchResults = await db.batch([
    db
      .prepare(
        `DELETE FROM files_fts
          WHERE file_id IN (
            SELECT fl.id FROM files fl
             WHERE fl.tenant_id = ?
               AND fl.deleted_at IS NULL
               AND fl.folder_id IN (
                 SELECT descendant_id FROM folder_closures
                  WHERE tenant_id = ? AND ancestor_id = ?
               )
          )`
      )
      .bind(user.tenantId, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE files
            SET deleted_at = ?, deleted_by = ?, meta_version = meta_version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at IS NULL
            AND folder_id IN (
              SELECT descendant_id FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, user.id, nowIso, user.tenantId, user.tenantId, folderId),
    db
      .prepare(
        `UPDATE folders
            SET deleted_at = ?, deleted_by = ?, version = version + 1, updated_at = ?
          WHERE tenant_id = ?
            AND deleted_at IS NULL
            AND id IN (
              SELECT descendant_id FROM folder_closures
               WHERE tenant_id = ? AND ancestor_id = ?
            )`
      )
      .bind(nowIso, user.id, nowIso, user.tenantId, user.tenantId, folderId),
    buildRootFolderResetStmt(db, user.tenantId, folderId, nowIso),
    buildAuditLogStmt(db, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'admin.root_folder.archive',
      targetType: 'folder',
      targetId: folderId,
      classificationSnapshot: folder.classification,
      metadata: { archivedAt: nowIso, archivedBy: user.id, name: folder.name },
      nowIso,
    }),
    buildSyncChangeStmt(db, {
      tenantId: user.tenantId,
      entityType: 'folder',
      entityId: folderId,
      folderId: null,
      action: 'folder.soft_delete',
      payload: {
        parentId: null,
        deletedAt: nowIso,
        deletedBy: user.id,
        version: folder.version + 1,
        adminArchive: true,
      },
      nowIso,
    }),
  ]);

  return { deletedAt: nowIso, syncSeq: extractLastSyncSeq(batchResults) };
}

/**
 * Restore preflight shared by the single-folder API and bulk dry-run previews.
 */
export async function assertAdminRootFolderRestorable(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<RootFolderRow> {
  const folder = await loadRootFolderRow(db, tenantId, folderId, {
    allowDeleted: true,
  });
  if (folder.deleted_at === null) {
    throw new AdminRootFolderError(
      409,
      'NOT_ARCHIVED',
      'Root folder is not archived'
    );
  }

  const duplicate = await db
    .prepare(
      `SELECT id FROM folders
        WHERE tenant_id = ?
          AND parent_id IS NULL
          AND name = ?
          AND deleted_at IS NULL
          AND id != ?
        LIMIT 1`
    )
    .bind(tenantId, folder.name, folderId)
    .first<{ id: string }>();
  if (duplicate) {
    throw new AdminRootFolderError(
      409,
      'NAME_CONFLICT',
      `A root folder named "${folder.name}" already exists`
    );
  }
  return folder;
}

export async function restoreAdminRootFolder(
  db: D1Database,
  user: AuthUser,
  folderId: string
): Promise<{ root: AdminRootFolderRecord; syncSeq: number | null }> {
  const folder = await assertAdminRootFolderRestorable(
    db,
    user.tenantId,
    folderId
  );

  const restored = await restoreFolderWithOptions(db, user, folderId, {
    conflictPolicy: 'fail',
    adminDelegation: {
      onBehalfOfUserId: user.id,
      ownerId: user.id,
      ownerName: user.email,
      ownerEmail: user.email,
    },
  });

  const nowIso = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO audit_logs (
         id, tenant_id, actor_id, actor_email, actor_ip, action, target_type,
         target_id, classification_snapshot, status, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, 'admin.root_folder.restore', 'folder', ?, ?, 'allowed', ?, ?)`
    )
    .bind(
      crypto.randomUUID(),
      user.tenantId,
      user.id,
      user.email,
      user.ipAddress,
      folderId,
      folder.classification,
      JSON.stringify({
        name: folder.name,
        restoredAt: restored.restoredAt,
        restoredAncestorIds: restored.restoredAncestorIds,
      }),
      nowIso
    )
    .run();

  return {
    root: await loadRecordById(db, user.tenantId, folderId),
    syncSeq: restored.syncSeq,
  };
}
