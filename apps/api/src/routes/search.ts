import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { getAuthenticatedUser, FILE_PREVIEW_ROLE_SQL } from '../services/authorization';
import type { ClassificationLabel } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import { VALID_CLASSIFICATIONS } from '../utils/classification';

const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 100;

export type SearchTargetType = 'all' | 'file' | 'folder';

interface ParsedSearchQuery {
  classificationFilter: ClassificationLabel | null;
  ftsTerms: string[];
}

interface SearchFileRow {
  id: string;
  folder_id: string | null;
  folder_name: string | null;
  name: string;
  extension: string | null;
  mime_type: string;
  size_bytes: number;
  classification: ClassificationLabel;
  ai_suggested_label: ClassificationLabel | null;
  ai_confidence: number | null;
  updated_at: string;
}

interface SearchFolderRow {
  id: string;
  parent_id: string | null;
  parent_name: string | null;
  name: string;
  depth: number;
  classification: ClassificationLabel;
  updated_at: string;
}

/**
 * Parse `is:<classification>` qualifiers and sanitize free-text terms into
 * safe quoted FTS5 prefix tokens so operators (`OR`, `NOT`, `*`, `:`) cannot inject.
 */
export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  let classificationFilter: ClassificationLabel | null = null;
  const ftsTerms: string[] = [];

  for (const rawPart of rawQuery.trim().split(/\s+/)) {
    if (!rawPart) continue;
    const isMatch = rawPart.match(/^is:(confidential|unset|internal|public)$/i);
    if (isMatch) {
      const label = isMatch[1].toLowerCase() as ClassificationLabel;
      if (VALID_CLASSIFICATIONS.has(label)) {
        classificationFilter = label;
      }
      continue;
    }

    // Split by non-letter/number/underscore characters matching unicode61 word boundaries
    const cleanedTokens = rawPart.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    for (const token of cleanedTokens) {
      if (token.length <= 64) {
        ftsTerms.push(token);
      }
    }
  }

  return {
    classificationFilter,
    ftsTerms: [...new Set(ftsTerms)].slice(0, 8),
  };
}

export function buildSafeFtsMatchExpression(parsed: ParsedSearchQuery): string | null {
  const clauses: string[] = [];
  if (parsed.classificationFilter) {
    clauses.push(`classification : "${parsed.classificationFilter}"`);
  }
  for (const token of parsed.ftsTerms) {
    // Double quotes neutralize FTS5 reserved keywords (`AND`, `OR`, `NOT`, `NEAR`)
    const escaped = token.replace(/"/g, '');
    if (escaped) {
      clauses.push(`"${escaped}"*`);
    }
  }
  return clauses.length > 0 ? clauses.join(' AND ') : null;
}

function escapeSqlLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function parseOptionalDateBound(
  raw: string | undefined,
  bound: 'from' | 'to'
): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? bound === 'from'
      ? `${trimmed}T00:00:00.000Z`
      : `${trimmed}T23:59:59.999Z`
    : trimmed;
  if (Number.isNaN(Date.parse(normalized))) {
    return null;
  }
  return normalized;
}

function parseOptionalNonNegativeInt(raw: string | undefined): number | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseSearchType(raw: string | undefined): SearchTargetType | null {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === 'all' || trimmed === 'file' || trimmed === 'folder') {
    return trimmed;
  }
  return null;
}

const RBAC_FILE_EXISTS_SQL = `EXISTS (
  SELECT 1
    FROM permissions p
   WHERE p.tenant_id = fl.tenant_id
     -- Only roles holding item.preview may surface file hits. Uploader roles
     -- (and any future preview-less role) must not learn file names.
     AND p.role IN (${FILE_PREVIEW_ROLE_SQL})
     AND (
       (p.grantee_type = 'user' AND p.grantee_id = ?)
       OR (
         p.grantee_type = 'group'
         AND EXISTS (
           SELECT 1 FROM group_members gm
            WHERE gm.group_id = p.grantee_id AND gm.user_id = ?
         )
       )
     )
     AND (
       (p.target_type = 'file' AND p.target_id = fl.id)
       OR (
         p.target_type = 'folder'
         AND fl.folder_id IS NOT NULL
         AND p.target_id IN (
           SELECT fc.ancestor_id
             FROM folder_closures fc
            WHERE fc.tenant_id = fl.tenant_id
              AND fc.descendant_id = fl.folder_id
         )
       )
     )
)`;

const RBAC_FOLDER_EXISTS_SQL = `EXISTS (
  SELECT 1
    FROM permissions p
   WHERE p.tenant_id = f.tenant_id
     AND p.target_type = 'folder'
     AND (
       (p.grantee_type = 'user' AND p.grantee_id = ?)
       OR (
         p.grantee_type = 'group'
         AND EXISTS (
           SELECT 1 FROM group_members gm
            WHERE gm.group_id = p.grantee_id AND gm.user_id = ?
         )
       )
     )
     AND p.target_id IN (
       SELECT fc.ancestor_id
         FROM folder_closures fc
        WHERE fc.tenant_id = f.tenant_id
          AND fc.descendant_id = f.id
     )
)`;

