import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { getAuthenticatedUser } from '../services/authorization';
import type { ClassificationLabel } from '../types/api';
import type { OidcHonoEnv } from '../types/oidc';
import { VALID_CLASSIFICATIONS } from '../utils/classification';

const DEFAULT_SEARCH_LIMIT = 20;

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

const RBAC_FILE_EXISTS_SQL = `EXISTS (
  SELECT 1
    FROM permissions p
   WHERE p.tenant_id = fl.tenant_id
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

export const searchRoutes = new Hono<OidcHonoEnv>();

searchRoutes.use('*', sessionAuthMiddleware({ required: true }));

/** GET /api/search?q=... — ⌘K command-palette FTS5 + RBAC filtered search (LIMIT 20) */
searchRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const rawQuery = (c.req.query('q') ?? '').trim();
  const parsedLimit = Number.parseInt(c.req.query('limit') ?? String(DEFAULT_SEARCH_LIMIT), 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), DEFAULT_SEARCH_LIMIT)
    : DEFAULT_SEARCH_LIMIT;

  if (!rawQuery) {
    return c.json({ query: '', limit, results: [] });
  }

  const parsed = parseSearchQuery(rawQuery);
  if (!parsed.classificationFilter && parsed.ftsTerms.length === 0) {
    return c.json({ query: rawQuery, limit, results: [] });
  }

  let rows: SearchFileRow[];

  if (parsed.ftsTerms.length === 0 && parsed.classificationFilter) {
    // Classification-only filter hits covering index idx_files_classification directly
    const res = await c.env.DB.prepare(
      `SELECT fl.id, fl.folder_id, pf.name AS folder_name, fl.name, fl.extension,
              fl.mime_type, fl.size_bytes, fl.classification, fl.ai_suggested_label,
              fl.ai_confidence, fl.updated_at
         FROM files fl
         LEFT JOIN folders pf ON pf.id = fl.folder_id
        WHERE fl.tenant_id = ?
          AND fl.classification = ?
          AND fl.deleted_at IS NULL
          AND fl.upload_state = 'active'
          AND ${RBAC_FILE_EXISTS_SQL}
        ORDER BY fl.updated_at DESC
        LIMIT ?`
    )
      .bind(user.tenantId, parsed.classificationFilter, user.id, user.id, limit)
      .all<SearchFileRow>();
    rows = res.results;
  } else {
    const ftsExpr = buildSafeFtsMatchExpression(parsed);
    if (!ftsExpr) {
      return c.json({ query: rawQuery, limit, results: [] });
    }

    const res = await c.env.DB.prepare(
      `SELECT fl.id, fl.folder_id, pf.name AS folder_name, fl.name, fl.extension,
              fl.mime_type, fl.size_bytes, fl.classification, fl.ai_suggested_label,
              fl.ai_confidence, fl.updated_at
         FROM files_fts fts
         JOIN files fl ON fl.id = fts.file_id
         LEFT JOIN folders pf ON pf.id = fl.folder_id
        WHERE files_fts MATCH ?
          AND fl.tenant_id = ?
          AND fl.upload_state = 'active'
          AND fl.deleted_at IS NULL
          AND ${RBAC_FILE_EXISTS_SQL}
        LIMIT ?`
    )
      .bind(ftsExpr, user.tenantId, user.id, user.id, limit)
      .all<SearchFileRow>();
    rows = res.results;
  }

  return c.json({
    query: rawQuery,
    limit,
    // Never expose unauthorized match counts or file metadata outside permitted scope
    results: rows.map((r) => ({
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
