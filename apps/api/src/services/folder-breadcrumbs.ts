import { chunkArray } from '../utils/batch';

export interface FolderBreadcrumb {
  id: string;
  name: string;
}

interface BreadcrumbRow {
  folder_id: string;
  id: string;
  name: string;
  depth: number;
}

const DEFAULT_BREADCRUMB_CHUNK = 30;

/**
 * Batch-resolve ancestor paths for multiple folders in bounded chunks. Rows are
 * ordered root -> leaf, so callers can render a breadcrumb directly.
 */
export async function loadFolderBreadcrumbMap(
  db: D1Database,
  tenantId: string,
  folderIds: readonly string[],
  chunkSize = DEFAULT_BREADCRUMB_CHUNK
): Promise<Map<string, FolderBreadcrumb[]>> {
  const map = new Map<string, FolderBreadcrumb[]>();
  const unique = [...new Set(folderIds.filter(Boolean))];
  for (const chunk of chunkArray(unique, chunkSize)) {
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

export function folderPathLabel(
  breadcrumbs: ReadonlyArray<{ name: string }>
): string {
  if (breadcrumbs.length === 0) return 'マイファイル (ルート)';
  return ['マイファイル', ...breadcrumbs.map((crumb) => crumb.name)].join(' / ');
}
