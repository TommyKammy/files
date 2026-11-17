import type { FileLockSnapshot } from '../durable-objects/file-lock-hub';
import {
  buildSafeFtsMatchExpression,
  parseSearchQuery,
} from '../routes/search';
import type {
  AuthUser,
  ClassificationLabel,
  ShareAccessScope,
} from '../types/api';
import type { OidcEnv } from '../types/oidc';
import { chunkArray, executeBatchChunks } from '../utils/batch';
import { VALID_CLASSIFICATIONS } from '../utils/classification';
import {
  buildActiveFileLockDeleteStmt,
  buildActiveFileLockUpsertStmt,
} from './active-file-lock-index';
import { buildAuditLogStmt } from './audit';
import { base64UrlToBytes, bytesToBase64Url } from './crypto-utils';
import { deliverFileContent } from './file-content-access';
import { getFileLockState } from './file-lock';
import {
  folderPathLabel,
  loadFolderBreadcrumbMap,
  type FolderBreadcrumb,
} from './folder-breadcrumbs';
import { resolvePermissionLevel } from './shared-link-permissions';
import { buildSyncChangeStmt } from './sync-changes';
import { notifyTenantSyncHub } from './sync-notifier';

export const ADMIN_CONTENT_MAX_LIMIT = 100;
export const ADMIN_CONTENT_DEFAULT_LIMIT = 25;
export const ADMIN_CONTENT_REASON_MIN = 3;
export const ADMIN_CONTENT_REASON_MAX = 300;

export type AdminContentTargetType = 'file' | 'folder';
export type AdminContentSearchTargetType = 'all' | AdminContentTargetType;
export type AdminContentInspectPolicy =
  | 'disabled'
  | 'deny_confidential'
  | 'watermark_confidential';

export const ADMIN_CONTENT_INSPECT_POLICIES: ReadonlySet<AdminContentInspectPolicy> =
  new Set(['disabled', 'deny_confidential', 'watermark_confidential']);

export const DEFAULT_ADMIN_CONTENT_INSPECT_POLICY: AdminContentInspectPolicy =
  'watermark_confidential';

export class AdminContentError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 503,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminContentError';
  }
}

export interface AdminContentCursor {
  updatedAt: string;
  id: string;
}

export function encodeAdminContentCursor(cursor: AdminContentCursor): string {
  return bytesToBase64Url(
    new TextEncoder().encode(JSON.stringify(cursor))
  );
}

export function decodeAdminContentCursor(
  raw: string | undefined
): AdminContentCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(raw))
    ) as Partial<AdminContentCursor>;
    if (
      typeof parsed.updatedAt !== 'string' ||
      !parsed.updatedAt ||
      typeof parsed.id !== 'string' ||
      !parsed.id
    ) {
      return null;
    }
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return null;
  }
}

export function validateAdminContentReason(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new AdminContentError(
      400,
      'INSPECT_REASON_REQUIRED',
      'reason is required (3-300 characters)'
    );
  }
  const reason = raw.trim();
  if (
    reason.length < ADMIN_CONTENT_REASON_MIN ||
    reason.length > ADMIN_CONTENT_REASON_MAX
  ) {
    throw new AdminContentError(
      400,
      'INVALID_INSPECT_REASON',
      `reason must be ${ADMIN_CONTENT_REASON_MIN}-${ADMIN_CONTENT_REASON_MAX} characters`
    );
  }
  return reason;
}

export function isAdminContentInspectPolicy(
  value: unknown
): value is AdminContentInspectPolicy {
  return (
    typeof value === 'string' &&
    ADMIN_CONTENT_INSPECT_POLICIES.has(value as AdminContentInspectPolicy)
  );
}

export async function getAdminContentInspectPolicy(
  db: D1Database,
  tenantId: string
): Promise<AdminContentInspectPolicy> {
  const row = await db
    .prepare(
      'SELECT admin_content_inspect_policy FROM tenant_policies WHERE tenant_id = ?'
    )
    .bind(tenantId)
    .first<{ admin_content_inspect_policy: string | null }>();
  return isAdminContentInspectPolicy(row?.admin_content_inspect_policy)
    ? row.admin_content_inspect_policy
    : DEFAULT_ADMIN_CONTENT_INSPECT_POLICY;
}

/** Escape LIKE metacharacters for a literal, safe prefix search. */
export function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function folderPrefixFromQuery(rawQuery: string): string | null {
  const parts = rawQuery
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !/^is:/i.test(part));
  const prefix = parts.join(' ').slice(0, 100);
  return prefix ? escapeLikePrefix(prefix) : null;
}

function normalizeExtension(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().replace(/^\./, '').toLowerCase();
  return normalized || null;
}

function normalizeClassification(
  value: string | null | undefined
): ClassificationLabel | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase() as ClassificationLabel;
  return VALID_CLASSIFICATIONS.has(normalized) ? normalized : null;
}

