import { Hono } from 'hono';
import { sessionAuthMiddleware } from '../middleware/session-auth';
import { buildAuditLogStmt } from '../services/audit';
import { getAuthenticatedUser, requireMemberUser } from '../services/authorization';
import { generateRandomToken, sha256Hex } from '../services/crypto-utils';
import type { OidcHonoEnv } from '../types/oidc';

export const API_TOKEN_SCOPES = [
  'files:read',
  'files:write',
  'folders:read',
  'folders:write',
  'search:read',
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

const API_TOKEN_SCOPE_SET = new Set<string>(API_TOKEN_SCOPES);
const MAX_TOKEN_NAME_LENGTH = 120;
const MAX_EXPIRES_IN_DAYS = 3650;

interface ApiTokenDbRow {
  id: string;
  name: string;
  token_prefix: string;
  scopes_json: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

function parseScopesJson(raw: string): ApiTokenScope[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const unique = new Set<ApiTokenScope>();
    for (const item of parsed) {
      if (typeof item === 'string' && API_TOKEN_SCOPE_SET.has(item)) {
        unique.add(item as ApiTokenScope);
      }
    }
    return [...unique];
  } catch {
    return [];
  }
}

function projectApiToken(row: ApiTokenDbRow, nowIso: string) {
  const isRevoked = Boolean(row.revoked_at);
  const isExpired = Boolean(row.expires_at && row.expires_at <= nowIso);
  const status: 'active' | 'revoked' | 'expired' = isRevoked
    ? 'revoked'
    : isExpired
      ? 'expired'
      : 'active';

  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: parseScopesJson(row.scopes_json),
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    status,
  };
}

export const apiTokensRoutes = new Hono<OidcHonoEnv>();
apiTokensRoutes.use('*', sessionAuthMiddleware({ required: true }), requireMemberUser);

/** GET /api/api-tokens — lists caller's tokens (never exposes hash or plaintext). */
apiTokensRoutes.get('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const nowIso = new Date().toISOString();

  const rows = await c.env.DB.prepare(
    `SELECT id, name, token_prefix, scopes_json, expires_at, last_used_at, revoked_at, created_at
       FROM api_tokens
      WHERE tenant_id = ? AND user_id = ?
      ORDER BY created_at DESC, rowid DESC`
  )
    .bind(user.tenantId, user.id)
    .all<ApiTokenDbRow>();

  return c.json({
    tokens: rows.results.map((row) => projectApiToken(row, nowIso)),
    supportedScopes: API_TOKEN_SCOPES,
  });
});

/** POST /api/api-tokens — creates a scoped API token and returns plaintext once. */
apiTokensRoutes.post('/', async (c) => {
  const user = getAuthenticatedUser(c);
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    scopes?: unknown;
    expiresInDays?: unknown;
  } | null;

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'JSON body required', code: 'INVALID_BODY' }, 400);
  }

  if (typeof body.name !== 'string') {
    return c.json(
      { error: 'name must be a non-empty string', code: 'INVALID_TOKEN_NAME' },
      400
    );
  }
  const name = body.name.trim();
  if (!name || name.length > MAX_TOKEN_NAME_LENGTH) {
    return c.json(
      {
        error: `name must be 1..${MAX_TOKEN_NAME_LENGTH} characters`,
        code: 'INVALID_TOKEN_NAME',
      },
      400
    );
  }

  if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
    return c.json(
      {
        error: 'scopes must be a non-empty array of valid API token scopes',
        code: 'INVALID_TOKEN_SCOPES',
      },
      400
    );
  }
  const uniqueScopes = new Set<ApiTokenScope>();
  for (const s of body.scopes) {
    if (typeof s !== 'string' || !API_TOKEN_SCOPE_SET.has(s)) {
      return c.json(
        { error: `Unsupported scope: ${String(s)}`, code: 'INVALID_TOKEN_SCOPES' },
        400
      );
    }
    uniqueScopes.add(s as ApiTokenScope);
  }
  const scopes = [...uniqueScopes];

  let expiresAt: string | null = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
    if (
      typeof body.expiresInDays !== 'number' ||
      !Number.isInteger(body.expiresInDays) ||
      body.expiresInDays < 1 ||
      body.expiresInDays > MAX_EXPIRES_IN_DAYS
    ) {
      return c.json(
        {
          error: `expiresInDays must be an integer between 1 and ${MAX_EXPIRES_IN_DAYS}`,
          code: 'INVALID_EXPIRES_IN_DAYS',
        },
        400
      );
    }
    expiresAt = new Date(
      Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000
    ).toISOString();
  }

  const rawToken = `fls_${generateRandomToken(32)}`;
  const tokenPrefix = rawToken.slice(0, 12);
  const tokenHash = await sha256Hex(rawToken);
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO api_tokens
         (id, tenant_id, user_id, name, token_prefix, token_hash, scopes_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      user.tenantId,
      user.id,
      name,
      tokenPrefix,
      tokenHash,
      JSON.stringify(scopes),
      expiresAt,
      nowIso
    ),
    buildAuditLogStmt(c.env.DB, {
      tenantId: user.tenantId,
      actorId: user.id,
      actorEmail: user.email,
      actorIp: user.ipAddress,
      action: 'api_token.created',
      targetType: 'api_token',
      targetId: id,
      metadata: { name, tokenPrefix, scopes, expiresAt },
    }),
  ]);

  return c.json(
    {
      ok: true,
      token: rawToken,
      apiToken: {
        id,
        name,
        tokenPrefix,
        scopes,
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        createdAt: nowIso,
        status: 'active' as const,
      },
    },
    201
  );
});

/** DELETE /api/api-tokens/:id — revokes the caller's API token. */
apiTokensRoutes.delete('/:id', async (c) => {
  const user = getAuthenticatedUser(c);
  const tokenId = c.req.param('id');

  const existing = await c.env.DB.prepare(
    `SELECT id, name, token_prefix, revoked_at
       FROM api_tokens
      WHERE id = ? AND tenant_id = ? AND user_id = ?`
  )
    .bind(tokenId, user.tenantId, user.id)
    .first<{
      id: string;
      name: string;
      token_prefix: string;
      revoked_at: string | null;
    }>();

  if (!existing) {
    return c.json(
      { error: 'API token not found', code: 'API_TOKEN_NOT_FOUND' },
      404
    );
  }

  const revokedAt = existing.revoked_at ?? new Date().toISOString();
  if (!existing.revoked_at) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND user_id = ?`
      ).bind(revokedAt, tokenId, user.tenantId, user.id),
      buildAuditLogStmt(c.env.DB, {
        tenantId: user.tenantId,
        actorId: user.id,
        actorEmail: user.email,
        actorIp: user.ipAddress,
        action: 'api_token.revoked',
        targetType: 'api_token',
        targetId: tokenId,
        metadata: { name: existing.name, tokenPrefix: existing.token_prefix },
      }),
    ]);
  }

  return c.json({ ok: true, id: tokenId, revokedAt });
});