export const searchRoutes = new Hono<OidcHonoEnv>();

searchRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** GET /api/search — Workspace FTS5 + folder + RBAC filtered search with pagination */
searchRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawQuery = (c.req.query('q') ?? '').trim();

  const parsedLimit = Number.parseInt(c.req.query('limit') ?? String(DEFAULT_SEARCH_LIMIT), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_SEARCH_LIMIT)
    : DEFAULT_SEARCH_LIMIT;

  const parsedOffset = Number.parseInt(c.req.query('offset') ?? '0', 10);
  const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;

  const explicitType = parseSearchType(c.req.query('type'));
  const searchType: SearchTargetType = explicitType ?? 'all';

  const rawClassification = (c.req.query('classification') ?? '').trim().toLowerCase();
  const explicitClassification = VALID_CLASSIFICATIONS.has(
    rawClassification as ClassificationLabel
  )
    ? (rawClassification as ClassificationLabel)
    : null;

  const rawExtension = (c.req.query('extension') ?? '').trim().replace(/^\.+/, '').toLowerCase();
  const extension = rawExtension || null;

  const folderId = (c.req.query('folderId') ?? '').trim() || null;
  const updatedFrom = parseOptionalDateBound(c.req.query('updatedFrom'), 'from');
  const updatedTo = parseOptionalDateBound(c.req.query('updatedTo'), 'to');
  const minSize = parseOptionalNonNegativeInt(c.req.query('minSize'));
  const maxSize = parseOptionalNonNegativeInt(c.req.query('maxSize'));
  const ownerId = (c.req.query('ownerId') ?? '').trim() || null;
  const tagFilter = (c.req.query('tag') ?? '').trim().toLowerCase() || null;

  const parsed = parseSearchQuery(rawQuery);
  const effectiveClassification = explicitClassification ?? parsed.classificationFilter;

  const hasAnyFilter = Boolean(
    effectiveClassification ||
      extension ||
      folderId ||
      updatedFrom ||
      updatedTo ||
      minSize !== null ||
      maxSize !== null ||
      ownerId ||
      tagFilter ||
      explicitType === 'folder' ||
      explicitType === 'file'
  );

  if (parsed.ftsTerms.length === 0 && !hasAnyFilter) {
    return c.json({
      query: rawQuery,
      limit,
      offset,
      hasMore: false,
      nextOffset: null,
      folders: [],
      results: [],
    });
  }

  let fileRows: SearchFileRow[] = [];
  let filesHasMore = false;

  if (searchType !== 'folder') {
    const fileConditions: string[] = [
      'fl.tenant_id = ?',
      'fl.deleted_at IS NULL',
      "fl.upload_state = 'active'",
      RBAC_FILE_EXISTS_SQL,
    ];
    const fileBindings: unknown[] = [user.tenantId, user.id, user.id];

    let fromSql =
      'FROM files fl LEFT JOIN folders pf ON pf.id = fl.folder_id';

    if (parsed.ftsTerms.length > 0) {
      // Build FTS expression from text terms only; classification is applied on `fl.classification`
      // so explicit `classification` query param and `is:<label>` work uniformly.
      const ftsExpr = buildSafeFtsMatchExpression({
        classificationFilter: null,
        ftsTerms: parsed.ftsTerms,
      });
      if (ftsExpr) {
        fromSql =
          'FROM files_fts fts JOIN files fl ON fl.id = fts.file_id LEFT JOIN folders pf ON pf.id = fl.folder_id';
        fileConditions.unshift('files_fts MATCH ?');
        fileBindings.unshift(ftsExpr);
      }
    }

    if (effectiveClassification) {
      fileConditions.push('fl.classification = ?');
      fileBindings.push(effectiveClassification);
    }
    if (extension) {
      fileConditions.push('LOWER(fl.extension) = ?');
      fileBindings.push(extension);
    }
    if (folderId) {
      fileConditions.push(
        `fl.folder_id IN (
          SELECT fc.descendant_id
            FROM folder_closures fc
           WHERE fc.tenant_id = fl.tenant_id
             AND fc.ancestor_id = ?
        )`
      );
      fileBindings.push(folderId);
    }
    if (updatedFrom) {
      fileConditions.push('fl.updated_at >= ?');
      fileBindings.push(updatedFrom);
    }
    if (updatedTo) {
      fileConditions.push('fl.updated_at <= ?');
      fileBindings.push(updatedTo);
    }
    if (minSize !== null) {
      fileConditions.push('fl.size_bytes >= ?');
      fileBindings.push(minSize);
    }
    if (maxSize !== null) {
      fileConditions.push('fl.size_bytes <= ?');
      fileBindings.push(maxSize);
    }
    if (ownerId) {
      fileConditions.push('fl.created_by = ?');
      fileBindings.push(ownerId);
    }
    if (tagFilter) {
      fileConditions.push(
        `EXISTS (
          SELECT 1
            FROM item_tags it
           WHERE it.tenant_id = fl.tenant_id
             AND it.item_type = 'file'
             AND it.item_id = fl.id
             AND it.tag = ?
        )`
      );
      fileBindings.push(tagFilter);
    }

    const fileSql = `SELECT fl.id, fl.folder_id, pf.name AS folder_name, fl.name, fl.extension,
              fl.mime_type, fl.size_bytes, fl.classification, fl.ai_suggested_label,
              fl.ai_confidence, fl.updated_at
         ${fromSql}
        WHERE ${fileConditions.join('\n          AND ')}
        ORDER BY fl.updated_at DESC, fl.id ASC
        LIMIT ? OFFSET ?`;

    const res = await c.env.DB.prepare(fileSql)
      .bind(...fileBindings, limit + 1, offset)
      .all<SearchFileRow>();

    filesHasMore = res.results.length > limit;
    fileRows = filesHasMore ? res.results.slice(0, limit) : res.results;
  }

  let folderRows: SearchFolderRow[] = [];
  let foldersHasMore = false;

  const hasFileOnlyFilter = Boolean(extension || minSize !== null || maxSize !== null);
  if (searchType !== 'file' && !hasFileOnlyFilter) {
    const folderConditions: string[] = [
      'f.tenant_id = ?',
      'f.deleted_at IS NULL',
      RBAC_FOLDER_EXISTS_SQL,
    ];
    const folderBindings: unknown[] = [user.tenantId, user.id, user.id];

    for (const term of parsed.ftsTerms) {
      folderConditions.push("LOWER(f.name) LIKE ? ESCAPE '\\'");
      folderBindings.push(`%${escapeSqlLike(term.toLowerCase())}%`);
    }
    if (effectiveClassification) {
      folderConditions.push('f.classification = ?');
      folderBindings.push(effectiveClassification);
    }
    if (folderId) {
      folderConditions.push(
        `f.id IN (
          SELECT fc.descendant_id
            FROM folder_closures fc
           WHERE fc.tenant_id = f.tenant_id
             AND fc.ancestor_id = ?
        )`
      );
      folderBindings.push(folderId);
    }
    if (updatedFrom) {
      folderConditions.push('f.updated_at >= ?');
      folderBindings.push(updatedFrom);
    }
    if (updatedTo) {
      folderConditions.push('f.updated_at <= ?');
      folderBindings.push(updatedTo);
    }
    if (ownerId) {
      folderConditions.push('f.created_by = ?');
      folderBindings.push(ownerId);
    }
    if (tagFilter) {
      folderConditions.push(
        `EXISTS (
          SELECT 1
            FROM item_tags it
           WHERE it.tenant_id = f.tenant_id
             AND it.item_type = 'folder'
             AND it.item_id = f.id
             AND it.tag = ?
        )`
      );
      folderBindings.push(tagFilter);
    }

    const folderSql = `SELECT f.id, f.parent_id, pf.name AS parent_name, f.name, f.depth,
              f.classification, f.updated_at
         FROM folders f
         LEFT JOIN folders pf ON pf.id = f.parent_id
        WHERE ${folderConditions.join('\n          AND ')}
        ORDER BY f.updated_at DESC, f.id ASC
        LIMIT ? OFFSET ?`;

    const res = await c.env.DB.prepare(folderSql)
      .bind(...folderBindings, limit + 1, offset)
      .all<SearchFolderRow>();

    foldersHasMore = res.results.length > limit;
    folderRows = foldersHasMore ? res.results.slice(0, limit) : res.results;
  }

  const hasMore = filesHasMore || foldersHasMore;
  const nextOffset = hasMore ? offset + limit : null;

  return c.json({
    query: rawQuery,
    limit,
    offset,
    hasMore,
    nextOffset,
    folders: folderRows.map((r) => ({
      id: r.id,
      parentId: r.parent_id,
      parentName: r.parent_name,
      name: r.name,
      depth: r.depth,
      classification: r.classification,
      updatedAt: r.updated_at,
    })),
    // Never expose unauthorized match counts or file metadata outside permitted scope
    results: fileRows.map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      folderName: r.folder_name,
      name: r.name,
      extension: r.extension,
      mimeType: r.mime_type,
      sizeBytes: r.size_bytes,
      classification: r.classification,
      aiSuggestedLabel: r.ai_suggested_label,
      aiConfidence: r.ai_confidence,
      updatedAt: r.updated_at,
    })),
  });
});
