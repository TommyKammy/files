import type { ClassificationLabel, ResourceRole } from '../types/api';

/**
 * Tenant-wide permission audit (P9-7 / TOM-57).
 *
 * Every query is tenant-scoped and only joins target rows from the same
 * tenant. File entries intentionally select metadata only (`name`,
 * `classification`, `deleted_at`, folder/root names): no R2 object key, content,
 * signed URL, AI reason or classification rationale is ever read or returned.
 */

export type PermissionAuditTargetType = 'folder' | 'file';
export type PermissionAuditSource = 'all' | 'direct' | 'inherited';
export type PermissionAuditGranteeStatus = 'active' | 'suspended' | 'deleted';
export type PermissionAuditHealth = 'all' | 'owner_missing' | 'inactive_owner';
export type PermissionAuditSortBy =
  | 'createdAt'
  | 'role'
  | 'targetName'
  | 'granteeName';
export type PermissionAuditSortDir = 'asc' | 'desc';

export interface PermissionAuditFilters {
  targetType: PermissionAuditTargetType | 'all';
  targetId: string | null;
  rootFolderId: string | null;
  includeInherited: boolean;
  grantee: string | null;
  granteeType: 'user' | 'group' | null;
  roles: ResourceRole[];
  source: PermissionAuditSource;
  inheritedFromId: string | null;
  grantedBy: string | null;
  from: string | null;
  to: string | null;
  granteeStatus: PermissionAuditGranteeStatus | null;
  health: PermissionAuditHealth;
  sortBy: PermissionAuditSortBy;
  sortDir: PermissionAuditSortDir;
  limit: number;
  offset: number;
}

export interface PermissionAuditEntry {
  id: string;
  permissionId: string;
  targetType: PermissionAuditTargetType;
  targetId: string;
  targetName: string;
  classification: ClassificationLabel;
  targetDeletedAt: string | null;
  rootFolderId: string | null;
  rootFolderName: string | null;
  granteeType: 'user' | 'group';
  granteeId: string;
  granteeName: string;
  granteeEmail: string | null;
  granteeStatus: PermissionAuditGranteeStatus;
  role: ResourceRole;
  source: 'direct' | 'inherited';
  inheritedFromId: string | null;
  inheritedFromName: string | null;
  inheritedDepth: number;
  grantedBy: string;
  grantedByName: string | null;
  grantedByEmail: string | null;
  createdAt: string;
}

export interface PermissionAuditRootSummary {
  id: string;
  name: string;
  classification: ClassificationLabel;
  archived: boolean;
  deletedAt: string | null;
  ownerCount: number;
  activeOwnerCount: number;
  coOwnerCount: number;
  editorCount: number;
  totalGrantCount: number;
  ownerMissing: boolean;
  hasSuspendedOwner: boolean;
  hasDeletedOwner: boolean;
}

export interface PermissionAuditAnomaliesSummary {
  ownerMissingCount: number;
  suspendedOwnerCount: number;
  deletedOwnerCount: number;
  inactiveGranterCount: number;
  suspendedGranteeCount: number;
  deletedGranteeCount: number;
}

export interface PermissionAuditResult {
  entries: PermissionAuditEntry[];
  totalCount: number;
  nextOffset: number | null;
  rootSummaries: PermissionAuditRootSummary[];
  anomaliesSummary: PermissionAuditAnomaliesSummary;
}

interface AuditEntryRow {
  id: string;
  permission_id: string;
  target_type: PermissionAuditTargetType;
  target_id: string;
  target_name: string;
  classification: ClassificationLabel;
  target_deleted_at: string | null;
  root_folder_id: string | null;
  root_folder_name: string | null;
  grantee_type: 'user' | 'group';
  grantee_id: string;
  grantee_name: string;
  grantee_email: string | null;
  grantee_status: PermissionAuditGranteeStatus;
  role: ResourceRole;
  source: 'direct' | 'inherited';
  inherited_from_id: string | null;
  inherited_from_name: string | null;
  inherited_depth: number;
  granted_by: string;
  granted_by_name: string | null;
  granted_by_email: string | null;
  created_at: string;
}

