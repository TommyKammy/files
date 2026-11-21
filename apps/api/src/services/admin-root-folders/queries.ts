import { chunkArray } from '../../utils/batch';
import { getFolderStructureMode } from '../folder-structure';
import {
  ROOT_PERMISSION_CHUNK,
  type AdminRootCoOwnerGrant,
  type AdminRootFolderListResult,
  type AdminRootFolderRecord,
  type AdminRootOwnerGrant,
  type PermissionGrantRow,
  type RootFolderRow,
  type RootMetricRow,
} from './types';
import { loadRootFolderRow } from './validation';

function isRootFolderRow(row: RootFolderRow | null): row is RootFolderRow {
  return row !== null;
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

export async function loadRecordById(
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
