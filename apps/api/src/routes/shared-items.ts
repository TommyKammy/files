import { Hono } from 'hono';
import {
  FILE_PREVIEW_ROLE_SQL,
  getAuthenticatedUser,
  GRANTEE_MATCH_SQL,
  resolveTargetAccess,
} from '../services/authorization';
import { parseRoleList } from '../services/capabilities';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import type { ClassificationLabel } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';

interface SharedFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  classification: ClassificationLabel;
  updated_at: string;
  created_by: string;
  role_list: string | null;
  granted_at: string;
}

interface SharedFileRow {
  id: string;
  folder_id: string | null;
  name: string;
  extension: string | null;
  mime_type: string | null;
  size_bytes: number;
  classification: ClassificationLabel;
  updated_at: string;
  created_by: string;
  role_list: string | null;
  granted_at: string;
}

interface BreadcrumbRow {
  folder_id: string;
  id: string;
  name: string;
  depth: number;
}

export interface SharedItemEntry {
  itemType: 'folder' | 'file';
  id: string;
  name: string;
  classification: ClassificationLabel;
  folderId: string | null;
  parentId: string | null;
  updatedAt: string;
  extension: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  effectiveRole: string | null;
  capabilities: string[];
  directRoles: string[];
  breadcrumbs: Array<{ id: string; name: string }>;
  pathLabel: string;
  createdBy: string;
  grantedAt: string;
}

const BREADCRUMB_CHUNK = 30;
const MAX_SHARED_ITEMS = 200;

async function loadBreadcrumbMap(
  db: D1Database,
  tenantId: string,
  folderIds: readonly string[]
): Promise<Map<string, Array<{ id: string; name: string }>>> {
  const map = new Map<string, Array<{ id: string; name: string }>>();
  const unique = [...new Set(folderIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += BREADCRUMB_CHUNK) {
    const chunk = unique.slice(i, i + BREADCRUMB_CHUNK);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT fc.descendant_id AS folder_id,
                f.id,
                f.name,
                fc.depth
           FROM folder_closures fc
           JOIN folders f
             ON f.tenant_id = fc.tenant_id
            AND f.id = fc.ancestor_id
            AND f.deleted_at IS NULL
          WHERE fc.tenant_id = ?
            AND fc.descendant_id IN (${placeholders})
          ORDER BY fc.descendant_id ASC, fc.depth DESC`
      )
      .bind(tenantId, ...chunk)
      .all<BreadcrumbRow>();
    for (const row of rows.results) {
      const list = map.get(row.folder_id) ?? [];
      list.push({ id: row.id, name: row.name });
      map.set(row.folder_id, list);
    }
  }
  return map;
}

function pathLabelFor(breadcrumbs: Array<{ id: string; name: string }>): string {
  if (breadcrumbs.length === 0) return 'マイファイル (ルート)';
  return ['マイファイル', ...breadcrumbs.map((crumb) => crumb.name)].join(' / ');
}

export const sharedItemsRoutes = new Hono<OidcHonoEnv>();

sharedItemsRoutes.use('*', sessionAuthMiddleware({ required: true }));

/**
 * GET /api/shared-items — items directly granted to the current user or one of
 * their groups, including root-level loose shared files. Inherited-only items
 * are intentionally excluded: this view answers "what was shared with me?".
 */
sharedItemsRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawLimit = Number.parseInt(c.req.query('limit') ?? String(MAX_SHARED_ITEMS), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_SHARED_ITEMS)
    : MAX_SHARED_ITEMS;

  const [folderRows, fileRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT f.id,
              f.parent_id,
              f.name,
              f.classification,
              f.updated_at,
              f.created_by,
              GROUP_CONCAT(DISTINCT p.role) AS role_list,
              MIN(p.created_at) AS granted_at
         FROM permissions p
         JOIN folders f
           ON f.tenant_id = p.tenant_id
          AND f.id = p.target_id
          AND f.deleted_at IS NULL
        WHERE p.tenant_id = ?
          AND p.target_type = 'folder'
          AND ${GRANTEE_MATCH_SQL}
        GROUP BY f.id`
    )
      .bind(user.tenantId, user.id, user.id)
      .all<SharedFolderRow>(),
    c.env.DB.prepare(
      `SELECT fl.id,
              fl.folder_id,
              fl.name,
              fl.extension,
              fl.mime_type,
              fl.size_bytes,
              fl.classification,
              fl.updated_at,
              fl.created_by,
              GROUP_CONCAT(DISTINCT p.role) AS role_list,
              MIN(p.created_at) AS granted_at
         FROM permissions p
         JOIN files fl
           ON fl.tenant_id = p.tenant_id
          AND fl.id = p.target_id
          AND fl.deleted_at IS NULL
          AND fl.upload_state = 'active'
        WHERE p.tenant_id = ?
          AND p.target_type = 'file'
          -- uploader/preview-less direct file grants must never surface.
          AND p.role IN (${FILE_PREVIEW_ROLE_SQL})
          AND ${GRANTEE_MATCH_SQL}
        GROUP BY fl.id`
    )
      .bind(user.tenantId, user.id, user.id)
      .all<SharedFileRow>(),
  ]);

  const folderIds = [
    ...folderRows.results.map((row) => row.id),
    ...fileRows.results
      .map((row) => row.folder_id)
      .filter((id): id is string => Boolean(id)),
  ];
  const breadcrumbMap = await loadBreadcrumbMap(c.env.DB, user.tenantId, folderIds);

  const items: SharedItemEntry[] = [];
  for (const row of folderRows.results) {
    const access = await resolveTargetAccess(c.env.DB, user, 'folder', row.id);
    if (!access || access.accessMode !== 'full') continue;
    const breadcrumbs = breadcrumbMap.get(row.id) ?? [];
    items.push({
      itemType: 'folder',
      id: row.id,
      name: row.name,
      classification: row.classification,
      folderId: null,
      parentId: row.parent_id,
      updatedAt: row.updated_at,
      extension: null,
      mimeType: null,
      sizeBytes: null,
      effectiveRole: access.effectiveRole,
      capabilities: access.capabilities,
      directRoles: parseRoleList(row.role_list),
      breadcrumbs,
      pathLabel: pathLabelFor(breadcrumbs),
      createdBy: row.created_by,
      grantedAt: row.granted_at,
    });
  }

  for (const row of fileRows.results) {
    const access = await resolveTargetAccess(c.env.DB, user, 'file', row.id);
    if (!access || access.accessMode !== 'full') continue;
    const breadcrumbs = row.folder_id
      ? breadcrumbMap.get(row.folder_id) ?? []
      : [];
    items.push({
      itemType: 'file',
      id: row.id,
      name: row.name,
      classification: row.classification,
      folderId: row.folder_id,
      parentId: null,
      updatedAt: row.updated_at,
      extension: row.extension,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      effectiveRole: access.effectiveRole,
      capabilities: access.capabilities,
      directRoles: parseRoleList(row.role_list),
      breadcrumbs,
      pathLabel: pathLabelFor(breadcrumbs),
      createdBy: row.created_by,
      grantedAt: row.granted_at,
    });
  }

  items.sort((a, b) => {
    const byUpdated = b.updatedAt.localeCompare(a.updatedAt);
    return byUpdated !== 0 ? byUpdated : a.id.localeCompare(b.id);
  });

  return c.json({ items: items.slice(0, limit) });
});
