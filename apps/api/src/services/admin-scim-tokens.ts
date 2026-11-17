import type { AuthUser } from '../types/api';
import { buildAuditLogStmt } from './audit';
import { generateRandomToken, sha256Hex } from './crypto-utils';

/**
 * P11-3 / TOM-69 tenant-admin SCIM bearer token management.
 *
 * The plaintext token is returned exactly once from `create`/`rotate`; D1 only
 * ever receives its SHA-256 hash, and audit metadata deliberately excludes both
 * the plaintext and the hash.
 */

export type AdminScimTokenStatus = 'active' | 'revoked';

export interface AdminScimTokenRow {
  id: string;
  name: string;
  idpIssuer: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: AdminScimTokenStatus;
}

export interface AdminScimTokenListResult {
  tokens: AdminScimTokenRow[];
  total: number;
  activeCount: number;
  revokedCount: number;
  endpoint: '/scim/v2';
}

export interface AdminScimTokenMutationResult {
  ok: true;
  token?: string;
  scimToken: AdminScimTokenRow;
  revokedTokenId?: string;
  alreadyRevoked?: boolean;
  notice: string;
}

export class AdminScimTokenError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'AdminScimTokenError';
  }
}

interface RawScimTokenRow {
  id: string;
  name: string;
  idp_issuer: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const MAX_TOKEN_NAME_LENGTH = 120;
const MAX_IDP_ISSUER_LENGTH = 320;

function toTokenRow(row: RawScimTokenRow): AdminScimTokenRow {
  return {
    id: row.id,
    name: row.name,
    idpIssuer: row.idp_issuer,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    status: row.revoked_at ? 'revoked' : 'active',
  };
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AdminScimTokenError(
      400,
      'INVALID_SCIM_TOKEN_NAME',
      'name must be a non-empty string'
    );
  }
  const name = raw.trim();
  if (!name) {
    throw new AdminScimTokenError(
      400,
      'INVALID_SCIM_TOKEN_NAME',
      'name must be a non-empty string'
    );
  }
  if (name.length > MAX_TOKEN_NAME_LENGTH) {
    throw new AdminScimTokenError(
      400,
      'INVALID_SCIM_TOKEN_NAME',
      `name must be at most ${MAX_TOKEN_NAME_LENGTH} characters`
    );
  }
  return name;
}

function normalizeIdpIssuer(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AdminScimTokenError(
      400,
      'INVALID_IDP_ISSUER',
      'idpIssuer must be a non-empty string'
    );
  }
  const issuer = raw.trim();
  if (!issuer) {
    throw new AdminScimTokenError(
      400,
      'INVALID_IDP_ISSUER',
      'idpIssuer must be a non-empty string'
    );
  }
  if (issuer.length > MAX_IDP_ISSUER_LENGTH) {
    throw new AdminScimTokenError(
      400,
      'INVALID_IDP_ISSUER',
      `idpIssuer must be at most ${MAX_IDP_ISSUER_LENGTH} characters`
    );
  }
  return issuer;
}

async function loadToken(
  db: D1Database,
  tenantId: string,
  tokenId: string
): Promise<RawScimTokenRow | null> {
  return db
    .prepare(
      `SELECT id, name, idp_issuer, last_used_at, revoked_at, created_at
         FROM scim_tokens
        WHERE tenant_id = ? AND id = ?`
    )
    .bind(tenantId, tokenId)
    .first<RawScimTokenRow>();
}

async function requireToken(
  db: D1Database,
  tenantId: string,
  tokenId: string
): Promise<RawScimTokenRow> {
  const row = await loadToken(db, tenantId, tokenId);
  if (!row) {
    throw new AdminScimTokenError(
      404,
      'SCIM_TOKEN_NOT_FOUND',
      'SCIM token not found'
    );
  }
  return row;
}

function buildAuditStmt(
  db: D1Database,
  input: {
    tenantId: string;
    actor: AuthUser;
    action: string;
    tokenId: string;
    metadata: Record<string, unknown>;
    nowIso: string;
  }
): D1PreparedStatement {
  return buildAuditLogStmt(db, {
    tenantId: input.tenantId,
    actorId: input.actor.id,
    actorEmail: input.actor.email,
    actorIp: input.actor.ipAddress,
    action: input.action,
    targetType: 'scim_token',
    targetId: input.tokenId,
    metadata: input.metadata,
    nowIso: input.nowIso,
  });
}

export async function listAdminScimTokens(
  db: D1Database,
  tenantId: string
): Promise<AdminScimTokenListResult> {
  const rows = await db
    .prepare(
      `SELECT id, name, idp_issuer, last_used_at, revoked_at, created_at
         FROM scim_tokens
        WHERE tenant_id = ?
        ORDER BY created_at DESC, id DESC`
    )
    .bind(tenantId)
    .all<RawScimTokenRow>();

  const tokens = rows.results.map(toTokenRow);
  return {
    tokens,
    total: tokens.length,
    activeCount: tokens.filter((token) => token.status === 'active').length,
    revokedCount: tokens.filter((token) => token.status === 'revoked').length,
    endpoint: '/scim/v2',
  };
}

function newPlaintextToken(): string {
  return `scim_${generateRandomToken(32)}`;
}

