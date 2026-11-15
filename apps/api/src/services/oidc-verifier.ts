import { base64UrlToBytes } from './crypto-utils';
import type {
  IdpProviderConfig,
  NormalizedOidcClaims,
  OidcEnv,
} from '../types/oidc';
import type { UserRole } from '../types/api';

interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  nonce?: string;
  oid?: string;
  tid?: string;
  email?: string;
  email_verified?: boolean;
  preferred_username?: string;
  upn?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  department?: string;
  groups?: string[];
  roles?: string[];
  /** Entra ID のグループ超過（overage）時に groups の代わりに付与される */
  _claim_names?: Record<string, string>;
}

interface JwkKey extends JsonWebKey {
  kid?: string;
  use?: string;
  alg?: string;
}

export interface OidcDiscoveryDocument {
  jwks_uri?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  end_session_endpoint?: string;
}

interface CachedCryptoKeyEntry {
  cryptoKey: CryptoKey;
  alg: string;
  expiresAtMs: number;
}

const memoryKeyCache = new Map<string, CachedCryptoKeyEntry>();
const lastJwksRefreshMap = new Map<string, number>();

const MEMORY_CACHE_TTL_MS = 15 * 60 * 1000;
const EDGE_CACHE_TTL_SEC = 3600;
const REFRESH_COOLDOWN_MS = 30 * 1000;
const CLOCK_SKEW_SEC = 60;

export class OidcVerificationError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'OidcVerificationError';
  }
}

export function clearOidcKeyCacheForTests(): void {
  memoryKeyCache.clear();
  lastJwksRefreshMap.clear();
}

