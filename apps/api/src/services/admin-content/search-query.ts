import type { ClassificationLabel } from '../../types/api';
import { VALID_CLASSIFICATIONS } from '../../utils/classification';
import {
  ADMIN_CONTENT_DEFAULT_LIMIT,
  ADMIN_CONTENT_MAX_LIMIT,
  AdminContentError,
  decodeAdminContentCursor,
  escapeLikePrefix,
  type AdminContentCursor,
  type AdminContentSearchTargetType,
} from './shared';

export function folderPrefixFromQuery(rawQuery: string): string | null {
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
