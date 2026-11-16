import type { AuthUser, ClassificationLabel } from '../../types/api';
import { can, type Capability } from '../capabilities';
import {
  resolveTargetAccess,
  resolveUserAccessForFolders,
  type TargetMetadata,
} from '../authorization';

export const MAX_FOLDER_DEPTH = 20;
export const INLINE_CLASSIFICATION_PROPAGATION_LIMIT = 100;

export class FolderServiceError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string,
    public readonly latest?: FolderRow,
    /** Restore-destination / rename recovery context for the JSON error body. */
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'FolderServiceError';
  }
}

export interface FolderRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  name: string;
  depth: number;
  version: number;
  classification: ClassificationLabel;
  is_pinned: number;
  created_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BreadcrumbItem {
  id: string;
  name: string;
  classification: ClassificationLabel;
  depth: number;
  version: number;
  /** `full` when a grant applies to this crumb, `path` for traversal-only ancestors. */
  accessMode?: 'full' | 'path' | null;
  effectiveRole?: string | null;
  capabilities?: Capability[];
}

export interface ClassificationStatsBucket {
  classification: ClassificationLabel;
  cnt: number;
  bytes: number;
}

export function validateFolderName(rawName: unknown): string {
  if (typeof rawName !== 'string') {
    throw new FolderServiceError(400, 'INVALID_NAME', 'Folder name must be a string');
  }
  const name = rawName.trim();
  if (!name || name.length > 255) {
    throw new FolderServiceError(400, 'INVALID_NAME', 'Folder name must be 1-255 characters');
  }
  if (name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new FolderServiceError(400, 'INVALID_NAME', 'Folder name contains invalid characters');
  }
  return name;
}

export async function hasDuplicateFolderName(
  db: D1Database,
  tenantId: string,
  parentId: string | null,
  name: string,
  excludeFolderId?: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id
         FROM folders
        WHERE tenant_id = ?
          AND COALESCE(parent_id, '__ROOT__') = COALESCE(?, '__ROOT__')
          AND name = ?
          AND deleted_at IS NULL
          AND (? IS NULL OR id != ?)
        LIMIT 1`
    )
    .bind(tenantId, parentId, name, excludeFolderId ?? null, excludeFolderId ?? null)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function resolveUniqueRestoredName(
  db: D1Database,
  tenantId: string,
  parentId: string | null,
  baseName: string
): Promise<string> {
  const firstCandidate = `${baseName} (Restored)`;
  if (!(await hasDuplicateFolderName(db, tenantId, parentId, firstCandidate))) {
    return firstCandidate;
  }
  for (let suffix = 2; suffix <= 50; suffix++) {
    const candidate = `${baseName} (Restored ${suffix})`;
    if (!(await hasDuplicateFolderName(db, tenantId, parentId, candidate))) {
      return candidate;
    }
  }
  return `${baseName} (Restored ${crypto.randomUUID().slice(0, 6)})`;
}

export async function fetchFolderBreadcrumbsRows(
  db: D1Database,
  tenantId: string,
  folderId: string
): Promise<BreadcrumbItem[]> {
  const rows = await db
    .prepare(
      `SELECT f.id, f.name, f.classification, f.depth, f.version
         FROM folder_closures fc
         JOIN folders f ON f.id = fc.ancestor_id
        WHERE fc.tenant_id = ?
          AND fc.descendant_id = ?
          AND f.deleted_at IS NULL
        ORDER BY fc.depth DESC`
    )
    .bind(tenantId, folderId)
    .all<BreadcrumbItem>();

  return rows.results;
}

export interface FolderBreadcrumbsResult {
  breadcrumbs: BreadcrumbItem[];
  access: TargetMetadata;
}

/**
 * Resolve breadcrumbs together with the composed access used for the
 * `folder.traverse` check, so the endpoint can return `effectiveRole`,
 * `capabilities` and per-crumb `accessMode` consistently with roots/children.
 */
export async function resolveFolderBreadcrumbs(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId'>,
  folderId: string
): Promise<FolderBreadcrumbsResult> {
  const access = await resolveTargetAccess(db, user, 'folder', folderId);
  if (!access || access.deletedAt !== null) {
    throw new FolderServiceError(404, 'NOT_FOUND', 'Folder not found');
  }
  // Path-only ancestors must be able to render breadcrumbs to reach deep targets.
  if (!can(access.capabilities, 'folder.traverse')) {
    throw new FolderServiceError(403, 'FORBIDDEN', 'Forbidden');
  }

  const rows = await fetchFolderBreadcrumbsRows(db, user.tenantId, folderId);
  const crumbAccess = await resolveUserAccessForFolders(
    db,
    user.tenantId,
    user.id,
    rows.map((row) => row.id)
  );
  const breadcrumbs = rows.map((row): BreadcrumbItem => {
    const resolved = crumbAccess.get(row.id);
    if (resolved?.effectiveRole) {
      return {
        ...row,
        accessMode: 'full',
        effectiveRole: resolved.effectiveRole,
        capabilities: resolved.capabilities,
      };
    }
    // Every non-granted ancestor in an authorized breadcrumb chain only exists
    // as a traversal path toward the authorized target.
    return {
      ...row,
      accessMode: 'path',
      effectiveRole: null,
      capabilities: ['folder.traverse'],
    };
  });

  return { breadcrumbs, access };
}

export async function getFolderBreadcrumbs(
  db: D1Database,
  user: Pick<AuthUser, 'id' | 'tenantId'>,
  folderId: string
): Promise<BreadcrumbItem[]> {
  return (await resolveFolderBreadcrumbs(db, user, folderId)).breadcrumbs;
}