export function buildConfiguredIdpProviders(env: OidcEnv): IdpProviderConfig[] {
  const providers: IdpProviderConfig[] = [];

  if (env.OKTA_ISSUER && env.OKTA_CLIENT_ID) {
    providers.push({
      provider: 'okta',
      issuer: env.OKTA_ISSUER.replace(/\/$/, ''),
      audience: env.OKTA_CLIENT_ID,
    });
  }

  if (env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID) {
    providers.push({
      provider: 'entra_id',
      issuer: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0`,
      audience: env.ENTRA_CLIENT_ID,
      jwksUri: `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/discovery/v2.0/keys`,
      expectedEntraTenantId: env.ENTRA_TENANT_ID,
    });
  }

  return providers;
}

export async function verifyOidcIdToken(
  token: string,
  env: OidcEnv,
  expectedNonce: string
): Promise<NormalizedOidcClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new OidcVerificationError('MALFORMED_JWT', 'JWT形式が不正です。');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = decodeJsonSegment<JwtHeader>(headerB64, 'HEADER');
  const payload = decodeJsonSegment<JwtPayload>(payloadB64, 'PAYLOAD');

  if (!header.kid) {
    throw new OidcVerificationError('MISSING_KID', 'JWTヘッダに kid が含まれていません。');
  }
  if (header.alg !== 'RS256' && header.alg !== 'ES256') {
    throw new OidcVerificationError('UNSUPPORTED_ALG', `未対応アルゴリズム: ${header.alg}`);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SEC < nowSec) {
    throw new OidcVerificationError('TOKEN_EXPIRED', 'IDトークンの有効期限が切れています。');
  }
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SEC > nowSec) {
    throw new OidcVerificationError('TOKEN_NOT_YET_VALID', 'IDトークンはまだ有効ではありません。');
  }
  if (!expectedNonce || payload.nonce !== expectedNonce) {
    throw new OidcVerificationError('INVALID_NONCE', 'nonce が一致しません（リプレイ攻撃の可能性）。');
  }

  const providers = buildConfiguredIdpProviders(env);
  const normalizedTokenIssuer = (payload.iss ?? '').replace(/\/$/, '');
  const matchedProvider = providers.find(
    (p) => p.issuer.replace(/\/$/, '') === normalizedTokenIssuer
  );

  if (!matchedProvider) {
    throw new OidcVerificationError('UNTRUSTED_ISSUER', `許可されていないIssuer: ${payload.iss ?? ''}`);
  }

  const audiences = Array.isArray(payload.aud)
    ? payload.aud
    : payload.aud
      ? [payload.aud]
      : [];
  if (!audiences.includes(matchedProvider.audience)) {
    throw new OidcVerificationError('INVALID_AUDIENCE', 'IDトークンの aud が一致しません。');
  }

  if (
    matchedProvider.provider === 'entra_id' &&
    matchedProvider.expectedEntraTenantId &&
    payload.tid !== matchedProvider.expectedEntraTenantId
  ) {
    throw new OidcVerificationError('INVALID_ENTRA_TENANT', 'Entra ID の tid が一致しません。');
  }

  const cryptoKey = await resolveVerificationKey(matchedProvider, header.kid, header.alg);
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = base64UrlToBytes(signatureB64);

  const isValid = await crypto.subtle.verify(
    header.alg === 'RS256'
      ? { name: 'RSASSA-PKCS1-v1_5' }
      : { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    signatureBytes,
    signingInput
  );

  if (!isValid) {
    throw new OidcVerificationError('INVALID_SIGNATURE', 'IDトークンの署名検証に失敗しました。');
  }

  return normalizeClaims(matchedProvider, payload, env);
}

async function resolveVerificationKey(
  provider: IdpProviderConfig,
  kid: string,
  alg: 'RS256' | 'ES256'
): Promise<CryptoKey> {
  const cacheKey = `${provider.issuer}::${kid}::${alg}`;
  const now = Date.now();

  const memHit = memoryKeyCache.get(cacheKey);
  if (memHit && memHit.expiresAtMs > now) {
    return memHit.cryptoKey;
  }

  let jwks = await fetchJwksKeys(provider, false);
  let matchedJwk = findMatchingJwk(jwks, kid, alg);

  if (!matchedJwk) {
    const lastRefresh = lastJwksRefreshMap.get(provider.issuer) ?? 0;
    if (now - lastRefresh > REFRESH_COOLDOWN_MS) {
      lastJwksRefreshMap.set(provider.issuer, now);
      jwks = await fetchJwksKeys(provider, true);
      matchedJwk = findMatchingJwk(jwks, kid, alg);
    }
  }

  if (!matchedJwk) {
    throw new OidcVerificationError('KEY_NOT_FOUND', `公開鍵 kid=${kid} が見つかりません。`);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    matchedJwk,
    alg === 'RS256'
      ? { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }
      : { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );

  memoryKeyCache.set(cacheKey, {
    cryptoKey,
    alg,
    expiresAtMs: now + MEMORY_CACHE_TTL_MS,
  });

  return cryptoKey;
}

function findMatchingJwk(jwks: JwkKey[], kid: string, alg: 'RS256' | 'ES256'): JwkKey | undefined {
  return jwks.find(
    (k) =>
      k.kid === kid &&
      (k.use === 'sig' || !k.use) &&
      (!k.alg || k.alg === alg)
  );
}

async function fetchJwksKeys(
  provider: IdpProviderConfig,
  bypassCache: boolean
): Promise<JwkKey[]> {
  let jwksUri = provider.jwksUri;
  if (!jwksUri) {
    const discovery = await fetchOidcDiscovery(provider.issuer, bypassCache);
    if (!discovery.jwks_uri) {
      throw new OidcVerificationError('MISSING_JWKS_URI', 'Discoveryに jwks_uri がありません。');
    }
    jwksUri = discovery.jwks_uri;
  }

  const edgeCache = caches.default;
  const cacheReq = new Request(jwksUri, { method: 'GET' });

  if (!bypassCache) {
    const cachedRes = await edgeCache.match(cacheReq);
    if (cachedRes) {
      const body = (await cachedRes.json()) as { keys?: JwkKey[] };
      if (Array.isArray(body.keys)) return body.keys;
    }
  }

  const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new OidcVerificationError('JWKS_FETCH_FAILED', `JWKS取得失敗 (HTTP ${res.status})`);
  }

  const jwksPayload = (await res.json()) as { keys?: JwkKey[] };
  if (!Array.isArray(jwksPayload.keys)) {
    throw new OidcVerificationError('INVALID_JWKS', 'JWKSに keys 配列がありません。');
  }

  await edgeCache.put(
    cacheReq,
    new Response(JSON.stringify(jwksPayload), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${EDGE_CACHE_TTL_SEC}`,
      },
    })
  );

  return jwksPayload.keys;
}