interface RootSummaryRow {
  id: string;
  name: string;
  classification: ClassificationLabel;
  deleted_at: string | null;
  owner_count: number;
  active_owner_count: number;
  co_owner_count: number;
  editor_count: number;
  total_grant_count: number;
  suspended_owner_count: number;
  deleted_owner_count: number;
}

interface AnomalyRow {
  inactive_granter_count: number;
  suspended_grantee_count: number;
  deleted_grantee_count: number;
}

const ROLE_SORT_SQL = `CASE e.role
  WHEN 'owner' THEN 0
  WHEN 'co_owner' THEN 1
  WHEN 'editor' THEN 2
  WHEN 'viewer_uploader' THEN 3
  WHEN 'previewer_uploader' THEN 4
  WHEN 'viewer' THEN 5
  WHEN 'previewer' THEN 6
  WHEN 'uploader' THEN 7
  ELSE 8
END`;

function escapeLike(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function tenantRootJoin(descendantExpr: string): string {
  return `LEFT JOIN folder_closures audit_rfc
    ON audit_rfc.tenant_id = p.tenant_id
   AND audit_rfc.descendant_id = ${descendantExpr}
   AND audit_rfc.ancestor_id IN (
     SELECT audit_root_folder.id
       FROM folders audit_root_folder
      WHERE audit_root_folder.tenant_id = p.tenant_id
        AND audit_root_folder.parent_id IS NULL
   )
  LEFT JOIN folders audit_root
    ON audit_root.tenant_id = audit_rfc.tenant_id
   AND audit_root.id = audit_rfc.ancestor_id`;
}

const GRANTEE_JOINS = `LEFT JOIN users audit_u
    ON p.grantee_type = 'user'
   AND audit_u.tenant_id = p.tenant_id
   AND audit_u.id = p.grantee_id
  LEFT JOIN groups audit_g
    ON p.grantee_type = 'group'
   AND audit_g.tenant_id = p.tenant_id
   AND audit_g.id = p.grantee_id
  LEFT JOIN users audit_gb
    ON audit_gb.tenant_id = p.tenant_id
   AND audit_gb.id = p.granted_by`;

const GRANTEE_COLUMNS = `p.grantee_type,
  p.grantee_id,
  COALESCE(audit_u.display_name, audit_g.name, p.grantee_id) AS grantee_name,
  audit_u.email AS grantee_email,
  CASE
    WHEN p.grantee_type = 'user' THEN
      CASE
        WHEN audit_u.id IS NULL THEN 'deleted'
        ELSE COALESCE(audit_u.status, 'active')
      END
    ELSE 'active'
  END AS grantee_status,
  p.role,
  p.granted_by,
  audit_gb.display_name AS granted_by_name,
  audit_gb.email AS granted_by_email,
  p.created_at`;

interface SqlFragment {
  sql: string;
  binds: unknown[];
}

function directBranch(
  filters: PermissionAuditFilters,
  tenantId: string
): SqlFragment {
  const conditions = [
    `p.tenant_id = ?`,
    `((p.target_type = 'folder' AND audit_f.id IS NOT NULL) OR
      (p.target_type = 'file' AND audit_fl.id IS NOT NULL))`,
  ];
  const binds: unknown[] = [tenantId];

  if (filters.targetType !== 'all') {
    conditions.push('p.target_type = ?');
    binds.push(filters.targetType);
  }
  if (filters.targetId) {
    conditions.push('p.target_id = ?');
    binds.push(filters.targetId);
  }

  return {
    sql: `SELECT
        p.id || ':' || p.target_type || ':' || p.target_id AS id,
        p.id AS permission_id,
        p.target_type AS target_type,
        p.target_id AS target_id,
        CASE p.target_type WHEN 'folder' THEN audit_f.name ELSE audit_fl.name END AS target_name,
        CASE p.target_type WHEN 'folder' THEN audit_f.classification ELSE audit_fl.classification END AS classification,
        CASE p.target_type WHEN 'folder' THEN audit_f.deleted_at ELSE audit_fl.deleted_at END AS target_deleted_at,
        audit_root.id AS root_folder_id,
        audit_root.name AS root_folder_name,
        ${GRANTEE_COLUMNS},
        'direct' AS source,
        NULL AS inherited_from_id,
        NULL AS inherited_from_name,
        0 AS inherited_depth
      FROM permissions p
      LEFT JOIN folders audit_f
        ON p.target_type = 'folder'
       AND audit_f.tenant_id = p.tenant_id
       AND audit_f.id = p.target_id
      LEFT JOIN files audit_fl
        ON p.target_type = 'file'
       AND audit_fl.tenant_id = p.tenant_id
       AND audit_fl.id = p.target_id
      ${GRANTEE_JOINS}
      ${tenantRootJoin(
        `(CASE p.target_type WHEN 'folder' THEN audit_f.id ELSE audit_fl.folder_id END)`
      )}
      WHERE ${conditions.join(' AND ')}`,
    binds,
  };
}

function inheritedFolderBranch(
  filters: PermissionAuditFilters,
  tenantId: string
): SqlFragment {
  const conditions = [`p.tenant_id = ?`, `p.target_type = 'folder'`];
  const binds: unknown[] = [tenantId];

  if (filters.targetId) {
    conditions.push('audit_desc.id = ?');
    binds.push(filters.targetId);
  }

  return {
    sql: `SELECT
        p.id || ':folder:' || audit_desc.id AS id,
        p.id AS permission_id,
        'folder' AS target_type,
        audit_desc.id AS target_id,
        audit_desc.name AS target_name,
        audit_desc.classification AS classification,
        audit_desc.deleted_at AS target_deleted_at,
        audit_root.id AS root_folder_id,
        audit_root.name AS root_folder_name,
        ${GRANTEE_COLUMNS},
        'inherited' AS source,
        audit_from.id AS inherited_from_id,
        audit_from.name AS inherited_from_name,
        audit_fc.depth AS inherited_depth
      FROM permissions p
      JOIN folders audit_from
        ON audit_from.tenant_id = p.tenant_id
       AND audit_from.id = p.target_id
      JOIN folder_closures audit_fc
        ON audit_fc.tenant_id = p.tenant_id
       AND audit_fc.ancestor_id = p.target_id
       AND audit_fc.depth > 0
      JOIN folders audit_desc
        ON audit_desc.tenant_id = audit_fc.tenant_id
       AND audit_desc.id = audit_fc.descendant_id
      ${GRANTEE_JOINS}
      ${tenantRootJoin('audit_desc.id')}
      WHERE ${conditions.join(' AND ')}`,
    binds,
  };
}

function inheritedFileBranch(
  filters: PermissionAuditFilters,
  tenantId: string
): SqlFragment {
  const conditions = [`p.tenant_id = ?`, `p.target_type = 'folder'`];
  const binds: unknown[] = [tenantId];

  if (filters.targetId) {
    conditions.push('audit_file.id = ?');
    binds.push(filters.targetId);
  }

  return {
    sql: `SELECT
        p.id || ':file:' || audit_file.id AS id,
        p.id AS permission_id,
        'file' AS target_type,
        audit_file.id AS target_id,
        audit_file.name AS target_name,
        audit_file.classification AS classification,
        audit_file.deleted_at AS target_deleted_at,
        audit_root.id AS root_folder_id,
        audit_root.name AS root_folder_name,
        ${GRANTEE_COLUMNS},
        'inherited' AS source,
        audit_from.id AS inherited_from_id,
        audit_from.name AS inherited_from_name,
        audit_fc.depth AS inherited_depth
      FROM permissions p
      JOIN folders audit_from
        ON audit_from.tenant_id = p.tenant_id
       AND audit_from.id = p.target_id
      JOIN folder_closures audit_fc
        ON audit_fc.tenant_id = p.tenant_id
       AND audit_fc.ancestor_id = p.target_id
       AND audit_fc.depth >= 0
      JOIN files audit_file
        ON audit_file.tenant_id = audit_fc.tenant_id
       AND audit_file.folder_id = audit_fc.descendant_id
      ${GRANTEE_JOINS}
      ${tenantRootJoin('audit_file.folder_id')}
      WHERE ${conditions.join(' AND ')}`,
    binds,
  };
}

function buildUnion(
  filters: PermissionAuditFilters,
  tenantId: string
): SqlFragment {
  const expandInherited =
    filters.source === 'inherited' ||
    (filters.includeInherited && filters.source !== 'direct') ||
    Boolean(filters.targetId);

  const branches: SqlFragment[] = [];
  if (filters.source !== 'inherited') {
    branches.push(directBranch(filters, tenantId));
  }
  if (expandInherited && filters.source !== 'direct') {
    if (filters.targetType !== 'file') {
      branches.push(inheritedFolderBranch(filters, tenantId));
    }
    if (filters.targetType !== 'folder') {
      branches.push(inheritedFileBranch(filters, tenantId));
    }
  }

  return {
    sql: branches.map((branch) => branch.sql).join('\nUNION ALL\n'),
    binds: branches.flatMap((branch) => branch.binds),
  };
}

function outerFilters(
  filters: PermissionAuditFilters,
  tenantId: string
): { conditions: string[]; binds: unknown[] } {
  const conditions: string[] = [];
  const binds: unknown[] = [];

  if (filters.source !== 'all') {
    conditions.push('e.source = ?');
    binds.push(filters.source);
  }
  if (filters.targetType !== 'all') {
    conditions.push('e.target_type = ?');
    binds.push(filters.targetType);
  }
  if (filters.targetId) {
    conditions.push('e.target_id = ?');
    binds.push(filters.targetId);
  }
  if (filters.rootFolderId) {
    conditions.push('e.root_folder_id = ?');
    binds.push(filters.rootFolderId);
  }
  if (filters.grantee) {
    const pattern = `%${escapeLike(filters.grantee.toLowerCase())}%`;
    conditions.push(
      `(LOWER(e.grantee_name) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(e.grantee_email, '')) LIKE ? ESCAPE '\\'
        OR LOWER(e.grantee_id) LIKE ? ESCAPE '\\')`
    );
    binds.push(pattern, pattern, pattern);
  }
  if (filters.granteeType) {
    conditions.push('e.grantee_type = ?');
    binds.push(filters.granteeType);
  }
  if (filters.roles.length > 0) {
    conditions.push(
      `e.role IN (${filters.roles.map(() => '?').join(', ')})`
    );
    binds.push(...filters.roles);
  }
  if (filters.inheritedFromId) {
    conditions.push('e.inherited_from_id = ?');
    binds.push(filters.inheritedFromId);
  }
  if (filters.grantedBy) {
    const pattern = `%${escapeLike(filters.grantedBy.toLowerCase())}%`;
    conditions.push(
      `(e.granted_by = ?
        OR LOWER(e.granted_by) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(e.granted_by_email, '')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(e.granted_by_name, '')) LIKE ? ESCAPE '\\')`
    );
    binds.push(filters.grantedBy, pattern, pattern, pattern);
  }
  if (filters.from) {
    conditions.push('e.created_at >= ?');
    binds.push(filters.from);
  }
  if (filters.to) {
    conditions.push('e.created_at <= ?');
    binds.push(filters.to);
  }
  if (filters.granteeStatus) {
    conditions.push('e.grantee_status = ?');
    binds.push(filters.granteeStatus);
  }
  if (filters.health === 'owner_missing') {
    conditions.push(
      `e.root_folder_id IS NOT NULL AND NOT EXISTS (
         SELECT 1
           FROM permissions audit_hp
           LEFT JOIN users audit_hu
             ON audit_hp.grantee_type = 'user'
            AND audit_hu.tenant_id = audit_hp.tenant_id
            AND audit_hu.id = audit_hp.grantee_id
          WHERE audit_hp.tenant_id = ?
            AND audit_hp.target_type = 'folder'
            AND audit_hp.target_id = e.root_folder_id
            AND audit_hp.role = 'owner'
            AND (
              audit_hp.grantee_type = 'group'
              OR (audit_hu.id IS NOT NULL AND audit_hu.status = 'active')
            )
       )`
    );
    binds.push(tenantId);
  } else if (filters.health === 'inactive_owner') {
    conditions.push(
      `EXISTS (
         SELECT 1
           FROM permissions audit_hp
           LEFT JOIN users audit_hu
             ON audit_hp.grantee_type = 'user'
            AND audit_hu.tenant_id = audit_hp.tenant_id
            AND audit_hu.id = audit_hp.grantee_id
          WHERE audit_hp.tenant_id = ?
            AND audit_hp.target_type = 'folder'
            AND audit_hp.target_id = e.root_folder_id
            AND audit_hp.role = 'owner'
            AND audit_hp.grantee_type = 'user'
            AND (audit_hu.id IS NULL OR audit_hu.status = 'suspended')
       )`
    );
    binds.push(tenantId);
  }

  return { conditions, binds };
}

function orderBy(filters: PermissionAuditFilters): string {
  const direction = filters.sortDir === 'asc' ? 'ASC' : 'DESC';
  switch (filters.sortBy) {
    case 'role':
      return `${ROLE_SORT_SQL} ${direction}, e.created_at DESC, e.id ASC`;
    case 'targetName':
      return `e.target_name COLLATE NOCASE ${direction}, e.id ${direction}`;
    case 'granteeName':
      return `e.grantee_name COLLATE NOCASE ${direction}, e.id ${direction}`;
    case 'createdAt':
    default:
      return `e.created_at ${direction}, e.id ${direction}`;
  }
}

async function loadRootSummaries(
  db: D1Database,
  tenantId: string
): Promise<PermissionAuditRootSummary[]> {
  const rowSql = `
    SELECT
      r.id,
      r.name,
      r.classification,
      r.deleted_at,
      (SELECT COUNT(*) FROM permissions p
        WHERE p.tenant_id = r.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = r.id
          AND p.role = 'owner') AS owner_count,
      (SELECT COUNT(*) FROM permissions p
        LEFT JOIN users u
          ON p.grantee_type = 'user'
         AND u.tenant_id = p.tenant_id
         AND u.id = p.grantee_id
        WHERE p.tenant_id = r.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = r.id
          AND p.role = 'owner'
          AND (p.grantee_type = 'group'
               OR (u.id IS NOT NULL AND u.status = 'active'))) AS active_owner_count,
      (SELECT COUNT(*) FROM permissions p
        WHERE p.tenant_id = r.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = r.id
          AND p.role = 'co_owner') AS co_owner_count,
      (SELECT COUNT(*) FROM permissions p
        WHERE p.tenant_id = r.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = r.id
          AND p.role = 'editor') AS editor_count,
      (SELECT COUNT(*) FROM permissions p
        WHERE p.tenant_id = r.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id IN (
            SELECT fc.descendant_id FROM folder_closures fc
             WHERE fc.tenant_id = r.tenant_id AND fc.ancestor_id = r.id
          )) +
      (SELECT COUNT(*) FROM permissions p
        JOIN files fl
          ON fl.tenant_id = p.tenant_id AND fl.id = p.target_id
        WHERE p.tenant_id = r.tenant_id
          AND p.target_type = 'file'
          AND fl.folder_id IN (
            SELECT fc.descendant_id FROM folder_closures fc
             WHERE fc.tenant_id = r.tenant_id AND fc.ancestor_id = r.id
          )) AS total_grant_count,
      (SELECT COUNT(*) FROM permissions p
        LEFT JOIN users u
          ON p.grantee_type = 'user'
         AND u.tenant_id = p.tenant_id
         AND u.id = p.grantee_id
        WHERE p.tenant_id = r.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = r.id
          AND p.role = 'owner'
          AND p.grantee_type = 'user'
          AND u.status = 'suspended') AS suspended_owner_count,
      (SELECT COUNT(*) FROM permissions p
        LEFT JOIN users u
          ON p.grantee_type = 'user'
         AND u.tenant_id = p.tenant_id
         AND u.id = p.grantee_id
        WHERE p.tenant_id = r.tenant_id
          AND p.target_type = 'folder'
          AND p.target_id = r.id
          AND p.role = 'owner'
          AND p.grantee_type = 'user'
          AND u.id IS NULL) AS deleted_owner_count
    FROM folders r
    WHERE r.tenant_id = ? AND r.parent_id IS NULL
    ORDER BY r.name ASC, r.id ASC`;

  const rows = await db.prepare(rowSql).bind(tenantId).all<RootSummaryRow>();
  return rows.results.map((row) => {
    const ownerCount = Number(row.owner_count);
    const activeOwnerCount = Number(row.active_owner_count);
    return {
      id: row.id,
      name: row.name,
      classification: row.classification,
      archived: row.deleted_at !== null,
      deletedAt: row.deleted_at,
      ownerCount,
      activeOwnerCount,
      coOwnerCount: Number(row.co_owner_count),
      editorCount: Number(row.editor_count),
      totalGrantCount: Number(row.total_grant_count),
      ownerMissing: activeOwnerCount === 0,
      hasSuspendedOwner: Number(row.suspended_owner_count) > 0,
      hasDeletedOwner: Number(row.deleted_owner_count) > 0,
    };
  });
}

async function loadAnomalies(
  db: D1Database,
  tenantId: string
): Promise<{
  inactiveGranterCount: number;
  suspendedGranteeCount: number;
  deletedGranteeCount: number;
}> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(DISTINCT p.granted_by)
            FROM permissions p
            LEFT JOIN users gb
              ON gb.tenant_id = p.tenant_id AND gb.id = p.granted_by
           WHERE p.tenant_id = ?
             AND (gb.id IS NULL OR gb.status = 'suspended')) AS inactive_granter_count,
         (SELECT COUNT(*) FROM permissions p
            LEFT JOIN users u
              ON p.grantee_type = 'user'
             AND u.tenant_id = p.tenant_id
             AND u.id = p.grantee_id
           WHERE p.tenant_id = ?
             AND p.grantee_type = 'user'
             AND u.status = 'suspended') AS suspended_grantee_count,
         (SELECT COUNT(*) FROM permissions p
            LEFT JOIN users u
              ON p.grantee_type = 'user'
             AND u.tenant_id = p.tenant_id
             AND u.id = p.grantee_id
           WHERE p.tenant_id = ?
             AND p.grantee_type = 'user'
             AND u.id IS NULL) AS deleted_grantee_count`
    )
    .bind(tenantId, tenantId, tenantId)
    .first<AnomalyRow>();

  return {
    inactiveGranterCount: Number(row?.inactive_granter_count ?? 0),
    suspendedGranteeCount: Number(row?.suspended_grantee_count ?? 0),
    deletedGranteeCount: Number(row?.deleted_grantee_count ?? 0),
  };
}

export async function listAdminPermissionAudit(
  db: D1Database,
  tenantId: string,
  filters: PermissionAuditFilters
): Promise<PermissionAuditResult> {
  const [rootSummaries, anomalies] = await Promise.all([
    loadRootSummaries(db, tenantId),
    loadAnomalies(db, tenantId),
  ]);

  const union = buildUnion(filters, tenantId);
  const outer = outerFilters(filters, tenantId);
  const whereSql =
    outer.conditions.length > 0
      ? `WHERE ${outer.conditions.join(' AND ')}`
      : '';

  const countSql = `SELECT COUNT(*) AS total_count
    FROM (${union.sql}) e
    ${whereSql}`;
  const pageSql = `SELECT
      e.id,
      e.permission_id,
      e.target_type,
      e.target_id,
      e.target_name,
      e.classification,
      e.target_deleted_at,
      e.root_folder_id,
      e.root_folder_name,
      e.grantee_type,
      e.grantee_id,
      e.grantee_name,
      e.grantee_email,
      e.grantee_status,
      e.role,
      e.source,
      e.inherited_from_id,
      e.inherited_from_name,
      e.inherited_depth,
      e.granted_by,
      e.granted_by_name,
      e.granted_by_email,
      e.created_at
    FROM (${union.sql}) e
    ${whereSql}
    ORDER BY ${orderBy(filters)}
    LIMIT ? OFFSET ?`;

  const baseBinds = [...union.binds, ...outer.binds];
  const [countResult, pageResult] = await db.batch([
    db.prepare(countSql).bind(...baseBinds),
    db.prepare(pageSql).bind(...baseBinds, filters.limit, filters.offset),
  ]);

  const totalCount = Number(
    (countResult.results[0] as { total_count?: number } | undefined)
      ?.total_count ?? 0
  );
  const rows = pageResult.results as unknown as AuditEntryRow[];
  const entries: PermissionAuditEntry[] = rows.map((row) => ({
    id: row.id ?? `${row.permission_id}:${row.target_type}:${row.target_id}`,
    permissionId: row.permission_id,
    targetType: row.target_type,
    targetId: row.target_id,
    targetName: row.target_name,
    classification: row.classification,
    targetDeletedAt: row.target_deleted_at,
    rootFolderId: row.root_folder_id,
    rootFolderName: row.root_folder_name,
    granteeType: row.grantee_type,
    granteeId: row.grantee_id,
    granteeName: row.grantee_name,
    granteeEmail: row.grantee_email,
    granteeStatus: row.grantee_status,
    role: row.role,
    source: row.source,
    inheritedFromId: row.inherited_from_id,
    inheritedFromName: row.inherited_from_name,
    inheritedDepth: Number(row.inherited_depth),
    grantedBy: row.granted_by,
    grantedByName: row.granted_by_name,
    grantedByEmail: row.granted_by_email,
    createdAt: row.created_at,
  }));

  return {
    entries,
    totalCount,
    nextOffset:
      filters.offset + entries.length < totalCount
        ? filters.offset + entries.length
        : null,
    rootSummaries,
    anomaliesSummary: {
      ownerMissingCount: rootSummaries.filter((root) => root.ownerMissing)
        .length,
      suspendedOwnerCount: rootSummaries.filter(
        (root) => root.hasSuspendedOwner
      ).length,
      deletedOwnerCount: rootSummaries.filter((root) => root.hasDeletedOwner)
        .length,
      inactiveGranterCount: anomalies.inactiveGranterCount,
      suspendedGranteeCount: anomalies.suspendedGranteeCount,
      deletedGranteeCount: anomalies.deletedGranteeCount,
    },
  };
}

function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Neutralize spreadsheet formula injection while preserving the metadata.
  if (/^[\s]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildPermissionAuditCsv(
  entries: readonly PermissionAuditEntry[]
): string {
  const header = [
    'id',
    'permission_id',
    'target_type',
    'target_id',
    'target_name',
    'classification',
    'target_deleted_at',
    'root_folder_id',
    'root_folder_name',
    'grantee_type',
    'grantee_id',
    'grantee_name',
    'grantee_email',
    'grantee_status',
    'role',
    'source',
    'inherited_from_id',
    'inherited_from_name',
    'inherited_depth',
    'granted_by',
    'granted_by_name',
    'granted_by_email',
    'created_at',
  ];
  const lines = entries.map((entry) =>
    [
      entry.id,
      entry.permissionId,
      entry.targetType,
      entry.targetId,
      entry.targetName,
      entry.classification,
      entry.targetDeletedAt,
      entry.rootFolderId,
      entry.rootFolderName,
      entry.granteeType,
      entry.granteeId,
      entry.granteeName,
      entry.granteeEmail,
      entry.granteeStatus,
      entry.role,
      entry.source,
      entry.inheritedFromId,
      entry.inheritedFromName,
      entry.inheritedDepth,
      entry.grantedBy,
      entry.grantedByName,
      entry.grantedByEmail,
      entry.createdAt,
    ]
      .map((value) => csvCell(value))
      .join(',')
  );
  return [header.join(','), ...lines].join('\n');
}
