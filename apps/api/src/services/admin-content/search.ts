import type { FileLockSnapshot } from '../../durable-objects/file-lock-hub';
import {
  buildSafeFtsMatchExpression,
  parseSearchQuery,
} from '../../routes/search';
import type { ClassificationLabel } from '../../types/api';
import type { OidcEnv } from '../../types/oidc';
import { chunkArray, executeBatchChunks } from '../../utils/batch';
import {
  buildActiveFileLockDeleteStmt,
  buildActiveFileLockUpsertStmt,
} from '../active-file-lock-index';
import { getFileLockState } from '../file-lock';
import {
  folderPathLabel,
  loadFolderBreadcrumbMap,
  type FolderBreadcrumb,
} from '../folder-breadcrumbs';
import {
  buildAdminContentSearchQuery,
  folderPrefixFromQuery,
  type AdminContentSearchFilters,
} from './search-query';
import {
  encodeAdminContentCursor,
  type AdminContentOwner,
  type AdminContentTargetType,
} from './shared';

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