export interface AdminContentSearchQueryInput {
  tenantId: string;
  targetType: AdminContentSearchTargetType;
  ftsExpression: string | null;
  folderPrefix: string | null;
  classification: ClassificationLabel | null;
  createdByUserId: string | null;
  rootFolderId: string | null;
  extension: string | null;
  lockedOnly: boolean;
  hasSharedLink: boolean;
  cursor: AdminContentCursor | null;
  limit: number;
  lockedNowIso: string;
  /** Set when a non-empty query parsed to no usable FTS/classification text. */
  fileMatchNone?: boolean;
}

export interface AdminContentSearchQuery {
  sql: string;
  binds: Array<string | number>;
}

/**
 * Build the single UNION ALL keyset query used by both the route and
 * EXPLAIN QUERY PLAN regression tests.
 */
export function buildAdminContentSearchQuery(
  input: AdminContentSearchQueryInput
): AdminContentSearchQuery {
  const fileBinds: Array<string | number> = [];
  const folderBinds: Array<string | number> = [];

  const hasFileArm =
    input.targetType === 'all' || input.targetType === 'file';
  const hasFolderArm =
    (input.targetType === 'all' || input.targetType === 'folder') &&
    !input.lockedOnly &&
    !input.extension;

  const fileWhere: string[] = [];
  const folderWhere: string[] = [];

  let fileFrom: string;
  if (input.ftsExpression) {
    fileFrom = `FROM files_fts fts
      JOIN files fl ON fl.id = fts.file_id
      LEFT JOIN users u ON u.tenant_id = fl.tenant_id AND u.id = fl.created_by
      LEFT JOIN active_file_locks afl
        ON afl.file_id = fl.id AND afl.tenant_id = fl.tenant_id`;
    fileWhere.push('files_fts MATCH ?');
    fileBinds.push(input.ftsExpression);
  } else {
    const classificationIndexHint =
      input.classification && !input.createdByUserId
        ? ' INDEXED BY idx_files_classification'
        : '';
    fileFrom = `FROM files fl${classificationIndexHint}
      LEFT JOIN users u ON u.tenant_id = fl.tenant_id AND u.id = fl.created_by
      LEFT JOIN active_file_locks afl
        ON afl.file_id = fl.id AND afl.tenant_id = fl.tenant_id`;
  }

  fileWhere.push(
    'fl.tenant_id = ?',
    "fl.deleted_at IS NULL",
    "fl.upload_state = 'active'"
  );
  fileBinds.push(input.tenantId);

  if (input.fileMatchNone) {
    fileWhere.push('0 = 1');
  }
  if (input.classification) {
    fileWhere.push('fl.classification = ?');
    fileBinds.push(input.classification);
  }
  if (input.createdByUserId) {
    fileWhere.push('fl.created_by = ?');
    fileBinds.push(input.createdByUserId);
  }
  if (input.rootFolderId) {
    fileWhere.push(
      `fl.folder_id IN (
         SELECT fc.descendant_id
           FROM folder_closures fc
          WHERE fc.tenant_id = ? AND fc.ancestor_id = ?
       )`
    );
    fileBinds.push(input.tenantId, input.rootFolderId);
  }
  if (input.extension) {
    fileWhere.push('LOWER(fl.extension) = ?');
    fileBinds.push(input.extension);
  }
  if (input.lockedOnly) {
    fileWhere.push(
      `EXISTS (
         SELECT 1 FROM active_file_locks lock_idx
          WHERE lock_idx.file_id = fl.id
            AND lock_idx.tenant_id = fl.tenant_id
            AND lock_idx.expires_at > ?
       )`
    );
    fileBinds.push(input.lockedNowIso);
  }
  if (input.hasSharedLink) {
    fileWhere.push(
      `EXISTS (
         SELECT 1 FROM shared_links sl
          WHERE sl.tenant_id = fl.tenant_id
            AND sl.target_type = 'file'
            AND sl.target_id = fl.id
            AND sl.revoked_at IS NULL
       )`
    );
  }
  if (input.cursor) {
    fileWhere.push(
      '(fl.updated_at < ? OR (fl.updated_at = ? AND fl.id < ?))'
    );
    fileBinds.push(
      input.cursor.updatedAt,
      input.cursor.updatedAt,
      input.cursor.id
    );
  }

  folderWhere.push('fo.tenant_id = ?', 'fo.deleted_at IS NULL');
  folderBinds.push(input.tenantId);
  if (input.classification) {
    folderWhere.push('fo.classification = ?');
    folderBinds.push(input.classification);
  }
  if (input.createdByUserId) {
    folderWhere.push('fo.created_by = ?');
    folderBinds.push(input.createdByUserId);
  }
  if (input.rootFolderId) {
    folderWhere.push(
      `fo.id IN (
         SELECT fc.descendant_id
           FROM folder_closures fc
          WHERE fc.tenant_id = ? AND fc.ancestor_id = ?
       )`
    );
    folderBinds.push(input.tenantId, input.rootFolderId);
  }
  if (input.folderPrefix) {
    folderWhere.push("fo.name LIKE ? ESCAPE '\\'");
    folderBinds.push(`${input.folderPrefix}%`);
  }
  if (input.hasSharedLink) {
    folderWhere.push(
      `EXISTS (
         SELECT 1 FROM shared_links sl
          WHERE sl.tenant_id = fo.tenant_id
            AND sl.target_type = 'folder'
            AND sl.target_id = fo.id
            AND sl.revoked_at IS NULL
       )`
    );
  }
  if (input.cursor) {
    folderWhere.push(
      '(fo.updated_at < ? OR (fo.updated_at = ? AND fo.id < ?))'
    );
    folderBinds.push(
      input.cursor.updatedAt,
      input.cursor.updatedAt,
      input.cursor.id
    );
  }

  const arms: string[] = [];
  if (hasFileArm) {
    arms.push(
      `SELECT 'file' AS target_type,
              fl.id,
              fl.name,
              fl.folder_id AS folder_id,
              NULL AS parent_id,
              fl.classification,
              fl.extension,
              fl.size_bytes,
              fl.current_version_num,
              fl.created_by,
              fl.updated_at,
              u.email AS owner_email,
              u.display_name AS owner_display_name,
              afl.lock_id AS shadow_lock_id
         ${fileFrom}
        WHERE ${fileWhere.join('\n          AND ')}`
    );
  }
  if (hasFolderArm) {
    arms.push(
      `SELECT 'folder' AS target_type,
              fo.id,
              fo.name,
              fo.parent_id AS folder_id,
              fo.parent_id AS parent_id,
              fo.classification,
              NULL AS extension,
              NULL AS size_bytes,
              NULL AS current_version_num,
              fo.created_by,
              fo.updated_at,
              u.email AS owner_email,
              u.display_name AS owner_display_name,
              NULL AS shadow_lock_id
         FROM folders fo
         LEFT JOIN users u ON u.tenant_id = fo.tenant_id AND u.id = fo.created_by
        WHERE ${folderWhere.join('\n          AND ')}`
    );
  }

  const sql = `SELECT *
      FROM (
        ${arms.join('\n        UNION ALL\n        ')}
      )
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`;
  return {
    sql,
    binds: [
      ...(hasFileArm ? fileBinds : []),
      ...(hasFolderArm ? folderBinds : []),
      input.limit + 1,
    ],
  };
}