export async function fetchOidcDiscovery(
  issuer: string,
  bypassCache = false
): Promise<OidcDiscoveryDocument> {
  const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const edgeCache = caches.default;
  const cacheReq = new Request(discoveryUrl, { method: 'GET' });

  if (!bypassCache) {
    const cached = await edgeCache.match(cacheReq);
    if (cached) {
      return (await cached.json()) as OidcDiscoveryDocument;
    }
  }

  const res = await fetch(discoveryUrl, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new OidcVerificationError('DISCOVERY_FAILED', `Discovery取得失敗 (HTTP ${res.status})`);
  }
  const doc = (await res.json()) as OidcDiscoveryDocument;

  await edgeCache.put(
    cacheReq,
    new Response(JSON.stringify(doc), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${EDGE_CACHE_TTL_SEC}`,
      },
    })
  );
  return doc;
}

function normalizeClaims(
  provider: IdpProviderConfig,
  payload: JwtPayload,
  env: OidcEnv
): NormalizedOidcClaims {
  // Entra ID の sub はアプリごとのペアワイズ値のため、ユーザー識別には oid のみを使用する
  const externalIdpId = provider.provider === 'entra_id' ? payload.oid : payload.sub;
  if (!externalIdpId) {
    throw new OidcVerificationError('MISSING_SUBJECT', 'sub / oid が含まれていません。');
  }

  const rawEmail = payload.email ?? payload.preferred_username ?? payload.upn;
  if (!rawEmail || !rawEmail.includes('@')) {
    throw new OidcVerificationError('MISSING_EMAIL', '有効なメールアドレスが含まれていません。');
  }

  const email = rawEmail.trim().toLowerCase();
  // Okta は email_verified を返す。Entra ID の email / preferred_username は所有検証を保証しないため
  // アカウント紐付けには使用しない（nOAuth 型のなりすまし対策）
  const emailVerified = provider.provider === 'okta' && payload.email_verified === true;

  const displayName =
    payload.name?.trim() ||
    [payload.given_name, payload.family_name].filter(Boolean).join(' ').trim() ||
    email.split('@')[0];

  const groups = Array.isArray(payload.groups)
    ? payload.groups.filter((g): g is string => typeof g === 'string')
    : [];
  const appRoles = Array.isArray(payload.roles)
    ? payload.roles.filter((r): r is string => typeof r === 'string')
    : [];

  return {
    provider: provider.provider,
    issuer: provider.issuer,
    externalIdpId,
    email,
    emailVerified,
    displayName,
    department: payload.department?.trim() || null,
    groups,
    resolvedRole: resolveRoleFromClaims(payload, groups, appRoles, env),
  };
}

function parseList(value?: string): Set<string> {
  return new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

function resolveRoleFromClaims(
  payload: JwtPayload,
  groups: string[],
  appRoles: string[],
  env: OidcEnv
): UserRole | undefined {
  const adminGroups = parseList(env.ADMIN_GROUPS);
  const secAdminGroups = parseList(env.SEC_ADMIN_GROUPS);

  // ロールマッピング未設定の場合は D1 上のロール管理を正とする
  if (adminGroups.size === 0 && secAdminGroups.size === 0) return undefined;

  const memberships = [...groups, ...appRoles];
  if (memberships.some((g) => adminGroups.has(g))) return 'sys_admin';
  if (memberships.some((g) => secAdminGroups.has(g))) return 'sec_admin';

  // Entra ID のグループ超過（既定 200 件超）時は groups が省略されるため判定不能 → 既存ロール維持（SCIM 同期を正とする）
  if (payload._claim_names?.groups) return undefined;

  // groups / roles クレームが存在し、どの管理者グループにも属さない場合は member へ降格する
  if (Array.isArray(payload.groups) || Array.isArray(payload.roles)) return 'member';

  return undefined;
}

function decodeJsonSegment<T>(segmentB64Url: string, label: string): T {
  try {
    const bytes = base64UrlToBytes(segmentB64Url);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw new OidcVerificationError(`INVALID_${label}`, `JWT ${label} デコード失敗`);
  }
}
