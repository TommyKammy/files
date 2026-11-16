import type { ResourceRole } from '../types/api';
import type { OidcEnv } from '../types/oidc';
import {
  decryptCookiePayload,
  encryptCookiePayload,
  sha256Hex,
} from './crypto-utils';

const DEFAULT_WOPI_TOKEN_TTL_SECONDS = 60 * 60;
const LOCAL_WOPI_TOKEN_SECRET = 'dev-wopi-token-secret-change-in-prod';

export interface WopiTokenPayload {
  typ: 'wopi';
  sid: string;
  fileId: string;
  tenantId: string;
  userId: string;
  role: ResourceRole;
  canWrite: boolean;
  exp: number;
}

export interface WopiSessionRow {
  id: string;
  tenant_id: string;
  file_id: string;
  user_id: string;
  role: ResourceRole;
  can_write: number;
  access_token_hash: string;
  is_active: number;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

export function getWopiTokenSecret(
  env: Pick<OidcEnv, 'WOPI_TOKEN_SECRET' | 'OIDC_STATE_COOKIE_KEY' | 'ENVIRONMENT'>
): string {
  const configured = env.WOPI_TOKEN_SECRET?.trim();
  if (configured) return configured;
  const fallback = env.OIDC_STATE_COOKIE_KEY?.trim();
  if (fallback) return fallback;
  if (env.ENVIRONMENT === 'local' || !env.ENVIRONMENT) {
    return LOCAL_WOPI_TOKEN_SECRET;
  }
  throw new Error('WOPI_TOKEN_SECRET must be configured outside local environment');
}

export async function issueWopiSessionToken(
  env: Pick<OidcEnv, 'WOPI_TOKEN_SECRET' | 'OIDC_STATE_COOKIE_KEY' | 'ENVIRONMENT'>,
  input: {
    sessionId: string;
    fileId: string;
    tenantId: string;
    userId: string;
    role: ResourceRole;
    canWrite: boolean;
    ttlSeconds?: number;
  }
): Promise<{
  token: string;
  tokenHash: string;
  expiresAt: string;
  payload: WopiTokenPayload;
}> {
  const ttlSeconds =
    typeof input.ttlSeconds === 'number' && Number.isFinite(input.ttlSeconds)
      ? Math.max(60, Math.min(Math.floor(input.ttlSeconds), 8 * 60 * 60))
      : DEFAULT_WOPI_TOKEN_TTL_SECONDS;
  const exp = Date.now() + ttlSeconds * 1000;
  const payload: WopiTokenPayload = {
    typ: 'wopi',
    sid: input.sessionId,
    fileId: input.fileId,
    tenantId: input.tenantId,
    userId: input.userId,
    role: input.role,
    canWrite: input.canWrite,
    exp,
  };
  const token = await encryptCookiePayload(getWopiTokenSecret(env), payload);
  return {
    token,
    tokenHash: await sha256Hex(token),
    expiresAt: new Date(exp).toISOString(),
    payload,
  };
}

export async function verifyWopiSessionToken(
  db: D1Database,
  env: Pick<OidcEnv, 'WOPI_TOKEN_SECRET' | 'OIDC_STATE_COOKIE_KEY' | 'ENVIRONMENT'>,
  token: string | null | undefined
): Promise<{ payload: WopiTokenPayload; session: WopiSessionRow } | null> {
  if (!token || token.length > 4096) return null;
  let payload: WopiTokenPayload | null = null;
  try {
    payload = await decryptCookiePayload<WopiTokenPayload>(
      getWopiTokenSecret(env),
      token
    );
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.typ !== 'wopi' ||
    typeof payload.sid !== 'string' ||
    typeof payload.fileId !== 'string' ||
    typeof payload.tenantId !== 'string' ||
    typeof payload.userId !== 'string' ||
    typeof payload.exp !== 'number' ||
    payload.exp <= Date.now()
  ) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const session = await db
    .prepare(
      `SELECT * FROM wopi_sessions
        WHERE id = ? AND tenant_id = ? AND file_id = ? AND user_id = ?
          AND is_active = 1 AND revoked_at IS NULL AND expires_at > ?
        LIMIT 1`
    )
    .bind(payload.sid, payload.tenantId, payload.fileId, payload.userId, nowIso)
    .first<WopiSessionRow>();
  if (!session) return null;
  return { payload, session };
}