interface AdminContentSearchRow {
  target_type: AdminContentTargetType;
  id: string;
  name: string;
  folder_id: string | null;
  parent_id: string | null;
  classification: ClassificationLabel;
  extension: string | null;
  size_bytes: number | null;
  current_version_num: number | null;
  created_by: string;
  updated_at: string;
  owner_email: string | null;
  owner_display_name: string | null;
  shadow_lock_id: string | null;
}

export interface AdminContentOwner {
  id: string;
  email: string | null;
  displayName: string | null;
}

export interface AdminContentSearchItem {
  targetType: AdminContentTargetType;
  id: string;
  name: string;
  folderId: string | null;
  parentId: string | null;
  pathLabel: string;
  breadcrumbs: FolderBreadcrumb[];
  owner: AdminContentOwner;
  classification: ClassificationLabel;
  extension: string | null;
  sizeBytes: number | null;
  currentVersionNum: number | null;
  activeSharedLinkCount: number;
  activeLock: FileLockSnapshot | null;
  updatedAt: string;
}

export interface AdminContentSearchResult {
  items: AdminContentSearchItem[];
  nextCursor: string | null;
  limit: number;
}

export interface AdminContentSearchFilters {
  targetType: AdminContentSearchTargetType;
  query: string;
  createdBy: string | null;
  rootFolderId: string | null;
  classification: ClassificationLabel | null;
  extension: string | null;
  lockedOnly: boolean;
  hasSharedLink: boolean;
  cursor: AdminContentCursor | null;
  limit: number;
}

export function parseAdminContentSearchFilters(
  query: (name: string) => string | undefined
): AdminContentSearchFilters {
  const targetTypeRaw = query('targetType');
  const targetType: AdminContentSearchTargetType =
    targetTypeRaw === 'file' || targetTypeRaw === 'folder'
      ? targetTypeRaw
      : 'all';

  const limitRaw = Number.parseInt(
    query('limit') ?? String(ADMIN_CONTENT_DEFAULT_LIMIT),
    10
  );
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(limitRaw, 1), ADMIN_CONTENT_MAX_LIMIT)
    : ADMIN_CONTENT_DEFAULT_LIMIT;

  const cursorRaw = query('cursor');
  const cursor = cursorRaw ? decodeAdminContentCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) {
    throw new AdminContentError(
      400,
      'INVALID_CURSOR',
      'Invalid pagination cursor'
    );
  }

  return {
    targetType,
    query: (query('query') ?? query('q') ?? '').trim().slice(0, 500),
    createdBy: query('createdBy')?.trim() || null,
    rootFolderId: query('rootFolderId')?.trim() || null,
    classification: normalizeClassification(query('classification')),
    extension: normalizeExtension(query('extension')),
    lockedOnly:
      query('lockedOnly') === '1' || query('lockedOnly') === 'true',
    hasSharedLink:
      query('hasSharedLink') === '1' || query('hasSharedLink') === 'true',
    cursor,
    limit,
  };
}