export async function createAdminScimToken(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  name: unknown;
  idpIssuer: unknown;
}): Promise<AdminScimTokenMutationResult> {
  const { db, tenantId, actor } = input;
  const name = normalizeName(input.name);
  const idpIssuer = normalizeIdpIssuer(input.idpIssuer);

  const tokenId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const plaintext = newPlaintextToken();
  const tokenHash = await sha256Hex(plaintext);

  await db.batch([
    db
      .prepare(
        `INSERT INTO scim_tokens (
           id, tenant_id, idp_issuer, name, token_hash, last_used_at,
           revoked_at, created_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`
      )
      .bind(tokenId, tenantId, idpIssuer, name, tokenHash, nowIso),
    buildAuditStmt(db, {
      tenantId,
      actor,
      action: 'admin.scim_token.create',
      tokenId,
      metadata: { scimTokenId: tokenId, name, idpIssuer },
      nowIso,
    }),
  ]);

  const row = await requireToken(db, tenantId, tokenId);
  return {
    ok: true,
    token: plaintext,
    scimToken: toTokenRow(row),
    notice:
      'SCIM トークンを発行しました。平文トークンはこの画面でのみ表示されます。',
  };
}

export async function rotateAdminScimToken(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  tokenId: string;
}): Promise<AdminScimTokenMutationResult> {
  const { db, tenantId, actor, tokenId } = input;
  const existing = await requireToken(db, tenantId, tokenId);
  if (existing.revoked_at) {
    throw new AdminScimTokenError(
      409,
      'TOKEN_ALREADY_REVOKED',
      'Revoked SCIM tokens cannot be rotated'
    );
  }

  const newTokenId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const plaintext = newPlaintextToken();
  const tokenHash = await sha256Hex(plaintext);
  const oldTokenRevokedGuard = {
    sql: 'EXISTS (SELECT 1 FROM scim_tokens WHERE id = ? AND tenant_id = ? AND revoked_at = ?)',
    bindings: [tokenId, tenantId, nowIso],
  } as const;

  const results = await db.batch([
    db
      .prepare(
        `UPDATE scim_tokens
            SET revoked_at = ?
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`
      )
      .bind(nowIso, tenantId, tokenId),
    db
      .prepare(
        `INSERT INTO scim_tokens (
           id, tenant_id, idp_issuer, name, token_hash, last_used_at,
           revoked_at, created_at
         )
         SELECT ?, ?, ?, ?, ?, NULL, NULL, ?
          WHERE ${oldTokenRevokedGuard.sql}`
      )
      .bind(
        newTokenId,
        tenantId,
        existing.idp_issuer,
        existing.name,
        tokenHash,
        nowIso,
        ...oldTokenRevokedGuard.bindings
      ),
    buildAuditLogStmt(
      db,
      {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.scim_token.rotate',
        targetType: 'scim_token',
        targetId: tokenId,
        metadata: {
          scimTokenId: newTokenId,
          revokedTokenId: tokenId,
          name: existing.name,
          idpIssuer: existing.idp_issuer,
        },
        nowIso,
      },
      oldTokenRevokedGuard
    ),
  ]);

  if ((results[1]?.meta.changes ?? 0) === 0) {
    throw new AdminScimTokenError(
      409,
      'TOKEN_ALREADY_REVOKED',
      'Revoked SCIM tokens cannot be rotated'
    );
  }

  const row = await requireToken(db, tenantId, newTokenId);
  return {
    ok: true,
    token: plaintext,
    scimToken: toTokenRow(row),
    revokedTokenId: tokenId,
    notice:
      'SCIM トークンをローテーションしました。旧トークンは即時失効し、新しい平文トークンはこの画面でのみ表示されます。',
  };
}

export async function revokeAdminScimToken(input: {
  db: D1Database;
  tenantId: string;
  actor: AuthUser;
  tokenId: string;
}): Promise<AdminScimTokenMutationResult> {
  const { db, tenantId, actor, tokenId } = input;
  const existing = await requireToken(db, tenantId, tokenId);

  if (existing.revoked_at) {
    return {
      ok: true,
      scimToken: toTokenRow(existing),
      alreadyRevoked: true,
      notice: 'この SCIM トークンは既に失効しています。',
    };
  }

  const nowIso = new Date().toISOString();
  const revokedGuard = {
    sql: 'EXISTS (SELECT 1 FROM scim_tokens WHERE id = ? AND tenant_id = ? AND revoked_at = ?)',
    bindings: [tokenId, tenantId, nowIso],
  } as const;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE scim_tokens
            SET revoked_at = ?
          WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`
      )
      .bind(nowIso, tenantId, tokenId),
    buildAuditLogStmt(
      db,
      {
        tenantId,
        actorId: actor.id,
        actorEmail: actor.email,
        actorIp: actor.ipAddress,
        action: 'admin.scim_token.revoke',
        targetType: 'scim_token',
        targetId: tokenId,
        metadata: {
          scimTokenId: tokenId,
          name: existing.name,
          idpIssuer: existing.idp_issuer,
        },
        nowIso,
      },
      revokedGuard
    ),
  ]);

  const row = await requireToken(db, tenantId, tokenId);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return {
      ok: true,
      scimToken: toTokenRow(row),
      alreadyRevoked: true,
      notice: 'この SCIM トークンは既に失効しています。',
    };
  }

  return {
    ok: true,
    scimToken: toTokenRow(row),
    notice: 'SCIM トークンを失効させました。',
  };
}