async function resolveCreatedByUserId(
  db: D1Database,
  tenantId: string,
  createdBy: string | null
): Promise<string | null> {
  if (!createdBy) return null;
  const row = createdBy.includes('@')
    ? await db
        .prepare(
          `SELECT id FROM users
            WHERE tenant_id = ? AND LOWER(email) = LOWER(?)
            LIMIT 1`
        )
        .bind(tenantId, createdBy)
        .first<{ id: string }>()
    : await db
        .prepare(
          `SELECT id FROM users
            WHERE tenant_id = ? AND id = ?
            LIMIT 1`
        )
        .bind(tenantId, createdBy)
        .first<{ id: string }>();
  return row?.id ?? null;
}

async function loadSharedLinkCounts(
  db: D1Database,
  tenantId: string,
  fileIds: readonly string[],
  folderIds: readonly string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const groups: Array<{ type: AdminContentTargetType; ids: string[] }> = [
    { type: 'file', ids: [...new Set(fileIds)] },
    { type: 'folder', ids: [...new Set(folderIds)] },
  ];
  for (const group of groups) {
    for (const chunk of chunkArray(group.ids, 30)) {
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await db
        .prepare(
          `SELECT target_id, COUNT(*) AS cnt
             FROM shared_links
            WHERE tenant_id = ?
              AND target_type = ?
              AND revoked_at IS NULL
              AND target_id IN (${placeholders})
            GROUP BY target_id`
        )
        .bind(tenantId, group.type, ...chunk)
        .all<{ target_id: string; cnt: number }>();
      for (const row of rows.results) {
        counts.set(`${group.type}:${row.target_id}`, Number(row.cnt));
      }
    }
  }
  return counts;
}

export async function searchAdminContent(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  filters: AdminContentSearchFilters
): Promise<AdminContentSearchResult> {
  const parsed = filters.query
    ? parseSearchQuery(filters.query)
    : { classificationFilter: null, ftsTerms: [] };
  const classification =
    filters.classification ?? parsed.classificationFilter;
  const ftsExpression =
    parsed.ftsTerms.length > 0
      ? buildSafeFtsMatchExpression({
          classificationFilter: null,
          ftsTerms: parsed.ftsTerms,
        })
      : null;

  const createdByUserId = await resolveCreatedByUserId(
    env.DB,
    tenantId,
    filters.createdBy
  );
  if (filters.createdBy && !createdByUserId) {
    return { items: [], nextCursor: null, limit: filters.limit };
  }
  if (
    filters.targetType === 'folder' &&
    (filters.lockedOnly || Boolean(filters.extension))
  ) {
    return { items: [], nextCursor: null, limit: filters.limit };
  }

  const query = buildAdminContentSearchQuery({
    tenantId,
    targetType: filters.targetType,
    ftsExpression,
    folderPrefix: filters.query
      ? folderPrefixFromQuery(filters.query)
      : null,
    classification,
    createdByUserId,
    rootFolderId: filters.rootFolderId,
    extension: filters.extension,
    lockedOnly: filters.lockedOnly,
    hasSharedLink: filters.hasSharedLink,
    cursor: filters.cursor,
    limit: filters.limit,
    lockedNowIso: new Date().toISOString(),
    fileMatchNone:
      Boolean(filters.query) &&
      !classification &&
      parsed.ftsTerms.length === 0,
  });

  const rows = await env.DB.prepare(query.sql)
    .bind(...query.binds)
    .all<AdminContentSearchRow>();

  const pageRows = rows.results.slice(0, filters.limit);
  const hasMore = rows.results.length > filters.limit;

  const fileRows = pageRows.filter((row) => row.target_type === 'file');
  const folderRows = pageRows.filter((row) => row.target_type === 'folder');

  const [breadcrumbMap, sharedCounts] = await Promise.all([
    loadFolderBreadcrumbMap(env.DB, tenantId, [
      ...fileRows.map((row) => row.folder_id ?? ''),
      ...folderRows.map((row) => row.id),
    ]),
    loadSharedLinkCounts(
      env.DB,
      tenantId,
      fileRows.map((row) => row.id),
      folderRows.map((row) => row.id)
    ),
  ]);

  const liveLocks = new Map<string, FileLockSnapshot>();
  const shadowStatements: D1PreparedStatement[] = [];
  await Promise.all(
    fileRows.map(async (row) => {
      const live = await getFileLockState(env, row.id);
      if (live) liveLocks.set(row.id, live);
      if (live && !row.shadow_lock_id) {
        shadowStatements.push(buildActiveFileLockUpsertStmt(env.DB, live));
      } else if (!live && row.shadow_lock_id) {
        shadowStatements.push(
          buildActiveFileLockDeleteStmt(env.DB, row.id, tenantId)
        );
      }
    })
  );
  if (shadowStatements.length > 0) {
    await executeBatchChunks(env.DB, shadowStatements, 30);
  }

  const items = pageRows.map((row): AdminContentSearchItem => {
    const breadcrumbs =
      row.target_type === 'folder'
        ? breadcrumbMap.get(row.id) ?? []
        : row.folder_id
          ? breadcrumbMap.get(row.folder_id) ?? []
          : [];
    const live = row.target_type === 'file' ? liveLocks.get(row.id) ?? null : null;
    return {
      targetType: row.target_type,
      id: row.id,
      name: row.name,
      folderId: row.folder_id,
      parentId: row.parent_id,
      pathLabel: folderPathLabel(breadcrumbs),
      breadcrumbs,
      owner: {
        id: row.created_by,
        email: row.owner_email,
        displayName: row.owner_display_name,
      },
      classification: row.classification,
      extension: row.extension,
      sizeBytes: row.size_bytes,
      currentVersionNum: row.current_version_num,
      activeSharedLinkCount:
        sharedCounts.get(`${row.target_type}:${row.id}`) ?? 0,
      activeLock: live,
      updatedAt: row.updated_at,
    };
  });

  // `lockedOnly` candidates come from the indexed shadow table, but the
  // returned rows must reflect the live FileLockHub state.
  const verifiedItems = filters.lockedOnly
    ? items.filter((item) => item.activeLock !== null)
    : items;

  const lastItem = verifiedItems[verifiedItems.length - 1];
  const lastRawRow = pageRows[pageRows.length - 1];
  const nextCursorSource = lastItem
    ? { updatedAt: lastItem.updatedAt, id: lastItem.id }
    : lastRawRow
      ? { updatedAt: lastRawRow.updated_at, id: lastRawRow.id }
      : null;
  return {
    items: verifiedItems,
    nextCursor:
      hasMore && nextCursorSource
        ? encodeAdminContentCursor(nextCursorSource)
        : null,
    limit: filters.limit,
  };
}

interface AdminContentDetailRow {
  id: string;
  tenant_id: string;
  folder_id: string | null;
  parent_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  classification: ClassificationLabel;
  current_version_id: string | null;
  current_version_num: number | null;
  created_by: string;
  updated_at: string;
  created_at: string;
  owner_email: string | null;
  owner_display_name: string | null;
}

export interface AdminContentPermissionItem {
  id: string;
  granteeType: 'user' | 'group';
  granteeId: string;
  granteeName: string | null;
  granteeEmail: string | null;
  role: string;
  grantedBy: string;
  grantedByEmail: string | null;
  createdAt: string;
}

export interface AdminContentSharedLinkItem {
  id: string;
  targetType: AdminContentTargetType;
  targetId: string;
  accessScope: string;
  permissionLevel: 'view' | 'download' | 'edit';
  canDownload: boolean;
  requireWatermark: boolean;
  hasPassword: boolean;
  isLocked: boolean;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  createdBy: string;
  creatorEmail: string | null;
  createdAt: string;
}

export interface AdminContentVersionItem {
  id: string;
  versionNum: number;
  sizeBytes: number;
  mimeType: string;
  uploadStatus: string;
  uploadedBy: string;
  uploadedByEmail: string | null;
  comment: string | null;
  createdAt: string;
}

export interface AdminContentDetail {
  targetType: AdminContentTargetType;
  id: string;
  name: string;
  folderId: string | null;
  parentId: string | null;
  pathLabel: string;
  breadcrumbs: FolderBreadcrumb[];
  owner: AdminContentOwner;
  classification: ClassificationLabel;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  currentVersionId: string | null;
  currentVersionNum: number | null;
  createdAt: string;
  updatedAt: string;
  activeLock: FileLockSnapshot | null;
  permissions: AdminContentPermissionItem[];
  sharedLinks: AdminContentSharedLinkItem[];
  versions: {
    total: number;
    items: AdminContentVersionItem[];
  };
  inspectPolicy: AdminContentInspectPolicy;
}

interface PermissionRow {
  id: string;
  grantee_type: 'user' | 'group';
  grantee_id: string;
  grantee_name: string | null;
  grantee_email: string | null;
  role: string;
  granted_by: string;
  granted_by_email: string | null;
  created_at: string;
}

interface SharedLinkDetailRow {
  id: string;
  target_type: AdminContentTargetType;
  target_id: string;
  access_scope: string;
  permission_level: string;
  can_download: number;
  require_watermark: number;
  password_hash: string | null;
  locked_until: string | null;
  expires_at: string | null;
  max_downloads: number | null;
  download_count: number;
  created_by: string;
  creator_email: string | null;
  created_at: string;
}

interface VersionRow {
  id: string;
  version_num: number;
  size_bytes: number;
  mime_type: string;
  upload_status: string;
  uploaded_by: string;
  uploaded_by_email: string | null;
  comment: string | null;
  created_at: string;
}

export async function getAdminContentDetail(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  targetType: AdminContentTargetType,
  targetId: string
): Promise<AdminContentDetail | null> {
  if (targetType === 'file') {
    const row = await env.DB.prepare(
      `SELECT fl.id, fl.tenant_id, fl.folder_id, NULL AS parent_id, fl.name,
              fl.extension, fl.mime_type, fl.size_bytes, fl.classification,
              fl.current_version_id, fl.current_version_num, fl.created_by,
              fl.updated_at, fl.created_at,
              u.email AS owner_email, u.display_name AS owner_display_name
         FROM files fl
         LEFT JOIN users u
           ON u.tenant_id = fl.tenant_id AND u.id = fl.created_by
        WHERE fl.tenant_id = ? AND fl.id = ?
          AND fl.deleted_at IS NULL AND fl.upload_state = 'active'`
    )
      .bind(tenantId, targetId)
      .first<AdminContentDetailRow>();
    if (!row) return null;
    return assembleAdminContentDetail(env, tenantId, 'file', row);
  }

  const row = await env.DB.prepare(
    `SELECT fo.id, fo.tenant_id, fo.parent_id AS folder_id, fo.parent_id,
            fo.name, NULL AS extension, NULL AS mime_type, NULL AS size_bytes,
            fo.classification, NULL AS current_version_id,
            NULL AS current_version_num, fo.created_by, fo.updated_at,
            fo.created_at,
            u.email AS owner_email, u.display_name AS owner_display_name
       FROM folders fo
       LEFT JOIN users u
         ON u.tenant_id = fo.tenant_id AND u.id = fo.created_by
      WHERE fo.tenant_id = ? AND fo.id = ? AND fo.deleted_at IS NULL`
  )
    .bind(tenantId, targetId)
    .first<AdminContentDetailRow>();
  if (!row) return null;
  return assembleAdminContentDetail(env, tenantId, 'folder', row);
}

async function assembleAdminContentDetail(
  env: Pick<OidcEnv, 'DB' | 'FILE_LOCK_HUB'>,
  tenantId: string,
  targetType: AdminContentTargetType,
  row: AdminContentDetailRow
): Promise<AdminContentDetail> {
  const breadcrumbFolderId =
    targetType === 'folder' ? row.id : row.folder_id;
  const [breadcrumbMap, permissions, sharedLinks, versions, versionCount, lock, inspectPolicy] =
    await Promise.all([
      breadcrumbFolderId
        ? loadFolderBreadcrumbMap(env.DB, tenantId, [breadcrumbFolderId])
        : Promise.resolve(new Map<string, FolderBreadcrumb[]>()),
      env.DB.prepare(
        `SELECT p.id, p.grantee_type, p.grantee_id,
                COALESCE(gu.display_name, gg.name, p.grantee_id) AS grantee_name,
                gu.email AS grantee_email,
                p.role, p.granted_by,
                actor.email AS granted_by_email, p.created_at
           FROM permissions p
           LEFT JOIN users gu
             ON p.grantee_type = 'user'
            AND gu.tenant_id = p.tenant_id AND gu.id = p.grantee_id
           LEFT JOIN groups gg
             ON p.grantee_type = 'group'
            AND gg.tenant_id = p.tenant_id AND gg.id = p.grantee_id
           LEFT JOIN users actor
             ON actor.tenant_id = p.tenant_id AND actor.id = p.granted_by
          WHERE p.tenant_id = ? AND p.target_type = ? AND p.target_id = ?
          ORDER BY p.created_at ASC, p.id ASC`
      )
        .bind(tenantId, targetType, row.id)
        .all<PermissionRow>(),
      env.DB.prepare(
        `SELECT sl.id, sl.target_type, sl.target_id, sl.access_scope,
                sl.permission_level, sl.can_download, sl.require_watermark,
                sl.password_hash, sl.locked_until, sl.expires_at,
                sl.max_downloads, sl.download_count, sl.created_by,
                creator.email AS creator_email, sl.created_at
           FROM shared_links sl
           LEFT JOIN users creator
             ON creator.tenant_id = sl.tenant_id AND creator.id = sl.created_by
          WHERE sl.tenant_id = ? AND sl.target_type = ? AND sl.target_id = ?
            AND sl.revoked_at IS NULL
          ORDER BY sl.created_at DESC`
      )
        .bind(tenantId, targetType, row.id)
        .all<SharedLinkDetailRow>(),
      targetType === 'file'
        ? env.DB.prepare(
            `SELECT fv.id, fv.version_num, fv.size_bytes, fv.mime_type,
                    fv.upload_status, fv.uploaded_by,
                    uploader.email AS uploaded_by_email, fv.comment,
                    fv.created_at
               FROM file_versions fv
               LEFT JOIN users uploader
                 ON uploader.tenant_id = fv.tenant_id
                AND uploader.id = fv.uploaded_by
              WHERE fv.tenant_id = ? AND fv.file_id = ?
              ORDER BY fv.version_num DESC
              LIMIT 50`
          )
            .bind(tenantId, row.id)
            .all<VersionRow>()
        : Promise.resolve({ results: [] as VersionRow[] }),
      targetType === 'file'
        ? env.DB.prepare(
            `SELECT COUNT(*) AS cnt FROM file_versions
              WHERE tenant_id = ? AND file_id = ?`
          )
            .bind(tenantId, row.id)
            .first<{ cnt: number }>()
        : Promise.resolve(null),
      targetType === 'file'
        ? getFileLockState(env, row.id)
        : Promise.resolve(null),
      getAdminContentInspectPolicy(env.DB, tenantId),
    ]);

  if (targetType === 'file' && lock) {
    await buildActiveFileLockUpsertStmt(env.DB, lock).run();
  } else if (targetType === 'file' && !lock) {
    await buildActiveFileLockDeleteStmt(env.DB, row.id, tenantId).run();
  }

  const breadcrumbs = breadcrumbFolderId
    ? breadcrumbMap.get(breadcrumbFolderId) ?? []
    : [];
  const nowMs = Date.now();

  return {
    targetType,
    id: row.id,
    name: row.name,
    folderId: row.folder_id,
    parentId: row.parent_id,
    pathLabel: folderPathLabel(breadcrumbs),
    breadcrumbs,
    owner: {
      id: row.created_by,
      email: row.owner_email,
      displayName: row.owner_display_name,
    },
    classification: row.classification,
    extension: row.extension,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    currentVersionId: row.current_version_id,
    currentVersionNum: row.current_version_num,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeLock: lock,
    permissions: permissions.results.map((permission) => ({
      id: permission.id,
      granteeType: permission.grantee_type,
      granteeId: permission.grantee_id,
      granteeName: permission.grantee_name,
      granteeEmail: permission.grantee_email,
      role: permission.role,
      grantedBy: permission.granted_by,
      grantedByEmail: permission.granted_by_email,
      createdAt: permission.created_at,
    })),
    sharedLinks: sharedLinks.results.map((link) => ({
      id: link.id,
      targetType: link.target_type,
      targetId: link.target_id,
      accessScope: link.access_scope,
      permissionLevel: resolvePermissionLevel({
        access_scope: link.access_scope as ShareAccessScope,
        can_download: link.can_download,
        permission_level: link.permission_level,
      }),
      canDownload: link.can_download === 1,
      requireWatermark: link.require_watermark === 1,
      hasPassword: Boolean(link.password_hash),
      isLocked: Boolean(
        link.locked_until && Date.parse(link.locked_until) > nowMs
      ),
      expiresAt: link.expires_at,
      maxDownloads: link.max_downloads,
      downloadCount: link.download_count,
      createdBy: link.created_by,
      creatorEmail: link.creator_email,
      createdAt: link.created_at,
    })),
    versions: {
      total: Number(versionCount?.cnt ?? 0),
      items: versions.results.map((version) => ({
        id: version.id,
        versionNum: version.version_num,
        sizeBytes: version.size_bytes,
        mimeType: version.mime_type,
        uploadStatus: version.upload_status,
        uploadedBy: version.uploaded_by,
        uploadedByEmail: version.uploaded_by_email,
        comment: version.comment,
        createdAt: version.created_at,
      })),
    },
    inspectPolicy,
  };
}

interface FileTargetRow {
  id: string;
  folder_id: string | null;
  name: string;
  classification: ClassificationLabel;
  current_version_id: string | null;
  current_version_num: number;
}

async function loadActiveFileTarget(
  db: D1Database,
  tenantId: string,
  fileId: string
): Promise<FileTargetRow | null> {
  return db
    .prepare(
      `SELECT id, folder_id, name, classification,
              current_version_id, current_version_num
         FROM files
        WHERE tenant_id = ? AND id = ?
          AND deleted_at IS NULL AND upload_state = 'active'`
    )
    .bind(tenantId, fileId)
    .first<FileTargetRow>();
}

export interface AdminContentForceUnlockResult {
  ok: true;
  fileId: string;
  released: boolean;
  lock: FileLockSnapshot | null;
  revokedWopiSessionCount: number;
  syncSeq: number | null;
}

export async function forceUnlockAdminContentFile(
  env: OidcEnv,
  actor: AuthUser,
  fileId: string,
  reason: string
): Promise<AdminContentForceUnlockResult> {
  const file = await loadActiveFileTarget(env.DB, actor.tenantId, fileId);
  if (!file) {
    throw new AdminContentError(404, 'FILE_NOT_FOUND', 'File not found');
  }

  const liveLock = await getFileLockState(env, fileId);
  if (!liveLock || liveLock.tenantId !== actor.tenantId) {
    await buildActiveFileLockDeleteStmt(
      env.DB,
      fileId,
      actor.tenantId
    ).run();
    throw new AdminContentError(
      409,
      'FILE_LOCK_NOT_FOUND',
      'No active lock is held for this file'
    );
  }
  if (!env.FILE_LOCK_HUB) {
    throw new AdminContentError(
      503,
      'LOCK_SERVICE_UNAVAILABLE',
      'Lock service unavailable'
    );
  }

  const stub = env.FILE_LOCK_HUB.get(env.FILE_LOCK_HUB.idFromName(fileId));
  const forced = await stub.forceUnlock({
    fileId,
    tenantId: actor.tenantId,
  });
  if (!forced.released) {
    throw new AdminContentError(
      409,
      'FILE_LOCK_NOT_FOUND',
      'No active lock is held for this file'
    );
  }

  const nowIso = new Date().toISOString();
  const releasedLock = forced.lock ?? liveLock;
  const batchResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE wopi_sessions
          SET is_active = 0, revoked_at = ?
        WHERE tenant_id = ? AND file_id = ? AND is_active = 1`
    ).bind(nowIso, actor.tenantId, fileId),
    buildActiveFileLockDeleteStmt(env.DB, fileId, actor.tenantId),
    buildAuditLogStmt(env.DB, {
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorEmail: actor.email,
      actorIp: actor.ipAddress,
      action: 'admin.content.force_unlock',
      targetType: 'file',
      targetId: fileId,
      classificationSnapshot: file.classification,
      metadata: {
        reason,
        lockId: releasedLock.lockId,
        mode: releasedLock.mode,
        ownerId: releasedLock.ownerId,
        ownerEmail: releasedLock.ownerEmail,
      },
      nowIso,
    }),
    buildSyncChangeStmt(env.DB, {
      tenantId: actor.tenantId,
      entityType: 'file',
      entityId: fileId,
      folderId: file.folder_id,
      action: 'admin.content.force_unlock',
      payload: {
        fileId,
        lockId: releasedLock.lockId,
        mode: releasedLock.mode,
        ownerId: releasedLock.ownerId,
        reason,
        forcedBy: actor.id,
        releasedAt: nowIso,
      },
      nowIso,
    }),
  ]);

  const revokedWopiSessionCount = Number(batchResults[0]?.meta?.changes ?? 0);
  const syncSeq =
    typeof batchResults[3]?.meta?.last_row_id === 'number'
      ? Number(batchResults[3].meta.last_row_id)
      : null;

  await notifyTenantSyncHub(env, {
    tenantId: actor.tenantId,
    eventKind: 'admin.content.force_unlock',
    seq: syncSeq,
    scopeFolderIds: [file.folder_id],
    metadata: {
      fileId,
      reason,
      lockId: releasedLock.lockId,
      mode: releasedLock.mode,
      revokedWopiSessionCount,
    },
  });

  return {
    ok: true,
    fileId,
    released: true,
    lock: releasedLock,
    revokedWopiSessionCount,
    syncSeq,
  };
}

export interface AdminContentInspectResult {
  ok: true;
  fileId: string;
  fileName: string;
  classification: ClassificationLabel;
  policyApplied: AdminContentInspectPolicy;
  watermarkRequired: boolean;
  url: string;
  expiresAt: string;
  disposition: 'inline' | 'attachment';
  watermarkText: string | null;
  versionId?: string;
  versionNum?: number;
}

async function recordInspectAudit(
  db: D1Database,
  actor: AuthUser,
  file: FileTargetRow,
  reason: string,
  policyApplied: AdminContentInspectPolicy,
  status: 'allowed' | 'blocked',
  watermarkRequired: boolean,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await buildAuditLogStmt(db, {
    tenantId: actor.tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    actorIp: actor.ipAddress,
    action: 'admin.content.inspect',
    targetType: 'file',
    targetId: file.id,
    classificationSnapshot: file.classification,
    status,
    metadata: {
      reason,
      policyApplied,
      watermarkRequired,
      ...extra,
    },
    nowIso: new Date().toISOString(),
  }).run();
}

export async function inspectAdminContentFile(
  env: OidcEnv,
  actor: AuthUser,
  fileId: string,
  reason: string
): Promise<AdminContentInspectResult> {
  const file = await loadActiveFileTarget(env.DB, actor.tenantId, fileId);
  if (!file) {
    throw new AdminContentError(404, 'FILE_NOT_FOUND', 'File not found');
  }

  const policyApplied = await getAdminContentInspectPolicy(
    env.DB,
    actor.tenantId
  );

  if (policyApplied === 'disabled') {
    await recordInspectAudit(
      env.DB,
      actor,
      file,
      reason,
      policyApplied,
      'blocked',
      false,
      { blockedReason: 'ADMIN_INSPECT_DISABLED' }
    );
    throw new AdminContentError(
      403,
      'ADMIN_INSPECT_DISABLED',
      '管理者コンテンツ検査はテナントポリシーにより無効化されています'
    );
  }

  if (
    policyApplied === 'deny_confidential' &&
    file.classification === 'confidential'
  ) {
    await recordInspectAudit(
      env.DB,
      actor,
      file,
      reason,
      policyApplied,
      'blocked',
      false,
      { blockedReason: 'CONFIDENTIAL_INSPECT_DISABLED' }
    );
    throw new AdminContentError(
      403,
      'CONFIDENTIAL_INSPECT_DISABLED',
      '機密区分のファイルは管理者検査ポリシーによりブロックされました'
    );
  }

  const watermarkRequired = file.classification === 'confidential';
  const delivered = await deliverFileContent({
    env,
    user: actor,
    fileId,
    intent: 'preview',
    versionId: null,
    forceWatermark: watermarkRequired,
    canDownload: false,
  });
  if (!delivered.ok) {
    throw new AdminContentError(
      delivered.status,
      'FILE_CONTENT_NOT_FOUND',
      delivered.body.error
    );
  }

  await recordInspectAudit(
    env.DB,
    actor,
    file,
    reason,
    policyApplied,
    'allowed',
    delivered.body.requireWatermark
  );

  return {
    ok: true,
    fileId,
    fileName: file.name,
    classification: file.classification,
    policyApplied,
    watermarkRequired: delivered.body.requireWatermark,
    url: delivered.body.url,
    expiresAt: delivered.body.expiresAt,
    disposition: delivered.body.disposition,
    watermarkText: delivered.body.watermarkText,
    ...(delivered.body.versionId
      ? {
          versionId: delivered.body.versionId,
          versionNum: delivered.body.versionNum,
        }
      : {}),
  };
}
